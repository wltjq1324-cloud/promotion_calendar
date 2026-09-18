// 박스 실재고(근사치) 계산 — 아워박스 OpenAPI 기반
// ------------------------------------------------------------------
// 무엇을 하나
//   수불표의 박스 재고수량은 "마지막 실사 잔고"이고 실사 사이에는 움직이지 않는다
//   (박스는 출고 건별 차감이 없고 실사 때만 조정된다). 그래서 매일:
//     실재고 ≈ 마지막 실사 잔고 + 이후 입고 − 이후 출고 박스 × factor
//   를 계산해 box-stock-latest.json 으로 남기고 /inven 페이지가 읽는다.
//
// 아워박스 API 사용 (모두 POST, 헤더 api_access_key / api_secret_key)
//   /api/wms/stock/stock_adj_hist   재고 조정 이력 → 품목별 최신 실사(af_qty, reg_dtm)
//   /api/wms/put/put_perf           입고실적(입고완료일, 7일 창) → 실사 이후 입고
//   /api/oms/info/product_stock     재고 조회 → 장부재고 대조(기대값 = 실사잔고 + 입고)
//   /api/wms/out/out_perf_period    출고실적(출고완료일, 일별) → 송장 1건 = 박스 1개
//
// 박스 종류 판정: 공개 API에는 포장박스 열이 없다(oms 화면 전용). 송장의 내용물 서명
//   (업체품목코드×수량, 정렬 결합)을 box-lookup.json 에서 찾고, 없으면 총수량 규칙으로
//   폴백한다. 판정 방식 비율(coverage)을 결과에 남긴다.
//
// 실행: OURBOX_API_ACCESS_KEY / OURBOX_API_SECRET_KEY 환경변수 필요.
//   node scripts/box-stock.mjs            (GitHub Actions update-box-stock, 매일 08:00 KST)
// 순수 함수는 export 되어 scripts/box-stock.test.js 가 검증한다.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const OURBOX = 'https://api.ourbox.co.kr';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'box-stock-config.json');
const LOOKUP_PATH = path.join(ROOT, 'box-lookup.json');
const DAILY_PATH = path.join(ROOT, 'box-daily.json');
const OUT_PATH = path.join(ROOT, 'box-stock-latest.json');

const BOX_KEYS = ['b1', 'b2', 'b3', 'b4', 'gift', 'paper', 'plain', 'other'];

// ───────────────────────── 날짜 유틸 (KST 기준 문자열) ─────────────────────────
export function kstNow() {
  const s = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date());
  return s.replace('T', ' '); // 'YYYY-MM-DD HH:mm:ss'
}
export function kstToday() { return kstNow().slice(0, 10); }
export function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function dateList(from, to) {
  const out = [];
  if (!from || !to || from > to) return out;
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
// 일요일 시작 주의 시작일
export function weekStartOf(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  return addDays(ymd, -d.getUTCDay());
}
const text = (v) => String(v ?? '').trim();
const toInt = (v) => {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

// ───────────────────────── 박스 판정 ─────────────────────────
// 송장 라인들 → 서명. 같은 품목코드는 수량을 합친다 (로트 분할 행 대비).
export function signatureOf(lines, codeKey = 'code') {
  const agg = new Map();
  for (const l of lines) {
    const c = text(l[codeKey]);
    if (!c) continue;
    agg.set(c, (agg.get(c) || 0) + toInt(l.qty));
  }
  return [...agg.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([c, q]) => `${c}x${q}`).join('|');
}

// 룩업 → 총수량 폴백 → unknown
export function classifyInvoice(lines, lookup) {
  const total = lines.reduce((s, l) => s + toInt(l.qty), 0);
  const sigC = signatureOf(lines, 'code');
  const ov = lookup.overrides && lookup.overrides[sigC];
  if (ov) return { box: ov, method: 'lookup', sig: sigC, total };
  const hitC = lookup.byCompany && lookup.byCompany[sigC];
  if (hitC) return { box: hitC[0], method: 'lookup', sig: sigC, total };
  const sigP = signatureOf(lines, 'productCode');
  const hitP = sigP && lookup.byProduct && lookup.byProduct[sigP];
  if (hitP) return { box: hitP[0], method: 'lookup', sig: sigP, total };
  const fb = lookup.byTotalQty && lookup.byTotalQty[String(total)];
  if (fb) return { box: fb[0], method: 'qty', sig: sigC, total };
  return { box: 'unknown', method: 'unknown', sig: sigC, total };
}

export function emptyDay(date) {
  const d = { date, invoices: 0, lines: 0, noInvoiceGroups: 0, noInvoiceQty: 0,
    unknown: 0, byLookup: 0, byQty: 0, unknownSigs: [] };
  for (const k of BOX_KEYS) d[k] = 0;
  return d;
}

// 출고실적 한 날짜 → 일별 집계. afterDtm 이 있으면 out_complete_dt > afterDtm 인 송장만 센다(실사 당일 처리).
export function aggregateDay(date, datas, lookup, afterDtm = '') {
  const day = emptyDay(date);
  const byInvoice = new Map();
  const noInvoice = new Map();
  for (const r of Array.isArray(datas) ? datas : []) {
    day.lines += 1;
    const line = {
      code: text(r.product_company_code), productCode: text(r.product_code),
      qty: toInt(r.out_qty), dtm: text(r.out_complete_dt || r.out_dt),
    };
    const inv = text(r.invoice);
    if (!inv) {
      const g = text(r.out_data_sno || r.out_sno || r.od_sno) || `line${day.lines}`;
      if (!noInvoice.has(g)) noInvoice.set(g, 0);
      noInvoice.set(g, noInvoice.get(g) + line.qty);
      continue;
    }
    // 송장 열이 콤마로 여러 개 올 수 있다(out_perf). 첫 송장으로 묶는다.
    const key = inv.split(',')[0].trim();
    if (!byInvoice.has(key)) byInvoice.set(key, []);
    byInvoice.get(key).push(line);
  }
  const unknownSigs = new Map();
  for (const [, lines] of byInvoice) {
    if (afterDtm) {
      const last = lines.map((l) => l.dtm).filter(Boolean).sort().at(-1) || '';
      if (last && last <= afterDtm) continue;
    }
    const c = classifyInvoice(lines, lookup);
    day.invoices += 1;
    if (c.method === 'lookup') day.byLookup += 1;
    else if (c.method === 'qty') day.byQty += 1;
    if (c.box === 'unknown') {
      day.unknown += 1;
      unknownSigs.set(c.sig, (unknownSigs.get(c.sig) || 0) + 1);
    } else if (BOX_KEYS.includes(c.box)) day[c.box] += 1;
    else day.other += 1;
  }
  day.noInvoiceGroups = noInvoice.size;
  day.noInvoiceQty = [...noInvoice.values()].reduce((s, q) => s + q, 0);
  day.unknownSigs = [...unknownSigs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([sig, n]) => `${sig} ×${n}`);
  return day;
}

// 재고 조정 이력 → 품목별 최신 실사 {dtm, date, afQty, adjQty}
export function latestAdjustments(rows, items) {
  const out = {};
  for (const it of items) {
    const codes = new Set([it.companyCode, it.productCode].filter(Boolean).map(text));
    const mine = (Array.isArray(rows) ? rows : []).filter((r) =>
      codes.has(text(r.item_cd)) || codes.has(text(r.prod_cd)));
    if (!mine.length) continue;
    mine.sort((a, b) => (text(a.reg_dtm) < text(b.reg_dtm) ? 1 : -1));
    const top = mine[0];
    const dtm = text(top.reg_dtm);
    // 같은 시각에 여러 셀/로트 조정이 있으면 af_qty 합, adj_qty 합
    const same = mine.filter((r) => text(r.reg_dtm).slice(0, 16) === dtm.slice(0, 16));
    out[it.key] = {
      dtm, date: dtm.slice(0, 10),
      afQty: same.reduce((s, r) => s + toInt(r.af_qty), 0),
      adjQty: same.reduce((s, r) => s + toInt(r.adj_qty), 0),
      reason: text(top.stock_adj_resn_nm), rows: same.length,
    };
  }
  return out;
}

// 입고실적 → 품목별 [{date, qty}] (afterDtm 이후만)
export function receiptsSince(rows, item, afterDtm) {
  const codes = new Set([item.companyCode, item.productCode].filter(Boolean).map(text));
  const list = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!codes.has(text(r.product_company_code)) && !codes.has(text(r.product_code))) continue;
    const dtm = text(r.input_complete_dt || r.input_dt);
    if (!dtm || (afterDtm && dtm <= afterDtm)) continue;
    list.push({ date: dtm.slice(0, 10), qty: toInt(r.input_qty), code: text(r.input_code) });
  }
  list.sort((a, b) => (a.date < b.date ? -1 : 1));
  return list;
}

// 일별 → 일~토 주간 (endDate 포함 최근 weeks 주, 부분 주 표시)
export function weeklyFromDaily(daysMap, endDate, weeks) {
  const out = [];
  let ws = weekStartOf(endDate);
  for (let i = 0; i < weeks; i++) {
    const w = { weekStart: ws, weekEnd: addDays(ws, 6), days: 0, invoices: 0, unknown: 0 };
    for (const k of BOX_KEYS) w[k] = 0;
    for (const d of dateList(ws, addDays(ws, 6))) {
      const rec = daysMap[d];
      if (!rec) continue;
      w.days += 1; w.invoices += rec.invoices; w.unknown += rec.unknown;
      for (const k of BOX_KEYS) w[k] += rec[k] || 0;
    }
    w.partial = w.days < 7;
    out.unshift(w);
    ws = addDays(ws, -7);
  }
  return out;
}

// 발주 제안: 목표 = 주간사용량 × (리드타임+검토주기)/7 × (1+안전재고율)
export function orderSuggestion({ weekAvg, est, bundle, leadTimeDays, reviewDays, safetyRate }) {
  const target = weekAvg * ((leadTimeDays + reviewDays) / 7) * (1 + safetyRate);
  const need = Math.max(0, target - est);
  const orderQty = bundle > 0 ? Math.ceil(need / bundle) * bundle : Math.ceil(need);
  const daysCover = weekAvg > 0 ? (est / (weekAvg / 7)) : null;
  return { target: Math.round(target), orderQty, daysCover: daysCover == null ? null : Math.round(daysCover * 10) / 10 };
}

// 품목 하나의 실재고 계산 (anchor 이후 일별 사용량은 daysMap 에서, 실사 당일은 anchorDayUsage 로 따로)
export function computeItem({ item, anchor, receipts, daysMap, anchorDayUsage, today, apiStock, cfg, weekly }) {
  const since = anchor.date;
  let boxes = anchorDayUsage || 0;
  let unknownShare = 0, unknownTotal = 0, invTotal = 0;
  for (const d of dateList(addDays(since, 1), today)) {
    const rec = daysMap[d];
    if (!rec) continue;
    boxes += rec[item.key] || 0;
    unknownTotal += rec.unknown; invTotal += rec.invoices;
  }
  if (invTotal) unknownShare = Math.round((unknownTotal / invTotal) * 1000) / 10;
  const inQty = receipts.reduce((s, r) => s + r.qty, 0);
  const adjusted = Math.round(boxes * item.factor);
  const warnings = [];
  // 실사 후 잔고: 조정 이력의 af_qty 는 셀 단위 값이라 품목 합계가 아니다(실측: 수불표와 불일치).
  // 장부재고는 실사 사이에 움직이지 않으므로 "장부재고 − 실사 이후 입고" 가 실사 후 잔고와 정확히 같다.
  let anchorQty = anchor.afQty;
  let anchorSource = anchor.source;
  if (apiStock && Number.isFinite(apiStock.total) && anchor.source === 'adjustment') {
    anchorQty = apiStock.total - inQty;
    anchorSource = 'ledger_identity';
    if (Math.abs(anchor.afQty - anchorQty) > Math.max(5, anchorQty * 0.02)) {
      warnings.push(`조정 이력 af_qty 합 ${anchor.afQty.toLocaleString('ko-KR')} ≠ 장부 역산 ${anchorQty.toLocaleString('ko-KR')} — 장부 역산 값을 사용`);
    }
  }
  const rawEst = anchorQty + inQty - adjusted;
  let est = rawEst;
  let substituted = 0;
  if (rawEst < 0) {
    // 있는 것보다 더 쓸 수는 없다. 초과분은 다른 박스로 대체 포장한 것으로 본다(3호↔4호 실측).
    substituted = -rawEst;
    est = 0;
    warnings.push(`출고 박스가 재고를 ${substituted.toLocaleString('ko-KR')} 초과 — 다른 호수로 대체 포장한 것으로 추정. 실물 확인 필요`);
  }
  const full = weekly.filter((w) => !w.partial);
  const lastN = full.slice(-cfg.avgWeeks);
  const weekAvg = lastN.length
    ? Math.round((lastN.reduce((s, w) => s + (w[item.key] || 0), 0) / lastN.length) * item.factor)
    : 0;
  const weekMax8 = full.length ? Math.max(...full.map((w) => (w[item.key] || 0))) : 0;
  const sug = orderSuggestion({ weekAvg, est, bundle: item.bundle,
    leadTimeDays: cfg.leadTimeDays, reviewDays: cfg.reviewDays, safetyRate: cfg.safetyRate });
  const expected = anchorQty + inQty;
  if (anchor.source !== 'adjustment') warnings.push('최근 실사 조정 이력이 없어 API 장부재고를 기준점으로 삼았습니다.');
  if (est <= 0 && !substituted) warnings.push('추정 실재고가 0 이하입니다. 실물 확인이 필요합니다.');
  if (unknownShare >= 15) warnings.push(`박스 종류 미판정 송장 ${unknownShare}% — box-lookup 갱신 필요`);
  return {
    key: item.key, label: item.label, name: item.name, companyCode: item.companyCode,
    productCode: item.productCode, bundle: item.bundle, factor: item.factor,
    count: { date: anchor.date, dtm: anchor.dtm, qty: anchorQty, afQtyRaw: anchor.afQty, adjQty: anchor.adjQty, source: anchorSource },
    receipts: { qty: inQty, list: receipts },
    usage: { boxes, adjusted, since, unknownShare, substituted },
    est, rawEst, apiStock: apiStock ? { ...apiStock, expected, diff: apiStock.total - expected } : null,
    weekAvg, weekMax8, ...sug, warnings,
  };
}

// ───────────────────────── API ─────────────────────────
function keys() {
  const access = text(process.env.OURBOX_API_ACCESS_KEY);
  const secret = text(process.env.OURBOX_API_SECRET_KEY);
  if (!access || !secret) throw new Error('OURBOX_API_ACCESS_KEY / OURBOX_API_SECRET_KEY 환경변수가 필요합니다.');
  return { access, secret };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let CALLS = 0;

async function post(pathname, body, k) {
  CALLS += 1;
  const res = await fetch(OURBOX + pathname, {
    method: 'POST',
    headers: { api_access_key: k.access, api_secret_key: k.secret, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`${pathname} HTTP ${res.status}: ${raw.slice(0, 160)}`);
  let json;
  try { json = JSON.parse(raw); } catch { throw new Error(`${pathname} 응답이 JSON이 아닙니다: ${raw.slice(0, 120)}`); }
  if (json.result !== true && String(json.result) !== 'true') {
    throw new Error(`${pathname} 실패(code ${json.code || '?'}): ${json.message || raw.slice(0, 120)}`);
  }
  return json;
}

// 페이지 끝까지 (total_page / ctotal_page 둘 다 인식)
async function fetchPages(pathname, body, listKey, k, cfg, maxPages = 100) {
  const rows = [];
  let page = 1, total = 1;
  do {
    const json = await post(pathname, { ...body, page }, k);
    for (const r of json[listKey] || []) rows.push(r);
    total = Number(json.total_page || json.ctotal_page || 1);
    page += 1;
    if (page <= total) await sleep(cfg.requestSleepMs);
  } while (page <= total && page <= maxPages);
  return rows;
}

// ───────────────────────── 메인 ─────────────────────────
export async function main() {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const lookup = JSON.parse(readFileSync(LOOKUP_PATH, 'utf8'));
  lookup.overrides = cfg.lookupOverrides || {};
  const dailyStore = existsSync(DAILY_PATH) ? JSON.parse(readFileSync(DAILY_PATH, 'utf8')) : { version: 1, days: {} };
  const prev = existsSync(OUT_PATH) ? JSON.parse(readFileSync(OUT_PATH, 'utf8')) : {};
  const k = keys();
  const today = kstToday();
  const now = kstNow();
  const warnings = [];
  const t0 = Date.now();

  // 1) 장부재고 (품목코드 확인 겸)
  const stockRows = await fetchPages('/api/oms/info/product_stock',
    { sales_product_codes: [], sales_product_company_codes: cfg.items.map((i) => i.companyCode) },
    'product_stock_info', k, cfg, 5);
  const apiStock = {};
  for (const it of cfg.items) {
    const mine = stockRows.filter((r) => text(r.sales_product_company_code) === it.companyCode);
    if (!mine.length) { warnings.push(`${it.label}: product_stock 응답에 ${it.companyCode} 없음`); continue; }
    if (text(mine[0].sales_product_code)) it.productCode = text(mine[0].sales_product_code);
    apiStock[it.key] = {
      total: mine.reduce((s, r) => s + toInt(r.total_stock), 0),
      available: mine.reduce((s, r) => s + toInt(r.available_stock), 0),
      unavailable: mine.reduce((s, r) => s + toInt(r.unavailable_stock), 0),
    };
  }

  // 2) 최신 실사 (재고 조정 이력, 30일 창으로 lookback 만큼)
  let adjRows = [];
  for (let end = today; end > addDays(today, -cfg.adjLookbackDays); end = addDays(end, -cfg.adjWindowDays)) {
    const start = addDays(end, -(cfg.adjWindowDays - 1));
    adjRows = adjRows.concat(await fetchPages('/api/wms/stock/stock_adj_hist',
      { input_type: '2', start_reg_dt: start, end_reg_dt: end }, 'adjust', k, cfg, 20));
    await sleep(cfg.requestSleepMs);
  }
  const latest = latestAdjustments(adjRows, cfg.items);
  const anchors = {};
  for (const it of cfg.items) {
    if (latest[it.key]) anchors[it.key] = { ...latest[it.key], source: 'adjustment' };
    else {
      const p = (prev.items || []).find((x) => x.key === it.key);
      if (p && p.count && p.count.date) {
        anchors[it.key] = { date: p.count.date, dtm: p.count.dtm, afQty: p.count.qty, adjQty: p.count.adjQty || 0, source: p.count.source || 'previous' };
      } else {
        const s = apiStock[it.key];
        anchors[it.key] = { date: today, dtm: now, afQty: s ? s.total : 0, adjQty: 0, source: 'api_stock' };
        warnings.push(`${it.label}: ${cfg.adjLookbackDays}일 내 실사 조정 이력 없음 → 오늘 장부재고를 기준점으로 사용`);
      }
    }
  }
  const earliest = Object.values(anchors).map((a) => a.date).sort()[0] || today;

  // 3) 입고실적 (입고완료일, 7일 창) — 가장 이른 실사일부터
  let putRows = [];
  for (const it of cfg.items) {
    for (let s = addDays(anchors[it.key].date, 0); s <= today; s = addDays(s, cfg.putWindowDays)) {
      const e = addDays(s, cfg.putWindowDays - 1) > today ? today : addDays(s, cfg.putWindowDays - 1);
      putRows = putRows.concat(await fetchPages('/api/wms/put/put_perf',
        { input_dt_type: '3', input_dt_from: s, input_dt_to: e, product_code_type: '2', product_code: it.companyCode },
        'datas', k, cfg, 10));
      await sleep(cfg.requestSleepMs);
    }
  }

  // 4) 출고실적 일별 (증분: 저장된 날은 건너뛰고 최근 N일은 다시 받는다)
  const fetchFrom = addDays(earliest, 0);
  const refetchFrom = addDays(today, -cfg.refetchRecentDays);
  const rawByDate = {}; // 실사 당일 시간 필터용 원본 보관
  let fetchedDays = 0;
  for (const d of dateList(fetchFrom, today)) {
    const cached = dailyStore.days[d];
    const isAnchorDay = Object.values(anchors).some((a) => a.date === d);
    if (cached && d < refetchFrom && !isAnchorDay) continue;
    const datas = await fetchPages('/api/wms/out/out_perf_period',
      { out_dt_type: '2', out_dt_from: d, out_dt_to: d }, 'datas', k, cfg, cfg.maxPagesPerDay);
    const rec = aggregateDay(d, datas, lookup);
    rec.fetchedAt = now;
    dailyStore.days[d] = rec;
    if (isAnchorDay) rawByDate[d] = datas;
    fetchedDays += 1;
    await sleep(cfg.requestSleepMs);
  }
  // 오래된 날 정리
  for (const d of Object.keys(dailyStore.days)) if (d < addDays(today, -cfg.dailyKeepDays)) delete dailyStore.days[d];

  // 5) 집계
  const weekly = weeklyFromDaily(dailyStore.days, today, cfg.outputWeeks);
  const items = cfg.items.map((it) => {
    const a = anchors[it.key];
    const anchorDay = rawByDate[a.date]
      ? aggregateDay(a.date, rawByDate[a.date], lookup, a.dtm)[it.key] || 0
      : 0;
    return computeItem({
      item: it, anchor: a, receipts: receiptsSince(putRows, it, a.dtm), daysMap: dailyStore.days,
      anchorDayUsage: anchorDay, today, apiStock: apiStock[it.key] || null, cfg, weekly,
    });
  });
  const dailyOut = dateList(addDays(today, -(cfg.outputDailyDays - 1)), today)
    .map((d) => dailyStore.days[d] || emptyDay(d));
  const win = dailyOut.filter((d) => d.invoices);
  const invSum = win.reduce((s, d) => s + d.invoices, 0) || 1;
  const coverage = {
    lookup: Math.round(win.reduce((s, d) => s + d.byLookup, 0) / invSum * 1000) / 10,
    qty: Math.round(win.reduce((s, d) => s + d.byQty, 0) / invSum * 1000) / 10,
    unknown: Math.round(win.reduce((s, d) => s + d.unknown, 0) / invSum * 1000) / 10,
    unknownSigs: [...new Set(win.flatMap((d) => d.unknownSigs || []))].slice(0, 10),
  };
  const out = {
    status: 'ok', generated_at: now, source: 'ourbox-openapi',
    api_calls: CALLS, fetched_days: fetchedDays, elapsed_ms: Date.now() - t0,
    config: { leadTimeDays: cfg.leadTimeDays, reviewDays: cfg.reviewDays, safetyRate: cfg.safetyRate, avgWeeks: cfg.avgWeeks },
    usageOnly: cfg.usageOnly || [],
    items, coverage, weekly, daily: dailyOut, warnings,
  };
  writeFileSync(DAILY_PATH, JSON.stringify(dailyStore), 'utf8');
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 1), 'utf8');
  console.log(`box-stock: ${items.map((i) => `${i.label}=${i.est}`).join(', ')} | API ${CALLS}회, 일별 ${fetchedDays}일 수집, ${out.elapsed_ms}ms`);
  for (const w of warnings) console.log('warn:', w);
  for (const it of items) for (const w of it.warnings) console.log(`warn[${it.label}]:`, w);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('box-stock 실패:', err.message);
    // 실패해도 이전 결과를 지우지 않는다. 상태만 남긴다.
    try {
      const prev = existsSync(OUT_PATH) ? JSON.parse(readFileSync(OUT_PATH, 'utf8')) : {};
      prev.last_error = { at: kstNow(), message: err.message };
      writeFileSync(OUT_PATH, JSON.stringify(prev, null, 1), 'utf8');
    } catch { /* ignore */ }
    process.exit(1);
  });
}
