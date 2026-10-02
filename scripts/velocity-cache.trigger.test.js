// onOrdersChange 동작 검증 — Google API 를 흉내 내서 실행
// 실행: node scripts/velocity-cache.trigger.test.js
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/velocity-cache.gs','utf8');

function makeEnv({rawRows, lockFree=true, withSync=true}){
  const log={rebuilds:0, syncs:0, writes:0};
  const props={};
  const H=['주문번호','품목명','수량','실결제금액','배송비','쇼핑몰명','주문일시'];
  const rows=[H]; for(let i=1;i<rawRows;i++) rows.push([i,'오리지널(10개입)',1,0,0,'카카오','2026-10-01']);
  const orders={getLastRow:()=>rows.length, getDataRange:()=>({getValues:()=>rows})};
  const cache={clear(){}, getRange:()=>({setValues(){log.writes++}})};
  const env={
    SpreadsheetApp:{openById:id=>({getSheetByName:n=>n==='raw_orders'?orders:cache, insertSheet:()=>cache})},
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k]??null, setProperty:(k,v)=>{props[k]=v}})},
    LockService:{getScriptLock:()=>({tryLock:()=>lockFree, releaseLock(){}})},
    Logger:{log(){}},
    ScriptApp:{}, 
  };
  if(withSync) env.syncSkuMapping=()=>{log.syncs++};
  env.__log=log;
  const names=Object.keys(env);
  const fn=new Function(...names, src+`
    var _rebuild=rebuildVelocityCache;
    rebuildVelocityCache=function(){__log.rebuilds++; return _rebuild();};
    return {onOrdersChange:onOrdersChange, rebuild:function(){return rebuildVelocityCache()}};`);
  const api=fn(...names.map(n=>env[n]));
  return {api, log, props, grow(n){for(let i=0;i<n;i++) rows.push([0,'고구마빵(4개입)',1,0,0,'카카오','2026-10-01'])}};
}

let pass=0,fail=0;
const ok=(name,cond,detail='')=>{cond?pass++:fail++;console.log(`  ${cond?'✔':'✘'} ${name}${cond?'':'  '+detail}`)};

console.log('[붙여넣기 감지]');
{ const t=makeEnv({rawRows:100}); t.api.rebuild();            // 최초 실행 → 100행 기록
  t.log.rebuilds=0; t.log.syncs=0;
  t.api.onOrdersChange();                                       // 행 수 그대로 (map_product 편집 등)
  ok('행 수 그대로면 재생성 안 함 (map_product 편집 등)', t.log.rebuilds===0, `rebuilds=${t.log.rebuilds}`);
  t.grow(50); t.api.onOrdersChange();                           // 출고내역 붙여넣기
  ok('행이 늘면 즉시 재생성', t.log.rebuilds===1, `rebuilds=${t.log.rebuilds}`);
  ok('재생성 후 sku_mapping 동기화까지 연쇄 실행', t.log.syncs===1, `syncs=${t.log.syncs}`);
  ok('반영한 행 수 기록 (150)', t.props.vcLastRows==='150', `vcLastRows=${t.props.vcLastRows}`);
  t.api.onOrdersChange();
  ok('같은 상태로 다시 불려도 중복 재생성 안 함', t.log.rebuilds===1, `rebuilds=${t.log.rebuilds}`);
}
console.log('\n[가장자리]');
{ const t=makeEnv({rawRows:100}); t.api.rebuild(); t.log.rebuilds=0; t.grow(5);
  const t2=makeEnv({rawRows:100,lockFree:false}); t2.api.rebuild(); t2.log.rebuilds=0; t2.grow(5); t2.api.onOrdersChange();
  ok('이미 재생성 중(잠금)이면 건너뜀', t2.log.rebuilds===0, `rebuilds=${t2.log.rebuilds}`);
  const t3=makeEnv({rawRows:100,withSync:false}); t3.api.rebuild(); t3.log.rebuilds=0; t3.grow(5);
  let threw=false; try{t3.api.onOrdersChange()}catch(e){threw=true}
  ok('skuSync.gs 가 없어도 오류 없이 동작', !threw && t3.log.rebuilds===1, `threw=${threw}`);
  const t4=makeEnv({rawRows:100}); t4.log.rebuilds=0; t4.api.onOrdersChange();
  ok('기록이 없던 최초 상태에서도 재생성', t4.log.rebuilds===1, `rebuilds=${t4.log.rebuilds}`);
  const t5=makeEnv({rawRows:100}); t5.api.rebuild(); t5.log.rebuilds=0;
  for(let i=0;i<10;i++) t5.api.onOrdersChange();
  ok('행 변화 없이 10번 불려도 0번 재생성', t5.log.rebuilds===0, `rebuilds=${t5.log.rebuilds}`);
}
console.log('\n'+(fail?`실패 ${fail}건 / 통과 ${pass}건`:`전부 통과 (${pass}건)`));
process.exit(fail?1:0);
