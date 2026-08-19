// velocity-cache.gs 집계 로직 검증 (Apps Script 없이 실행: node scripts/velocity-cache.test.js)
const fs=require('fs');
const src=fs.readFileSync(__dirname + '/velocity-cache.gs','utf8');
// GAS 전용 API 를 뺀 순수 로직만 평가
const sandbox={};
new Function('g', src.replace(/function setupVelocityCache[\s\S]*?\n}\n/,'')
                    .replace(/function rebuildVelocityCache[\s\S]*?\n}\n/,'')
             + '\ng.vcAggregate=vcAggregate; g.vcDate=vcDate; g.vcKey=vcKey; g.VC=VC;')(sandbox);
const {vcAggregate,vcDate,vcKey}=sandbox;

let pass=0,fail=0;
const eq=(name,got,want)=>{const g=JSON.stringify(got),w=JSON.stringify(want);
  if(g===w){pass++;console.log('  ✔ '+name)}else{fail++;console.log('  ✘ '+name+'\n     기대: '+w+'\n     실제: '+g)}};

console.log('[날짜 파싱]');
eq('"2025. 12. 17" 형식', vcKey(vcDate('2025. 12. 17')), '2025-12-17');
eq('"2026-08-12" 형식', vcKey(vcDate('2026-08-12')), '2026-08-12');
eq('Date 객체', vcKey(vcDate(new Date(2026,7,1))), '2026-08-01');
eq('빈 값', vcDate(''), null);
eq('한자리 월/일 0채움', vcKey(vcDate('2026. 1. 5')), '2026-01-05');

console.log('\n[집계]');
const H=['주문번호','품목명','수량','실결제금액','배송비','쇼핑몰명','주문일시'];
const row=(no,item,qty,date)=>[no,item,qty,0,0,'카카오',date];
const data=[H,
  row(1,'오리지널 (10개입)',2,'2026. 8. 12'),   // 최신일
  row(2,'오리지널 (10개입)',3,'2026. 8. 12'),   // 같은 날 같은 상품 → 합산
  row(3,'고구마빵(4개입)',1,'2026. 8. 12'),
  row(4,'오리지널 (10개입)',5,'2026. 7. 20'),   // 23일 전 → 포함
  row(5,'치즈감자빵(5개입)',7,'2026. 7. 13'),   // 30일 전 → 경계, 포함
  row(6,'옛날상품',99,'2026. 7. 12'),           // 31일 전 → 제외
  row(7,'',4,'2026. 8. 12'),                    // 품목명 없음 → 제외
];
const out=vcAggregate(data,30);
eq('최신 출고일', out.latest, '2026-08-12');
eq('헤더', out.rows[0], ['date','product','qty']);
eq('같은 날 같은 상품 합산(2+3)', out.rows.find(r=>r[0]==='2026-08-12'&&r[1]==='오리지널 (10개입)')[2], 5);
eq('30일 경계 포함', !!out.rows.find(r=>r[1]==='치즈감자빵(5개입)'), true);
eq('31일 전 제외', !!out.rows.find(r=>r[1]==='옛날상품'), false);
eq('품목명 빈 행 제외', out.rows.filter(r=>r[1]==='').length, 0);
eq('총 집계 행 수', out.rows.length-1, 4);
eq('날짜 정렬', out.rows.slice(1).map(r=>r[0]), ['2026-07-13','2026-07-20','2026-08-12','2026-08-12']);

console.log('\n[가장자리]');
eq('빈 시트', vcAggregate([],30).rows, [['date','product','qty']]);
eq('헤더만', vcAggregate([H],30).rows, [['date','product','qty']]);
eq('날짜 전부 깨짐', vcAggregate([H,row(1,'x',1,'없음')],30).rows, [['date','product','qty']]);

console.log('\n[/inven 계산 재현 — 일평균 = 14일 ÷ 14]');
const big=[H]; for(let i=0;i<14;i++) big.push(row(i,'상품A',10,'2026. 8. '+(12-i)));
const o2=vcAggregate(big,30);
const s14=o2.rows.slice(1).filter(r=>r[0]>='2026-07-30').reduce((s,r)=>s+r[2],0);
eq('14일 출고 합계', s14, 140);
eq('일평균(140/14)', s14/14, 10);
eq('가용 300 → 잔여일', 300/(s14/14), 30);

console.log('\n'+(fail?`실패 ${fail}건 / 통과 ${pass}건`:`전부 통과 (${pass}건)`));
process.exit(fail?1:0);
