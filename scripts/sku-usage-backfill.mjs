// SKU 연간 출고 1회 수집 — 아워박스 출고실적(out_perf_period, 출고완료일)을 날짜별로 받아
// 상품코드별 택배 / 대량출고 수량으로 묶어 sku-usage-2026.json 에 남긴다.
// 택배·대량 구분은 scripts/box-stock.mjs aggregateDay 와 같다:
//   송장 있음 = 택배, 송장 없음 + 채널에 '택배' = 직택배(택배에 포함), 그 밖의 송장 없음 = 대량출고.
// 실행: OURBOX_API_ACCESS_KEY / OURBOX_API_SECRET_KEY 환경변수. node scripts/sku-usage-backfill.mjs [from] [to]
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OURBOX = 'https://api.ourbox.co.kr';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'sku-usage-2026.json');
const SLEEP_MS = 200;

const text = (v) => (v == null ? '' : String(v).trim());
const toInt = (v) => { const n = Number(String(v == null ? '' : v).replace(/,/g, '')); return Number.isFinite(n) ? Math.round(n) : 0; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const addDays = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const kstToday = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
const add = (o, k, q) => { o[k] = (o[k] || 0) + q; };

// 하루치 행 → {parcel, direct, bulk, bulkCh, parcelCh} (키는 상품코드)
export function aggregate(rows) {
  const day = { parcel: {}, direct: {}, bulk: {}, bulkCh: {}, parcelCh: {} };
  const names = {};
  for (const r of rows) {
    const code = text(r.product_code) || text(r.product_company_code) || '?';
    const qty = toInt(r.out_qty);
    const ch = text(r.mall_name || r.channel) || '(채널 없음)';
    if (text(r.product_name) || !names[code]) names[code] = { name: text(r.product_name), company: text(r.product_company_code) };
    if (text(r.invoice)) {
      add(day.parcel, code, qty);
      day.parcelCh[ch] = day.parcelCh[ch] || {}; add(day.parcelCh[ch], code, qty);
    } else if (/택배/.test(ch)) {
      add(day.parcel, code, qty); add(day.direct, code, qty);
      day.parcelCh[ch] = day.parcelCh[ch] || {}; add(day.parcelCh[ch], code, qty);
    } else {
      add(day.bulk, code, qty);
      day.bulkCh[ch] = day.bulkCh[ch] || {}; add(day.bulkCh[ch], code, qty);
    }
  }
  return { day, names };
}

async function main() {
  const access = text(process.env.OURBOX_API_ACCESS_KEY), secret = text(process.env.OURBOX_API_SECRET_KEY);
  if (!access || !secret) throw new Error('OURBOX_API_ACCESS_KEY / OURBOX_API_SECRET_KEY 환경변수가 필요합니다.');
  const from = process.argv[2] || '2026-04-01';
  const to = process.argv[3] || kstToday();
  const today = kstToday();
  let calls = 0;
  const post = async (body) => {
    for (let attempt = 1; ; attempt += 1) {
      calls += 1;
      try {
        const res = await fetch(`${OURBOX}/api/wms/out/out_perf_period`, {
          method: 'POST',
          headers: { api_access_key: access, api_secret_key: secret, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const raw = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 120)}`);
        const json = JSON.parse(raw);
        if (json.result !== true && String(json.result) !== 'true') throw new Error(`code ${json.code || '?'}: ${json.message || ''}`);
        return json;
      } catch (e) {
        if (attempt >= 4) throw e;
        console.log(`  재시도 ${attempt} (${body.out_dt_from} p${body.page}): ${e.message}`);
        await sleep(2000 * attempt);
      }
    }
  };

  // 이어받기: 결과 파일이 있으면 끝난 날짜(partial 아님)는 다시 받지 않는다. 7일마다 저장하고, 시간 예산을 넘기면 멈춘다.
  const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
  const products = (prev && prev.products) || {}; const mismatches = (prev && prev.mismatches) || [];
  const days = ((prev && prev.days) || []).filter((x) => !x.partial && x.date >= from && x.date < today);
  const done = new Set(days.map((x) => x.date));
  const budgetMs = Number(process.env.BUDGET_MIN || 100) * 60000;
  const t0 = Date.now();
  let complete = true;
  const save = () => {
    days.sort((a, b) => (a.date < b.date ? -1 : 1));
    writeFileSync(OUT, JSON.stringify({
      generated_at: new Date().toISOString(), basis: 'out_complete_dt', source: 'ourbox out_perf_period',
      from, to, complete, calls: calls + ((prev && prev.calls) || 0), elapsed_ms: Date.now() - t0, mismatches, products, days,
    }), 'utf8');
  };
  let sinceSave = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (done.has(d)) continue;
    if (Date.now() - t0 > budgetMs) { complete = false; console.log(`시간 예산 초과: ${d} 부터 남음`); break; }
    const rows = []; let page = 1, totalPage = 1, totalCnt = 0;
    do {
      const json = await post({ out_dt_type: '2', out_dt_from: d, out_dt_to: d, page });
      for (const r of json.datas || []) rows.push(r);
      totalPage = Number(json.total_page || 1); totalCnt = Number(json.total_cnt || 0);
      page += 1;
      await sleep(SLEEP_MS);
    } while (page <= totalPage && page <= 300);
    if (rows.length !== totalCnt) mismatches.push({ date: d, total_cnt: totalCnt, rows: rows.length });
    const { day, names } = aggregate(rows);
    Object.assign(products, names);
    days.push({ date: d, rows: rows.length, ...day, ...(d === today ? { partial: true } : {}) });
    if (rows.length) console.log(`${d} rows ${rows.length} pages ${totalPage}`);
    sinceSave += 1;
    if (sinceSave >= 7) { save(); sinceSave = 0; }
  }
  save();
  console.log(`${complete ? '완료' : '중단'}: ${days.length}일, 이번 호출 ${calls}회, 불일치 ${mismatches.length}일, ${Math.round((Date.now() - t0) / 1000)}초`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e); process.exit(1); });
