/**
 * 출고 집계 캐시 (Google Apps Script) — /inven 재고 페이지용
 * ------------------------------------------------------------------
 * 무엇을 하나
 *   출고 원본(*아워박스_DB_초안 / raw_orders)을 읽어
 *   "날짜 × 상품 = 수량" 으로 최근 30일치를 집계하고,
 *   운영_DB 의 velocity_cache 탭에 기록한다.
 *   /inven 페이지가 이 탭을 읽어 7일·14일·30일 출고와 소진예상일을 계산한다.
 *
 *   30일인 이유: /inven 계산이 30일 밖 데이터를 버리고,
 *   일평균은 14일 출고 ÷ 14 로 산출하기 때문.
 *
 * 사용법
 *   1) 이 파일을 Apps Script 프로젝트에 새 스크립트 파일로 추가
 *   2) setupVelocityCache 실행 → 권한 승인
 *      (출고 원본 붙여넣기 시 즉시 갱신 + 3시간마다 안전망 + 즉시 1회 실행)
 *   수동 실행은 rebuildVelocityCache.
 *
 * 안전: 출고 원본은 읽기만 한다. velocity_cache 탭만 쓴다.
 */

var VC = {
  ORDERS_SS_ID: '1C3gJ1gClD5LQlRLsQEBFsu1_MTeIvWKztw6l886MoTQ', // *아워박스_DB_초안
  ORDERS_SHEET: 'raw_orders',
  H_ITEM: '품목명',
  H_DATE: '주문일시',
  H_QTY: '수량',

  TARGET_SS_ID: '1FGxRu59DL7SMB4siYE_IZiTU5rNrHWefIeI9e_Hqazs', // OURBOX_프로모션_운영_DB
  TARGET_SHEET: 'velocity_cache',

  DAYS: 30
};

/** 최초 1회: 자동 실행 등록 + 즉시 1회 실행 */
function setupVelocityCache() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'rebuildVelocityCache' || fn === 'onOrdersChange') ScriptApp.deleteTrigger(t);
  });
  // 1) 출고 원본에 붙여넣는 순간 바로 갱신 (시간 주기로 쫓아가면 붙여넣기 직후 공백이 생긴다)
  ScriptApp.newTrigger('onOrdersChange').forSpreadsheet(VC.ORDERS_SS_ID).onChange().create();
  // 2) 안전망: 변경 감지가 누락돼도 3시간 안에는 따라잡는다
  ScriptApp.newTrigger('rebuildVelocityCache').timeBased().everyHours(3).create();
  return rebuildVelocityCache();
}

/**
 * 출고 원본 스프레드시트가 바뀌면 호출된다.
 * 같은 파일의 map_product 등을 편집해도 불리므로, raw_orders 행 수가 달라졌을 때만 재생성한다.
 * (행 수 확인은 가벼운 호출이라 매 편집마다 불려도 부담이 없다)
 */
function onOrdersChange() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // 이미 재생성 중이면 건너뜀 — 끝나고 나면 최신 상태다
  try {
    var src = SpreadsheetApp.openById(VC.ORDERS_SS_ID).getSheetByName(VC.ORDERS_SHEET);
    if (!src) return;
    var rows = src.getLastRow();
    var prev = Number(PropertiesService.getScriptProperties().getProperty('vcLastRows')) || 0;
    if (rows === prev) return;
    rebuildVelocityCache();
    // sku_mapping 동기화(skuSync.gs)가 같은 프로젝트에 있으면 이어서 실행 → 새 상품도 바로 매핑
    if (typeof syncSkuMapping === 'function') {
      try { syncSkuMapping(); } catch (e) { Logger.log('sku_mapping 동기화 실패: ' + e.message); }
    }
  } finally {
    lock.releaseLock();
  }
}

/** 출고 원본 → 날짜×상품 집계 → velocity_cache 탭 */
function rebuildVelocityCache() {
  var src = SpreadsheetApp.openById(VC.ORDERS_SS_ID).getSheetByName(VC.ORDERS_SHEET);
  if (!src) throw new Error('탭 "' + VC.ORDERS_SHEET + '" 을 찾지 못했습니다.');

  var values = src.getDataRange().getValues();
  var out = vcAggregate(values, VC.DAYS);

  var ss = SpreadsheetApp.openById(VC.TARGET_SS_ID);
  var dst = ss.getSheetByName(VC.TARGET_SHEET);
  if (!dst) dst = ss.insertSheet(VC.TARGET_SHEET);
  dst.clear();
  dst.getRange(1, 1, out.rows.length, 3).setValues(out.rows);
  // 어디까지 반영했는지 기록 → onOrdersChange 가 "행이 늘었는지" 판단할 때 쓴다
  PropertiesService.getScriptProperties().setProperty('vcLastRows', String(src.getLastRow()));

  // 원본이 며칠 밀렸는지 함께 알린다.
  // (연동이 멈춘 것인지, 원본에 데이터가 안 들어온 것인지 구분하기 위해)
  var today = vcKey(new Date());
  var lag = out.latest ? Math.round((vcDate(today) - vcDate(out.latest)) / 86400000) : -1;
  var msg = '출고 집계: ' + (out.rows.length - 1) + '행 기록'
    + ' / 원본 최신 출고일 ' + out.latest + ' (오늘 ' + today + ' 기준 ' + lag + '일 경과)'
    + ' / 집계 범위 ' + VC.DAYS + '일';
  if (lag >= 2) msg += '\n※ 원본(raw_orders)에 최근 출고내역이 안 들어온 상태입니다. 3PL 출고내역을 붙여넣어 주세요.';
  Logger.log(msg);
  return msg;
}

/**
 * 집계 본체. 시트 값 배열을 받아 [['date','product','qty'], ...] 를 만든다.
 * 시트에 의존하지 않으므로 그대로 테스트할 수 있다.
 */
function vcAggregate(values, days) {
  if (!values || values.length < 2) return { latest: '', rows: [['date', 'product', 'qty']] };

  var header = values[0];
  var iName = header.indexOf(VC.H_ITEM);
  var iDate = header.indexOf(VC.H_DATE);
  var iQty = header.indexOf(VC.H_QTY);
  if (iName < 0 || iDate < 0) throw new Error('raw_orders 에서 품목명/주문일시 헤더를 찾지 못했습니다.');

  // 최신 출고일 기준으로 구간을 잡는다 (오늘 기준이 아니라 데이터 기준)
  var latestD = null;
  for (var r = 1; r < values.length; r++) {
    var d = vcDate(values[r][iDate]);
    if (d && (!latestD || d > latestD)) latestD = d;
  }
  if (!latestD) return { latest: '', rows: [['date', 'product', 'qty']] };

  var cutoff = new Date(latestD.getTime());
  cutoff.setDate(cutoff.getDate() - days);

  var agg = {};
  for (var i = 1; i < values.length; i++) {
    var name = String(values[i][iName] == null ? '' : values[i][iName]).trim();
    if (!name) continue;
    var od = vcDate(values[i][iDate]);
    if (!od || od < cutoff) continue;
    var key = vcKey(od) + '|' + name; // 날짜는 항상 10자라 구분자 하나면 충돌하지 않는다
    if (!agg[key]) agg[key] = { date: vcKey(od), product: name, qty: 0 };
    agg[key].qty += iQty >= 0 ? (Number(values[i][iQty]) || 0) : 1;
  }

  var rows = [['date', 'product', 'qty']];
  Object.keys(agg).sort().forEach(function (k) {
    rows.push([agg[k].date, agg[k].product, agg[k].qty]);
  });
  return { latest: vcKey(latestD), rows: rows };
}

/** "2025. 12. 17" / "2025-12-17" / Date → Date */
function vcDate(v) {
  if (!v && v !== 0) return null;
  if (Object.prototype.toString.call(v) === '[object Date]') return v;
  var m = String(v).trim().match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  var d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d;
}

/** Date → 'yyyy-MM-dd' (문자열 비교로 구간을 판정하므로 형식을 고정한다) */
function vcKey(d) {
  var mm = String(d.getMonth() + 1);
  var dd = String(d.getDate());
  return d.getFullYear() + '-' + (mm.length < 2 ? '0' + mm : mm) + '-' + (dd.length < 2 ? '0' + dd : dd);
}
