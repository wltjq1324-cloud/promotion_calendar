// 일회용: 출고실적(out_perf_period) 응답에 어떤 열이 있는지, 송장 없는 줄(대량출고)의 값은 무엇인지 확인한다.
// 송장 있는 택배 줄(소비자)은 열 이름만 남긴다. 전화번호는 가리고 주소는 앞 두 단어만 남긴다.
import { writeFileSync, mkdirSync } from 'node:fs';
import { keys, fetchPages } from './box-stock.mjs';

const DATES = ['2026-10-28', '2026-10-22', '2026-10-15'];
const k = keys();
const out = { keys: [], noInvoice: {} };
const allKeys = new Set();
const clean = (name, v) => {
  let s = String(v ?? '');
  if (/(tel|phone|hp|mobile)/i.test(name) || /\d{2,4}-\d{3,4}-\d{4}/.test(s)) s = s ? '[가림]' : '';
  if (/(addr|address|zip)/i.test(name)) s = s.split(/\s+/).slice(0, 2).join(' ');
  return s;
};
for (const d of DATES) {
  const rows = await fetchPages('/api/wms/out/out_perf_period', { out_dt_type: '2', out_dt_from: d, out_dt_to: d }, 'datas', k, { requestSleepMs: 200 }, 80);
  for (const r of rows) Object.keys(r).forEach((x) => allKeys.add(x));
  out.noInvoice[d] = rows.filter((r) => !String(r.invoice ?? '').trim())
    .map((r) => Object.fromEntries(Object.entries(r).map(([n, v]) => [n, clean(n, v)])));
  out[`count_${d}`] = { all: rows.length, noInvoice: out.noInvoice[d].length };
}
out.keys = [...allKeys];
mkdirSync('probe', { recursive: true });
writeFileSync('probe/out-fields.json', JSON.stringify(out, null, 1), 'utf8');
console.log('keys:', out.keys.join(', '));
