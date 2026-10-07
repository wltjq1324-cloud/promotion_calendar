// box-stock.mjs 순수 로직 검증 (API 호출 없음): node scripts/box-stock.test.js
const path = require('path');
const { pathToFileURL } = require('url');

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ ' + name + '\n     기대: ' + w + '\n     실제: ' + g); }
};

(async () => {
  const m = await import(pathToFileURL(path.join(__dirname, 'box-stock.mjs')).href);
  const lookup = {
    byCompany: { 'G-O022x1': ['b1', 100, 100], 'G-O022x2': ['b2', 50, 50], 'G-O022x1|G-O095x1': ['b2', 10, 10] },
    byProduct: { '202927000001x3': ['b4', 5, 5] },
    byTotalQty: { 1: ['b1', 0.93, 1000], 2: ['b2', 0.7, 900], 4: ['b4', 0.52, 200] },
  };

  console.log('[서명]');
  eq('정렬·합산', m.signatureOf([{ code: 'G-O095', qty: 1 }, { code: 'G-O022', qty: 1 }, { code: 'G-O022', qty: '1' }]), 'G-O022x2|G-O095x1');
  eq('빈 코드 제외', m.signatureOf([{ code: '', qty: 3 }, { code: 'A', qty: 1 }]), 'Ax1');

  console.log('\n[판정]');
  eq('룩업(업체코드)', m.classifyInvoice([{ code: 'G-O022', qty: 1 }], lookup).box, 'b1');
  eq('룩업(로트 분할 합산)', m.classifyInvoice([{ code: 'G-O022', qty: 1 }, { code: 'G-O022', qty: 1 }], lookup).box, 'b2');
  eq('룩업(상품코드 폴백)', m.classifyInvoice([{ code: 'NEW', productCode: '202927000001', qty: 3 }], lookup).box, 'b4');
  eq('총수량 폴백', m.classifyInvoice([{ code: 'NEW', qty: 4 }], lookup).method, 'qty');
  eq('미판정', m.classifyInvoice([{ code: 'NEW', qty: 9 }], lookup).box, 'unknown');

  console.log('\n[일별 집계]');
  const datas = [
    { invoice: '1001', product_company_code: 'G-O022', out_qty: '1', out_complete_dt: '2026-09-10 10:00:00' },
    { invoice: '1002', product_company_code: 'G-O022', out_qty: 1, out_complete_dt: '2026-09-10 11:00:00' },
    { invoice: '1002', product_company_code: 'G-O095', out_qty: 1, out_complete_dt: '2026-09-10 11:00:00' },
    { invoice: '', out_data_sno: 'B1', product_company_code: 'G-O022', out_qty: 500 },
    { invoice: '', out_data_sno: 'B1', product_company_code: 'G-O095', out_qty: 200 },
    { invoice: '1003', product_company_code: 'ZZZ', out_qty: 9, out_complete_dt: '2026-09-10 12:00:00' },
  ];
  const day = m.aggregateDay('2026-09-10', datas, lookup);
  eq('송장 수(무송장 제외)', day.invoices, 3);
  eq('1호/2호', [day.b1, day.b2], [1, 1]);
  eq('미판정 1', day.unknown, 1);
  eq('무송장 그룹 1, 수량 700', [day.noInvoiceGroups, day.noInvoiceQty], [1, 700]);
  eq('라인 수', day.lines, 6);
  const after = m.aggregateDay('2026-09-10', datas, lookup, '2026-09-10 10:30:00');
  eq('실사 시각 이후만(10:00 제외)', [after.invoices, after.b1], [2, 0]);

  console.log('\n[실사 앵커]');
  const items = [{ key: 'b1', companyCode: 'S-TB001', productCode: '202927000009' }];
  const adj = [
    { item_cd: 'S-TB001', af_qty: '4,662', adj_qty: '-2,684', reg_dtm: '2026-08-27 14:10:00' },
    { item_cd: 'S-TB001', af_qty: 5834, adj_qty: -1239, reg_dtm: '2026-08-18 09:00:00' },
    { item_cd: '202927000009', af_qty: 10, adj_qty: 3, reg_dtm: '2026-08-27 14:10:30' }, // 같은 실사(셀 분할)
    { item_cd: 'OTHER', af_qty: 1, adj_qty: 1, reg_dtm: '2026-09-01 00:00:00' },
  ];
  const la = m.latestAdjustments(adj, items);
  eq('최신 실사 날짜', la.b1.date, '2026-08-27');
  eq('같은 시각 합산', [la.b1.afQty, la.b1.adjQty, la.b1.rows], [4672, -2681, 2]);

  console.log('\n[입고]');
  const put = [
    { product_company_code: 'S-TB001', input_qty: '1,512', input_complete_dt: '2026-09-20 09:00:00' },
    { product_company_code: 'S-TB001', input_qty: 72, input_complete_dt: '2026-08-27 09:00:00' }, // 실사 전 → 제외
    { product_company_code: 'S-TB002', input_qty: 20, input_complete_dt: '2026-09-21 09:00:00' },
  ];
  const rc = m.receiptsSince(put, items[0], '2026-08-27 14:10:00');
  eq('실사 이후 입고만', rc.map((r) => r.qty), [1512]);
  eq('일별 입고 맵(창 안 전부)', m.receiptsDailyMap(put, items[0], '2026-08-01', '2026-09-30'), { '2026-09-20': 1512, '2026-08-27': 72 });

  console.log('\n[주간·발주]');
  const daysMap = {};
  for (let i = 0; i < 28; i++) {
    const d = m.addDays('2026-09-19', -i); // 9/19(토)까지 4주
    daysMap[d] = { ...m.emptyDay(d), invoices: 100, b1: 100 };
  }
  const wk = m.weeklyFromDaily(daysMap, '2026-09-19', 5);
  eq('주 수', wk.length, 5);
  eq('마지막 주 = 9/13~9/19 700', [wk[4].weekStart, wk[4].b1, wk[4].partial], ['2026-09-13', 700, false]);
  eq('5주 전은 부분/0', [wk[0].b1, wk[0].partial], [0, true]);
  eq('일요일 시작', m.weekStartOf('2026-09-16'), '2026-09-13');
  const sug = m.orderSuggestion({ weekAvg: 2067, est: 187, bundle: 72, leadTimeDays: 7, reviewDays: 7, safetyRate: 0.2 });
  eq('목표 = 2067×2×1.2', sug.target, 4961);
  eq('발주 72배수 올림', sug.orderQty % 72 === 0 && sug.orderQty >= 4961 - 187, true);
  eq('재고 0 → 발주 0 아님', m.orderSuggestion({ weekAvg: 100, est: 1000, bundle: 10, leadTimeDays: 7, reviewDays: 7, safetyRate: 0.2 }).orderQty, 0);

  console.log('\n[품목 계산]');
  const item = { key: 'b1', label: '1호', name: 'S', companyCode: 'S-TB001', productCode: 'x', bundle: 72, factor: 1.1 };
  const anchor = { date: '2026-09-12', dtm: '2026-09-12 14:00:00', afQty: 1000, adjQty: -5, source: 'adjustment' };
  const r = m.computeItem({
    item, anchor, receipts: [{ date: '2026-09-15', qty: 144 }], daysMap, anchorDayUsage: 10, today: '2026-09-19',
    apiStock: { total: 1144, available: 1144, unavailable: 0 },
    cfg: { avgWeeks: 4, leadTimeDays: 7, reviewDays: 7, safetyRate: 0.2 }, weekly: wk,
  });
  eq('차감 = 실사당일 10 + 9/13~19 700', r.usage.boxes, 710);
  eq('실사 잔고 = 장부 1144 − 입고 144 (af_qty 무시)', [r.count.qty, r.count.source], [1000, 'ledger_identity']);
  eq('실재고 = 1000 + 144 − 710×1.1', r.est, 1000 + 144 - Math.round(710 * 1.1));
  eq('af_qty 일치 → 경고 없음', r.warnings.filter((w) => w.includes('≠')).length, 0);
  const r2 = m.computeItem({
    item, anchor: { ...anchor, afQty: 6048 }, receipts: [], daysMap, anchorDayUsage: 0, today: '2026-09-19',
    apiStock: { total: 500, available: 500, unavailable: 0 },
    cfg: { avgWeeks: 4, leadTimeDays: 7, reviewDays: 7, safetyRate: 0.2 }, weekly: wk,
  });
  eq('출고 > 재고 → 0 바닥 + 대체 포장 추정', [r2.est, r2.usage.substituted, r2.rawEst], [0, Math.round(700 * 1.1) - 500, 500 - Math.round(700 * 1.1)]);
  eq('af_qty 불일치 경고', r2.warnings.some((w) => w.includes('af_qty')), true);
  eq('룩업 오버라이드 우선', m.classifyInvoice([{ code: 'G-O022', qty: 1 }], { ...lookup, overrides: { 'G-O022x1': 'b4' } }).box, 'b4');
  const ovd = { ...lookup, overrides: { 'G-O022x1': { box: 'b4', from: '2026-09-03' } } };
  eq('오버라이드 from 이전 → 룩업', m.classifyInvoice([{ code: 'G-O022', qty: 1 }], ovd, '2026-09-02').box, 'b1');
  eq('오버라이드 from 이후 → 강제', m.classifyInvoice([{ code: 'G-O022', qty: 1 }], ovd, '2026-09-03').box, 'b4');
  eq('주평균(보정)', r.weekAvg, Math.round(700 * 1.1));

  {
  console.log('\n[창고 실사 기준점 — 2026-10-06 1호 2,302]');
  const manualCfg = { date: '2026-10-06', dtm: '2026-10-06 17:14', qty: 2302, alreadyDeductedBoxes: 219, reason: '창고 실사' };
  const apiAnc = { date: '2026-09-18', dtm: '2026-09-18 18:59:00', afQty: 384, adjQty: -6046, source: 'adjustment' };
  const ma = m.pickAnchor(apiAnc, manualCfg);
  eq('실사가 조정 이력보다 늦으면 실사 사용', [ma.source, ma.afQty, ma.alreadyDeducted], ['manual', 2302, 219]);
  eq('더 늦은 아워박스 조정이 생기면 그쪽 우선', m.pickAnchor({ ...apiAnc, date: '2026-10-08', dtm: '2026-10-08 10:00:00' }, manualCfg).source, 'adjustment');
  eq('설정 없으면 조정 이력 그대로', m.pickAnchor(apiAnc, undefined), apiAnc);
  const putManual = [
    { product_company_code: 'S-TB001', input_dt: '2026-10-06', input_complete_dt: '2026-10-07', input_qty: 2016, input_code: 'A' },
    { product_company_code: 'S-TB001', input_dt: '2026-10-09', input_complete_dt: '2026-10-09', input_qty: 720, input_code: 'B' },
    { product_company_code: 'S-TB002', input_dt: '2026-10-08', input_complete_dt: '2026-10-08', input_qty: 500, input_code: 'C' },
  ];
  const item1 = { key: 'b1', label: '1호', companyCode: 'S-TB001', productCode: '202927000009', bundle: 72, factor: 1 };
  const rc = m.receiptsAfterCount(putManual, item1, '2026-10-06');
  eq('실사일 입고(완료는 다음 날)는 제외, 이후 입고만', rc.map((x) => [x.inDate, x.qty]), [['2026-10-09', 720]]);
  // 출고등록일 기준: 10/06 등록 1호 245(219 + 밤 N배송 26), 10/07 180
  const reg = { '2026-10-06': { b1: 245 }, '2026-10-07': { b1: 180 } };
  const us = m.usageSinceManual(reg, 'b1', ma, '2026-10-07');
  eq('실사일은 이미 뺀 219 제외 → 26, 다음 날 180', [us.daily['2026-10-06'], us.daily['2026-10-07'], us.boxes, us.anchorDayRaw], [26, 180, 206, 245]);
  eq('완료 전이라 실사일 등록분이 219보다 적어도 음수 아님', m.usageSinceManual({ '2026-10-06': { b1: 0 } }, 'b1', ma, '2026-10-06').boxes, 0);
  const rm = m.computeItem({
    item: item1, anchor: ma, receipts: rc, daysMap: { '2026-10-07': { b1: 999, unknown: 0, invoices: 999 } }, anchorDayUsage: 0,
    today: '2026-10-09', apiStock: { total: 4520, available: 4520, unavailable: 0 },
    cfg: { avgWeeks: 4, leadTimeDays: 7, reviewDays: 7, safetyRate: 0.2 }, weekly: wk,
    usageOverride: m.usageSinceManual(reg, 'b1', ma, '2026-10-09'),
  });
  eq('실재고 = 2302 + 720 − (26 + 180), 완료일 기준 출고(999)는 안 씀', rm.est, 2302 + 720 - 206);
  eq('기준점 표시', [rm.count.qty, rm.count.source, rm.count.reason, rm.usage.basis], [2302, 'manual', '창고 실사', 'out_dt']);
  eq('장부 대조값 없음(장부는 창고 실사를 모름)', [rm.apiStock.expected, rm.apiStock.diff], [null, null]);
  eq('일별 재고(입고=실제 입고일)', rm.stockDaily, { '2026-10-06': 2276, '2026-10-07': 2096, '2026-10-08': 2096, '2026-10-09': 2816 });
  // 실측 10/07: 10/06 실물 입고 2,016이 입고번호 11675, 입고일 10/07로 등록됨 → 입고번호로 명시 제외
  const ma2 = m.pickAnchor(apiAnc, { ...manualCfg, includedReceiptCodes: ['11675'] });
  const put1007 = [{ product_company_code: 'S-TB001', input_dt: '2026-10-07', input_complete_dt: '2026-10-07', input_qty: 2016, input_code: '11675' },
    { product_company_code: 'S-TB001', input_dt: '2026-10-08', input_complete_dt: '2026-10-08', input_qty: 720, input_code: '11700' }];
  eq('입고번호 지정 없으면 10/07 입고일로 다시 더해짐(실측 버그)', m.receiptsAfterCount(put1007, item1, '2026-10-06').reduce((a, x) => a + x.qty, 0), 2736);
  eq('실사 포함 입고번호 11675 제외, 이후 입고만', m.receiptsAfterCount(put1007, item1, '2026-10-06', ma2.includedReceiptCodes).map((x) => [x.code, x.qty]), [['11700', 720]]);
  const r1007 = m.computeItem({
    item: item1, anchor: ma2, receipts: m.receiptsAfterCount([put1007[0]], item1, '2026-10-06', ma2.includedReceiptCodes), daysMap: {}, anchorDayUsage: 0,
    today: '2026-10-07', apiStock: { total: 4520, available: 4520, unavailable: 0 },
    cfg: { avgWeeks: 4, leadTimeDays: 7, reviewDays: 7, safetyRate: 0.2 }, weekly: wk,
    usageOverride: m.usageSinceManual({ '2026-10-06': { b1: 239 }, '2026-10-07': { b1: 12 } }, 'b1', ma2, '2026-10-07'),
  });
  eq('10/07 실측 재현: 2302 − (239−219) − 12 = 2270', r1007.est, 2270);
  }

  {
    console.log('\n[B2B 출고 품목 집계]');
    const rows = [
      { invoice: '', out_data_sno: 'A1', product_company_code: 'G-O022', product_name: '오리지널(10개입)', out_qty: 1800, mall_name: '밭(파머스베이크샵)' },
      { invoice: '', out_data_sno: 'A2', product_company_code: 'G-O022', product_name: '오리지널(10개입)', out_qty: 50, mall_name: '밭(파머스베이크샵)' },
      { invoice: '', out_data_sno: 'A3', product_company_code: 'G-O152', product_name: '[라한] 가을수확여행', out_qty: 200, mall_name: '' },
      { invoice: '111', product_company_code: 'G-O022', out_qty: 1 },
    ];
    const day = m.aggregateDay('2026-10-01', rows, lookup);
    eq('송장 없는 행만 품목별 합산, 큰 순', day.b2b.map((x) => [x.code, x.qty]), [['G-O022', 1850], ['G-O152', 200]]);
    eq('품명·채널 보존', [day.b2b[0].name, day.b2b[0].ch], ['오리지널(10개입)', ['밭(파머스베이크샵)']]);
    eq('택배 송장은 박스로만 집계', [day.invoices, day.noInvoiceQty], [1, 2050]);
    eq('빈 날은 b2b 빈 배열', m.emptyDay('2026-10-02').b2b, []);
  }
  console.log(`\n통과 ${pass} / 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
