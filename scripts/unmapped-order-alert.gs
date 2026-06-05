/**
 * 신규 미매핑 주문 품목 알림 (Google Apps Script)
 * ------------------------------------------------------------------
 * 대상 스프레드시트: "*아워박스_DB_초안"
 *   - raw_orders 탭: 주문 원본 (컬럼: 주문번호, 품목명, 수량, 실결제금액, 배송비, 쇼핑몰명, 주문일시)
 *   - map_product 탭: 상품명 매핑 (컬럼: 원본 품목명, 표준 품목명, 상품군, 사용여부, 구성단품, 매핑상태/원가)
 *
 * 무엇을 알리나
 *   1) raw_orders 의 "품목명" 중 map_product 의 "원본 품목명" 어디에도 없는 신규 품목
 *   2) map_product 에는 있지만 "매핑상태/원가" 가 "미매핑" 또는 "원가미등록" 으로 표시된 항목 중
 *      raw_orders 에 실제 주문이 있는 품목
 *
 *   ① 은 매핑 표 자체에 행이 빠진 누락,
 *   ② 는 행은 있지만 매칭이 안 끝난 상태를 잡는다.
 *
 * 사용 방법 (최초 1회)
 *   1) https://script.google.com 에서 새 프로젝트 생성
 *   2) 이 파일 내용을 붙여넣기
 *   3) 메뉴에서 setup 실행 → 권한 승인(시트 읽기 + 메일 발송)
 *   4) 끝. 매일 오전 9시 자동 점검, 신규 항목이 있을 때만 메일이 온다.
 *
 * 수동 점검: checkUnmappedOrders 직접 실행
 * 알림 기록 초기화: resetAlertMemory 실행
 */

var CONFIG = {
  SPREADSHEET_ID: '1C3gJ1gClD5LQlRLsQEBFsu1_MTeIvWKztw6l886MoTQ',

  ORDERS_SHEET: 'raw_orders',
  ORDERS_ITEM_HEADER: '품목명',
  ORDERS_DATE_HEADER: '주문일시',
  ORDERS_NO_HEADER: '주문번호',

  MAP_SHEET: 'map_product',
  MAP_RAW_HEADER: '원본 품목명',
  MAP_STATUS_HEADER: '매핑상태/원가',
  MAP_ACTIVE_HEADER: '사용여부',
  // 매핑 미완료를 의미하는 상태값 (이 문자열을 포함하면 미매핑으로 본다)
  STATUS_INCOMPLETE_KEYWORDS: ['미매핑', '원가미등록'],

  // 이 날짜 이후 주문만 검사 (매핑이 멈춘 시점 이후). 비우면 전체.
  SINCE_DATE: '2026-05-20',

  // 받는 사람. 비우면 스크립트 실행 계정 메일
  RECIPIENT: 'wltjq1324@gmail.com',

  EXAMPLES_PER_ITEM: 3
};

/** 최초 1회: 매일 자동 트리거 생성 + 즉시 점검 */
function setup() {
  createDailyTrigger_();
  checkUnmappedOrders();
}

function createDailyTrigger_() {
  removeTriggers_();
  ScriptApp.newTrigger('checkUnmappedOrders')
    .timeBased()
    .everyDays(1)
    .atHour(9)
    .create();
}

function removeTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkUnmappedOrders') ScriptApp.deleteTrigger(t);
  });
}

function resetAlertMemory() {
  PropertiesService.getScriptProperties().deleteProperty('alertedItems');
}

/** 핵심 점검 */
function checkUnmappedOrders() {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);

  var mapInfo = readMap_(ss);
  var orders = readOrders_(ss);
  var since = CONFIG.SINCE_DATE ? parseDate_(CONFIG.SINCE_DATE) : null;

  // 정규화 키 -> {display, count, latest, examples, reason}
  var unmapped = {};
  orders.forEach(function (row) {
    if (!row.name) return;
    if (since && row.date && row.date < since) return;

    var key = normalize_(row.name);
    if (!key) return;

    var reason = null;
    if (!mapInfo.mapped[key]) {
      reason = '매핑 표에 없음';
    } else if (mapInfo.incomplete[key]) {
      reason = '매핑 표 상태: ' + mapInfo.incomplete[key];
    }
    if (!reason) return;

    if (!unmapped[key]) {
      unmapped[key] = {
        display: row.name,
        count: 0,
        latest: null,
        examples: [],
        reason: reason
      };
    }
    var u = unmapped[key];
    u.count++;
    if (row.date && (!u.latest || row.date > u.latest)) u.latest = row.date;
    if (u.examples.length < CONFIG.EXAMPLES_PER_ITEM) {
      u.examples.push({ no: row.orderNo, date: row.dateText });
    }
  });

  var keys = Object.keys(unmapped);
  if (!keys.length) {
    Logger.log('미매핑/미완료 신규 품목 없음.');
    return;
  }

  // 중복 알림 방지
  var props = PropertiesService.getScriptProperties();
  var alerted = {};
  try { alerted = JSON.parse(props.getProperty('alertedItems') || '{}'); } catch (e) { alerted = {}; }

  var fresh = keys.filter(function (k) { return !alerted[k]; });
  if (!fresh.length) {
    Logger.log('미매핑 품목이 있으나 모두 이미 알림 처리됨. (총 ' + keys.length + '건)');
    return;
  }

  sendAlert_(fresh.map(function (k) { return unmapped[k]; }), keys.length);

  fresh.forEach(function (k) { alerted[k] = new Date().toISOString(); });
  props.setProperty('alertedItems', JSON.stringify(alerted));
}

/** map_product 읽기 → {mapped, incomplete} */
function readMap_(ss) {
  var sheet = ss.getSheetByName(CONFIG.MAP_SHEET);
  if (!sheet) throw new Error('탭 "' + CONFIG.MAP_SHEET + '" 을 찾지 못했습니다.');
  var values = sheet.getDataRange().getValues();
  if (!values.length) return { mapped: {}, incomplete: {} };

  var header = values[0];
  var iRaw = header.indexOf(CONFIG.MAP_RAW_HEADER);
  var iStatus = header.indexOf(CONFIG.MAP_STATUS_HEADER);
  var iActive = header.indexOf(CONFIG.MAP_ACTIVE_HEADER);
  if (iRaw < 0) throw new Error('map_product 에서 "' + CONFIG.MAP_RAW_HEADER + '" 헤더를 찾지 못했습니다.');

  var mapped = {};
  var incomplete = {};
  for (var r = 1; r < values.length; r++) {
    var raw = values[r][iRaw];
    if (raw === '' || raw == null) continue;
    if (iActive >= 0 && String(values[r][iActive]).trim().toUpperCase() === 'N') continue;

    var key = normalize_(raw);
    if (!key) continue;
    mapped[key] = true;

    if (iStatus >= 0) {
      var status = String(values[r][iStatus] || '').trim();
      var bad = CONFIG.STATUS_INCOMPLETE_KEYWORDS.filter(function (kw) {
        return status.indexOf(kw) >= 0;
      });
      if (bad.length) incomplete[key] = bad.join(', ');
    }
  }
  return { mapped: mapped, incomplete: incomplete };
}

/** raw_orders 읽기 */
function readOrders_(ss) {
  var sheet = ss.getSheetByName(CONFIG.ORDERS_SHEET);
  if (!sheet) throw new Error('탭 "' + CONFIG.ORDERS_SHEET + '" 을 찾지 못했습니다.');
  var values = sheet.getDataRange().getValues();
  if (!values.length) return [];

  var header = values[0];
  var iName = header.indexOf(CONFIG.ORDERS_ITEM_HEADER);
  var iDate = header.indexOf(CONFIG.ORDERS_DATE_HEADER);
  var iNo = header.indexOf(CONFIG.ORDERS_NO_HEADER);
  if (iName < 0) throw new Error('raw_orders 에서 "' + CONFIG.ORDERS_ITEM_HEADER + '" 헤더를 찾지 못했습니다.');

  var out = [];
  for (var r = 1; r < values.length; r++) {
    var name = values[r][iName];
    if (name === '' || name == null) continue;
    var dateText = iDate >= 0 ? values[r][iDate] : '';
    out.push({
      name: String(name).trim(),
      date: parseDate_(dateText),
      dateText: String(dateText),
      orderNo: iNo >= 0 ? String(values[r][iNo]) : ''
    });
  }
  return out;
}

function sendAlert_(items, totalUnmapped) {
  items.sort(function (a, b) { return b.count - a.count; });

  var to = CONFIG.RECIPIENT || Session.getEffectiveUser().getEmail();
  var subject = '[OURBOX] 신규 미매핑 주문 품목 ' + items.length + '건';

  var lines = [];
  lines.push('주문에 등장했지만 매핑이 완료되지 않은 품목이 있습니다.');
  lines.push('(검사 기준일: ' + (CONFIG.SINCE_DATE || '전체') + ' 이후 주문 / 이번 알림: ' + items.length + '건, 누계 미매핑: ' + totalUnmapped + '건)');
  lines.push('');
  items.forEach(function (u, idx) {
    var ex = u.examples.map(function (e) { return e.no + (e.date ? '(' + e.date + ')' : ''); }).join(', ');
    lines.push((idx + 1) + '. ' + u.display);
    lines.push('   - 사유: ' + u.reason);
    lines.push('   - 주문 건수: ' + u.count + '건' + (u.latest ? ' / 최근 주문: ' + formatDate_(u.latest) : ''));
    if (ex) lines.push('   - 예시 주문번호: ' + ex);
  });
  lines.push('');
  lines.push('아워박스_DB_초안 → map_product 탭을 열어 추가/원가 입력을 진행해 주세요.');
  lines.push('https://docs.google.com/spreadsheets/d/' + CONFIG.SPREADSHEET_ID + '/edit');
  lines.push('');
  lines.push('— 자동 알림 (unmapped-order-alert)');

  MailApp.sendEmail(to, subject, lines.join('\n'));
  Logger.log('알림 발송: ' + items.length + '건 -> ' + to);
}

/* ===================== 유틸 ===================== */

/** 매칭용 정규화: 공백/괄호/대괄호/마침표 제거 + 소문자 */
function normalize_(s) {
  if (s === '' || s == null) return '';
  return String(s)
    .toLowerCase()
    .replace(/[\s()\[\]（）【】.]/g, '')
    .trim();
}

function parseDate_(v) {
  if (!v && v !== 0) return null;
  if (Object.prototype.toString.call(v) === '[object Date]') return v;
  var s = String(v).trim();
  var m = s.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function formatDate_(d) {
  if (!d) return '';
  return Utilities.formatDate(d, Session.getScriptTimeZone() || 'Asia/Seoul', 'yyyy-MM-dd');
}
