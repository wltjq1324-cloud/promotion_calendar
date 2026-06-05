/**
 * 신규 미매핑 주문 품목 알림 (Google Apps Script)
 * ------------------------------------------------------------------
 * 목적
 *   주문 원본 시트(raw_orders)의 "품목명" 중에서, 상품명 매핑 표
 *   (OURBOX_프로모션_운영_DB 의 dashboard_product 컬럼)에 아직 없는
 *   "신규 미매핑 품목"을 찾아 이메일로 알린다.
 *
 *   매핑 표가 2026-05-21(데이터 5/20) 이후로 갱신되지 않아 그 뒤에
 *   새로 등장한 품목이 누락되는 문제를 잡기 위한 감시용 알림이다.
 *   (이 스크립트는 시트에 매핑을 "쓰지" 않는다. 알림만 보낸다.)
 *
 * 사용 방법 (최초 1회)
 *   1) https://script.google.com 에서 새 프로젝트 생성 후 이 파일 내용을 붙여넣기
 *   2) CONFIG 값 확인 (스프레드시트 ID/탭 이름/수신 메일)
 *   3) 메뉴에서 함수 setup 선택 후 실행 → 권한 승인(시트 읽기 + 메일 발송)
 *      - setup 은 매일 1회 자동 실행 트리거를 만들고, 즉시 1차 점검을 돌린다.
 *   4) 끝. 이후 매일 자동으로 신규 미매핑 품목이 있으면 메일이 온다.
 *
 * 수동 점검: checkUnmappedOrders 함수를 직접 실행.
 * 알림 기록 초기화(다시 처음부터 알림 받기): resetAlertMemory 실행.
 */

var CONFIG = {
  // 주문 원본 (*아워박스_DB_초안 / raw_orders)
  ORDERS_SPREADSHEET_ID: '1C3gJ1gClD5LQlRLsQEBFsu1_MTeIvWKztw6l886MoTQ',
  ORDERS_SHEET_NAME: 'raw_orders',
  ORDERS_ITEM_HEADER: '품목명',
  ORDERS_DATE_HEADER: '주문일시',

  // 상품명 매핑 표 (OURBOX_프로모션_운영_DB)
  MAPPING_SPREADSHEET_ID: '1FGxRu59DL7SMB4siYE_IZiTU5rNrHWefIeI9e_Hqazs',
  // 매핑 탭 이름을 모르면 비워두면 dashboard_product 헤더로 자동 탐색한다.
  MAPPING_SHEET_NAME: '',
  MAPPING_DASHBOARD_HEADER: 'dashboard_product',

  // 신규 품목으로 볼 기준 날짜 (이 날짜 이후 주문만 검사). 비우면 전체.
  // 매핑이 멈춘 5/20 이후만 보도록 기본값을 둔다.
  SINCE_DATE: '2026-05-20',

  // 수신 메일 (비우면 스크립트 실행 계정 메일로 발송)
  RECIPIENT: 'wltjq1324@gmail.com',

  // 메일에 품목별 예시 주문번호를 몇 개까지 보여줄지
  EXAMPLES_PER_ITEM: 3
};

/** 최초 1회: 권한 승인 + 일일 트리거 생성 + 즉시 점검 */
function setup() {
  createDailyTrigger_();
  checkUnmappedOrders();
}

/** 매일 자동 실행 트리거 생성 (중복 생성 방지) */
function createDailyTrigger_() {
  removeTriggers_();
  ScriptApp.newTrigger('checkUnmappedOrders')
    .timeBased()
    .everyDays(1)
    .atHour(9) // 매일 오전 9시(시트 시간대 기준)
    .create();
}

function removeTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkUnmappedOrders') ScriptApp.deleteTrigger(t);
  });
}

/** 알림 기록 초기화 */
function resetAlertMemory() {
  PropertiesService.getScriptProperties().deleteProperty('alertedItems');
}

/**
 * 핵심 점검 로직.
 * 1) 매핑 표의 dashboard_product 집합(정규화)을 만든다.
 * 2) raw_orders 의 품목명 중 매핑에 없고, SINCE_DATE 이후 주문에 등장한 것을 모은다.
 * 3) 이미 알린 품목을 제외한 "신규" 항목만 메일로 보낸다.
 */
function checkUnmappedOrders() {
  var mapped = getMappedDashboardSet_();
  var orders = getOrderItems_();

  var since = CONFIG.SINCE_DATE ? parseDate_(CONFIG.SINCE_DATE) : null;

  // 정규화 품목명 -> { display, count, examples:[{no,date}], latest }
  var unmapped = {};
  orders.forEach(function (row) {
    if (!row.name) return;
    if (since && row.date && row.date < since) return;
    var key = normalize_(row.name);
    if (!key || mapped[key]) return;
    if (!unmapped[key]) {
      unmapped[key] = { display: row.name, count: 0, examples: [], latest: row.date || null };
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
    Logger.log('미매핑 신규 품목 없음.');
    return;
  }

  // 중복 알림 방지: 이미 알린 항목 제외
  var props = PropertiesService.getScriptProperties();
  var alerted = {};
  try { alerted = JSON.parse(props.getProperty('alertedItems') || '{}'); } catch (e) { alerted = {}; }

  var fresh = keys.filter(function (k) { return !alerted[k]; });
  if (!fresh.length) {
    Logger.log('신규 미매핑 품목이 있으나 모두 이미 알림 처리됨.');
    return;
  }

  sendAlert_(fresh.map(function (k) { return unmapped[k]; }), keys.length);

  fresh.forEach(function (k) { alerted[k] = new Date().toISOString(); });
  props.setProperty('alertedItems', JSON.stringify(alerted));
}

/** 매핑 표 dashboard_product 집합(정규화 키 -> true) */
function getMappedDashboardSet_() {
  var ss = SpreadsheetApp.openById(CONFIG.MAPPING_SPREADSHEET_ID);
  var sheet = CONFIG.MAPPING_SHEET_NAME ? ss.getSheetByName(CONFIG.MAPPING_SHEET_NAME) : null;
  var values, col;

  if (sheet) {
    values = sheet.getDataRange().getValues();
    col = findHeaderIndex_(values, CONFIG.MAPPING_DASHBOARD_HEADER);
  } else {
    // 탭 이름을 모르면 dashboard_product 헤더가 있는 탭을 자동 탐색
    var sheets = ss.getSheets();
    for (var i = 0; i < sheets.length; i++) {
      var v = sheets[i].getDataRange().getValues();
      var c = findHeaderIndex_(v, CONFIG.MAPPING_DASHBOARD_HEADER);
      if (c >= 0) { values = v; col = c; break; }
    }
  }
  if (col == null || col < 0) {
    throw new Error('매핑 표에서 "' + CONFIG.MAPPING_DASHBOARD_HEADER + '" 헤더를 찾지 못했습니다.');
  }

  var headerRow = findHeaderRow_(values, CONFIG.MAPPING_DASHBOARD_HEADER);
  var set = {};
  for (var r = headerRow + 1; r < values.length; r++) {
    var key = normalize_(values[r][col]);
    if (key) set[key] = true;
  }
  return set;
}

/** raw_orders 읽기 -> [{name, date(Date|null), dateText, orderNo}] */
function getOrderItems_() {
  var ss = SpreadsheetApp.openById(CONFIG.ORDERS_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.ORDERS_SHEET_NAME);
  if (!sheet) throw new Error('주문 탭 "' + CONFIG.ORDERS_SHEET_NAME + '" 을 찾지 못했습니다.');

  var values = sheet.getDataRange().getValues();
  if (!values.length) return [];

  var header = values[0];
  var iName = header.indexOf(CONFIG.ORDERS_ITEM_HEADER);
  var iDate = header.indexOf(CONFIG.ORDERS_DATE_HEADER);
  var iNo = header.indexOf('주문번호');
  if (iName < 0) throw new Error('주문 탭에서 "' + CONFIG.ORDERS_ITEM_HEADER + '" 헤더를 찾지 못했습니다.');

  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var name = row[iName];
    if (name === '' || name == null) continue;
    var dateText = iDate >= 0 ? row[iDate] : '';
    out.push({
      name: String(name).trim(),
      date: parseDate_(dateText),
      dateText: String(dateText),
      orderNo: iNo >= 0 ? String(row[iNo]) : ''
    });
  }
  return out;
}

/** 알림 메일 발송 */
function sendAlert_(items, totalUnmapped) {
  items.sort(function (a, b) { return b.count - a.count; });

  var to = CONFIG.RECIPIENT || Session.getEffectiveUser().getEmail();
  var subject = '[OURBOX] 신규 미매핑 주문 품목 ' + items.length + '건 발견';

  var lines = [];
  lines.push('상품명 매핑 표에 없는 신규 주문 품목이 발견되었습니다.');
  lines.push('(기준일 ' + (CONFIG.SINCE_DATE || '전체') + ' 이후 주문 / 이번에 처음 알리는 ' + items.length + '건)');
  lines.push('');
  items.forEach(function (u, idx) {
    var ex = u.examples.map(function (e) { return e.no + (e.date ? '(' + e.date + ')' : ''); }).join(', ');
    lines.push((idx + 1) + '. ' + u.display);
    lines.push('   - 주문 건수: ' + u.count + '건' + (u.latest ? ' / 최근: ' + formatDate_(u.latest) : ''));
    if (ex) lines.push('   - 예시 주문번호: ' + ex);
  });
  lines.push('');
  lines.push('매핑 표를 열어 위 품목들을 추가/검토해 주세요.');
  lines.push('https://docs.google.com/spreadsheets/d/' + CONFIG.MAPPING_SPREADSHEET_ID + '/edit');
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

/** "2025. 12. 17", "2025-12-17", Date 객체 등을 Date 로 파싱 */
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

/** 헤더 텍스트가 있는 열 인덱스 (헤더가 1~2행 어디에 있든 탐색) */
function findHeaderIndex_(values, headerText) {
  for (var r = 0; r < Math.min(values.length, 5); r++) {
    var c = values[r].indexOf(headerText);
    if (c >= 0) return c;
  }
  return -1;
}

/** 헤더 텍스트가 있는 행 인덱스 */
function findHeaderRow_(values, headerText) {
  for (var r = 0; r < Math.min(values.length, 5); r++) {
    if (values[r].indexOf(headerText) >= 0) return r;
  }
  return 0;
}
