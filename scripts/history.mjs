// 입출고 연간 누적 — 아워박스 OpenAPI 기반
// ------------------------------------------------------------------
// 무엇을 하나
//   상품(재고 상품코드)별 하루 입고·택배출고·대량출고를 연도별 파일에 계속 쌓는다.
//   화면용 파일(sku-daily.json 35일, box-daily.json 120일)은 오래된 날을 지우므로,
//   연간 기록은 여기(history/)에만 남는다.
//     history/inout-YYYY.json   기계용 원본 (날짜 → 입고/택배/대량 → 상품코드 → 수량)
//     history/inout-YYYY.csv    사람·구글 시트용 (한 줄 = 날짜×상품, 월은 '10월' 형태). 운영_DB 시트가 IMPORTDATA 로 읽는다.
//
// 기준 (/inven 과 같다)
//   입고     = put_perf 입고완료일(input_complete_dt), 상품코드별 합
//   택배출고 = out_perf_period 출고완료일, 송장 있는 행 + 송장 없는 '직택배' 채널(롯데홈쇼핑-직택배)
//   대량출고 = 송장 없는 나머지(밭(파머스베이크샵) 차량 출고 등)
//   키는 상품코드(업체품목코드는 같은 상품도 바뀐다: 고구마빵 3개입 G-O032/G-O151)
//
// 수집 범위
//   처음 실행 때 START(올해 1월 1일)부터 어제까지 비어 있는 날을 모두 받는다(1회, 수백 회 호출).
//   이후 매일 최근 REFETCH_DAYS 일만 다시 받는다(늦게 완료되는 송장·입고 반영).
//
// 실행: OURBOX_API_ACCESS_KEY / OURBOX_API_SECRET_KEY 필요. update-box-stock 워크플로가 box-stock 다음에 돌린다.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  aggregateDay, addDays, dateList, kstNow, kstToday, keys, fetchPages, apiCalls,
} from './box-stock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HIST_DIR = path.join(ROOT, 'history');
const START = '2026-01-01';
const REFETCH_DAYS = 3;          // 출고: 최근 며칠은 매일 다시 받는다
const RECEIPT_REFETCH_DAYS = 21; // 입고: 입고완료가 늦게 찍히는 경우가 있어 3주 다시 받는다
const CFG = { requestSleepMs: 200 };
const W = ['일', '월', '화', '수', '목', '금', '토'];

const text = (v) => String(v ?? '').trim();
const toInt = (v) => Math.round(Number(String(v ?? '').replace(/,/g, '')) || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function emptyYear(year) {
  return { version: 1, year, updated_at: '', products: {}, days: {}, outDone: {}, receiptsThrough: '' };
}

// out_perf_period 하루치 → {parcel, bulk} (상품코드별) + 상품 이름
export function outDay(date, datas, lookup) {
  const rec = aggregateDay(date, datas, lookup);
  const direct = rec.directParcel || {};
  const bulk = {};
  for (const e of rec.b2b || []) {
    const k = e.productCode || e.code;
    const q = e.qty - (direct[k] || 0);
    if (q > 0) bulk[k] = (bulk[k] || 0) + q;
  }
  return { parcel: { ...(rec.parcel || {}) }, bulk };
}

export function namesFrom(rows, products) {
  for (const r of Array.isArray(rows) ? rows : []) {
    const pc = text(r.product_code) || text(r.product_company_code);
    if (!pc) continue;
    const p = products[pc] || (products[pc] = { name: '', companyCode: '' });
    if (text(r.product_name)) p.name = text(r.product_name);
    if (text(r.product_company_code)) p.companyCode = text(r.product_company_code);
  }
}

// 입고실적 행 → {date: {상품코드: 수량}} (입고완료일 기준)
export function receiptsByDay(rows) {
  const out = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    const d = text(r.input_complete_dt || r.input_dt).slice(0, 10);
    const pc = text(r.product_code) || text(r.product_company_code);
    const q = toInt(r.input_qty);
    if (!d || !pc || !q) continue;
    const day = out[d] || (out[d] = {});
    day[pc] = (day[pc] || 0) + q;
  }
  return out;
}

// 연간 파일 → CSV (한 줄 = 날짜×상품, 값이 하나라도 있는 것만)
export function toCsv(hist) {
  const head = ['날짜', '월', '요일', '상품코드', '업체품목코드', '상품명', '입고', '택배출고', '대량출고'];
  const lines = [head.join(',')];
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  for (const d of Object.keys(hist.days).sort()) {
    const day = hist.days[d];
    const codes = new Set([...Object.keys(day.in || {}), ...Object.keys(day.parcel || {}), ...Object.keys(day.bulk || {})]);
    const rows = [...codes].map((pc) => {
      const p = hist.products[pc] || {};
      return [d, `${d.slice(5, 7)}월`, W[new Date(`${d}T00:00:00Z`).getUTCDay()], pc, p.companyCode || '', p.name || pc,
        (day.in || {})[pc] || 0, (day.parcel || {})[pc] || 0, (day.bulk || {})[pc] || 0];
    }).filter((r) => r[6] || r[7] || r[8]).sort((a, b) => String(a[5]).localeCompare(String(b[5]), 'ko'));
    for (const r of rows) lines.push(r.map(esc).join(','));
  }
  return lines.join('\n') + '\n';
}

function load(year) {
  const f = path.join(HIST_DIR, `inout-${year}.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : emptyYear(year);
}
function save(hist, now) {
  if (!existsSync(HIST_DIR)) mkdirSync(HIST_DIR, { recursive: true });
  const ds = Object.keys(hist.days).sort();
  const first = (kind) => ds.find((d) => Object.values(hist.days[d][kind] || {}).some((q) => q > 0)) || '';
  hist.updated_at = now;
  hist.earliest = { in: first('in'), parcel: first('parcel'), bulk: first('bulk') };
  writeFileSync(path.join(HIST_DIR, `inout-${hist.year}.json`), JSON.stringify(hist), 'utf8');
  writeFileSync(path.join(HIST_DIR, `inout-${hist.year}.csv`), toCsv(hist), 'utf8');
}

export async function main() {
  const k = keys();
  const now = kstNow();
  const today = kstToday();
  const yesterday = addDays(today, -1);
  const lookup = JSON.parse(readFileSync(path.join(ROOT, 'box-lookup.json'), 'utf8'));
  lookup.overrides = (JSON.parse(readFileSync(path.join(ROOT, 'box-stock-config.json'), 'utf8')).lookupOverrides) || {};
  const years = {};
  const yearOf = (d) => { const y = Number(d.slice(0, 4)); return years[y] || (years[y] = load(y)); };
  const dayOf = (d) => { const h = yearOf(d); return h.days[d] || (h.days[d] = { in: {}, parcel: {}, bulk: {} }); };

  // 1) 출고: 비어 있는 날 + 최근 REFETCH_DAYS 일
  const refetchFrom = addDays(today, -REFETCH_DAYS);
  let outFetched = 0;
  for (const d of dateList(START, yesterday)) {
    const h = yearOf(d);
    if (h.outDone[d] && d < refetchFrom) continue;
    const datas = await fetchPages('/api/wms/out/out_perf_period',
      { out_dt_type: '2', out_dt_from: d, out_dt_to: d }, 'datas', k, CFG, 80);
    namesFrom(datas, h.products);
    const o = outDay(d, datas, lookup);
    const day = dayOf(d);
    day.parcel = o.parcel; day.bulk = o.bulk;
    h.outDone[d] = now;
    outFetched += 1;
    if (outFetched % 30 === 0) { console.log(`출고 ${d}까지 (API ${apiCalls()}회)`); save(h, now); }
    await sleep(CFG.requestSleepMs);
  }

  // 2) 입고: 처음엔 START부터, 이후엔 최근 RECEIPT_REFETCH_DAYS 일 (7일 창)
  const hNow = yearOf(today);
  const rFrom = hNow.receiptsThrough ? addDays(hNow.receiptsThrough, -RECEIPT_REFETCH_DAYS) : START;
  const from = rFrom < START ? START : rFrom;
  let rows = [];
  for (let s = from; s <= today; s = addDays(s, 7)) {
    const e = addDays(s, 6) > today ? today : addDays(s, 6);
    rows = rows.concat(await fetchPages('/api/wms/put/put_perf',
      { input_dt_type: '3', input_dt_from: s, input_dt_to: e }, 'datas', k, CFG, 20));
    await sleep(CFG.requestSleepMs);
  }
  const byDay = receiptsByDay(rows);
  for (const y of new Set(dateList(from, today).map((d) => d.slice(0, 4)))) namesFrom(rows, yearOf(`${y}-01-01`).products);
  for (const d of dateList(from, today)) {
    const h = yearOf(d);
    if (byDay[d]) dayOf(d).in = byDay[d];
    else if (h.days[d]) h.days[d].in = {};
  }
  hNow.receiptsThrough = today;

  for (const h of Object.values(years)) save(h, now);
  const h = years[Number(today.slice(0, 4))];
  console.log(`history: 출고 ${outFetched}일 수집, 입고 ${rows.length}행 | 가장 이른 날 입고 ${h.earliest.in} · 택배 ${h.earliest.parcel} · 대량 ${h.earliest.bulk} | API ${apiCalls()}회`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error('history 실패:', err.message); process.exit(1); });
}
