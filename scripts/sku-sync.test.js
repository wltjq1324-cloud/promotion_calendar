// sku-sync.gs 매칭 로직 검증 — /inven 화면의 실제 미매핑 상품명으로 테스트
// 실행: node scripts/sku-sync.test.js
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/sku-sync.gs','utf8');
const g={};
new Function('g', src.replace(/function setupSkuSync[\s\S]*?\n}\n/,'')
                     .replace(/function syncSkuMapping[\s\S]*?\n^}/m,'')
                     .replace(/function skInventoryNames[\s\S]*?\n}\n/,'')
                     .replace(/function skMail[\s\S]*?\n}\n?$/,'')
             +'\ng.skMatch=skMatch; g.skNorm=skNorm; g.skEa=skEa;')(g);

// 실제 재고 상품명
const inv=[...new Set(JSON.parse(fs.readFileSync(__dirname+'/../inventory-latest.json','utf8'))
  .items.map(i=>i.product_name).filter(Boolean))];
const invMap={}; inv.forEach(n=>{const k=g.skNorm(n); if(!invMap[k])invMap[k]=n});

// /inven 화면에 뜬 미매핑 상품 (수량 내림차순)
const cases=[
  ['오리지널(10개입) (2EA)',881],
  ['오리지널감자빵 100g 8개입',682],
  ['초당옥수수빵 5개입(1EA) + 오리지널(5개입)(1EA)',452],
  ['오리지널(10개입)(1EA) + 랜덤 스티커 세트(1EA)',370],
  ['감자밭 보냉백',362],
  ['초당옥수수빵 5개입(2EA)',67],
  ['고구마빵(4개입) (2EA)',50],
  ['랜덤 스티커 세트',40],
  ['[만월상회] (4EA) 오리지널(10개입)',23],
  ['[만월상회] (4EA) 고구마빵(4개입)',15],
  ['[굿즈] 인형키링 (방울토마토)',13],
  ['랜덤 스티커 3종 세트',10],
];

let auto=0, manual=0;
console.log('상품명 (30일 출고) → 결과\n' + '-'.repeat(78));
for(const [name,qty] of cases){
  const r=g.skMatch(name,{},invMap);
  const ok=r.matchType!=='unmapped';
  ok?auto++:manual++;
  const slots=r.names.length?r.names.join(' + '):'(비움 → 드롭다운에서 선택)';
  console.log(`${ok?'✔ 자동':'✘ 수동'}  ${name}  (${qty}개)`);
  console.log(`        ${r.matchType} → ${slots}`);
}
console.log('-'.repeat(78));
const covered=cases.filter(c=>g.skMatch(c[0],{},invMap).matchType!=='unmapped').reduce((s,c)=>s+c[1],0);
const total=cases.reduce((s,c)=>s+c[1],0);
console.log(`자동 연결 ${auto}건 / 수동 선택 ${manual}건`);
console.log(`출고 수량 기준 커버리지: ${covered}/${total}개 (${Math.round(covered/total*100)}%)`);
