// node scripts/history.test.js — 입출고 연간 누적의 순수 로직 검증
(async () => {
  const m = await import('./history.mjs');
  let pass = 0, fail = 0;
  const eq = (name, a, b) => { const ok = JSON.stringify(a) === JSON.stringify(b); ok ? pass++ : fail++; console.log(`  ${ok ? '✔' : '✘'} ${name}${ok ? '' : `\n     got ${JSON.stringify(a)}\n     exp ${JSON.stringify(b)}`}`); };
  const lookup = { bySig: {}, byProduct: {}, byTotalQty: {}, overrides: {} };

  console.log('[출고 하루치 → 택배/대량]');
  const datas = [
    { invoice: '1', product_code: 'P1', product_company_code: 'G-1', product_name: '오리지널(10개입)', out_qty: 2 },
    { invoice: '2', product_code: 'P2', product_company_code: 'G-151', product_name: '고구마빵 3개입', out_qty: 1 },
    { invoice: '', out_data_sno: 'H', product_code: 'P3', product_company_code: 'G-34', product_name: '[L]오리지널 10개입', out_qty: 3, mall_name: '롯데홈쇼핑-직택배(일반)' },
    { invoice: '', out_data_sno: 'B', product_code: 'P1', product_company_code: 'G-1', product_name: '오리지널(10개입)', out_qty: 500, mall_name: '밭(파머스베이크샵)' },
  ];
  const o = m.outDay('2026-10-01', datas, lookup);
  eq('택배는 송장 + 직택배, 상품코드 키', o.parcel, { P1: 2, P2: 1, P3: 3 });
  eq('대량은 송장 없는 차량 출고만', o.bulk, { P1: 500 });
  const products = {};
  m.namesFrom(datas, products);
  eq('상품 이름·업체코드 기록', products.P2, { name: '고구마빵 3개입', companyCode: 'G-151' });

  console.log('\n[입고 → 날짜별]');
  const rec = m.receiptsByDay([
    { product_code: 'P1', input_complete_dt: '2026-10-30', input_dt: '2026-10-29', input_qty: '2000' },
    { product_code: 'P1', input_complete_dt: '2026-10-30', input_qty: '2,000' },
    { product_code: 'P2', input_dt: '2026-10-31', input_qty: 960 },
  ]);
  eq('입고완료일 기준 합산(없으면 입고일)', rec, { '2026-10-30': { P1: 4000 }, '2026-10-31': { P2: 960 } });

  console.log('\n[CSV]');
  const h = m.emptyYear(2026);
  h.products = products;
  h.days['2026-10-30'] = { in: { P1: 4000 }, parcel: { P1: 2 }, bulk: {} };
  h.days['2026-10-31'] = { in: {}, parcel: {}, bulk: {} };
  const csv = m.toCsv(h).trim().split('\n');
  eq('헤더', csv[0], '날짜,월,요일,상품코드,업체품목코드,상품명,입고,택배출고,대량출고');
  eq('한 줄 = 날짜×상품, 값 없는 날 제외', csv.slice(1), ['2026-10-30,2026-10,금,P1,G-1,오리지널(10개입),4000,2,0']);

  console.log(`\n통과 ${pass} / 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
