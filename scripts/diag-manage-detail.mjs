// 1회성 진단: /api/oms/manage/products 의 view_type basic vs detail 응답 필드 비교.
// 공개 저장소 로그에 남으므로 값은 절대 출력하지 않는다 — 필드 이름·채워진 건수·휴대폰 형식 건수만.
const B = 'https://api.ourbox.co.kr';
const H = { api_access_key: process.env.OURBOX_API_ACCESS_KEY, api_secret_key: process.env.OURBOX_API_SECRET_KEY, 'Content-Type': 'application/json' };
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
async function call(view) {
  const r = await fetch(B + '/api/oms/manage/products', { method: 'POST', headers: H, body: JSON.stringify({ order_dt: today, view_type: view, order_state: '6', page: 1 }) });
  const j = await r.json();
  return { http: r.status, result: j.result, code: j.code, rows: j.products || [], total: j.total_product_cnt, topKeys: Object.keys(j) };
}
const mob = (v) => /^01[016789]\d{7,8}$/.test(String(v ?? '').replace(/[^0-9]/g, ''));
const stat = (rows) => {
  const m = {};
  for (const r of rows) for (const [k, v] of Object.entries(r)) {
    m[k] ??= { filled: 0, mobile: 0 };
    if (v !== null && v !== '') m[k].filled++;
    if (mob(v)) m[k].mobile++;
  }
  return m;
};
const b = await call('basic');
const d = await call('detail');
console.log('date', today, '| basic', b.http, b.result, b.code, 'rows', b.rows.length, 'total', b.total, '| detail', d.http, d.result, d.code, 'rows', d.rows.length, 'total', d.total);
console.log('detail top-level keys:', d.topKeys.join(', '));
const sb = stat(b.rows), sd = stat(d.rows);
console.log('fields only in detail:', Object.keys(sd).filter((k) => !(k in sb)).join(', ') || '(none)');
console.log('fields only in basic :', Object.keys(sb).filter((k) => !(k in sd)).join(', ') || '(none)');
console.log('detail field stats (filled / mobile-format, of', d.rows.length, 'rows):');
for (const [k, v] of Object.entries(sd)) console.log(`  ${k}: ${v.filled} / ${v.mobile}`);
