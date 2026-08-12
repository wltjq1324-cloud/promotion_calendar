/**
 * OURBOX 프로모션 캘린더 API (Google Apps Script 웹앱) — 재구성 백업본
 * ------------------------------------------------------------------
 * 이 파일은 무엇인가
 *   캘린더(index.html)가 호출하는 웹앱의 서버 코드다. 원본은 Apps Script
 *   프로젝트 "OURBOX_프로모션_API" 의 버전 9(2026-05-15)에만 존재하고
 *   저장소에는 없었다. 버전 기록이 사라지면 복구 수단이 없으므로,
 *   클라이언트가 실제로 주고받는 형식에 맞춰 재구성해 백업으로 남긴다.
 *
 * 사용 순서 (중요)
 *   1순위: Apps Script "프로젝트 기록"에서 버전 9 의 Code.gs 내용을 그대로 복원.
 *          현재 운영 중인 검증된 코드이므로 이쪽이 항상 안전하다.
 *   2순위: 버전 기록을 쓸 수 없을 때만 이 파일을 Code.gs 에 붙여넣는다.
 *
 * 대상 시트: OURBOX_프로모션_운영_DB
 *   프로모션 탭 — 1행 한글 라벨, 2행 필드키(id,title,...), 3행부터 데이터
 *   상품/채널/담당자 탭도 같은 구조(1행 라벨, 2행 키, 3행부터 데이터)
 *
 * API 계약 (index.html 기준)
 *   GET  ?action=load&role=edit
 *        → {promotions:[...], products:[{name,price}], channels:[...], owners:[...]}
 *   POST {action:'upsert', role, data:{id?, title, start_date, end_date,
 *         product_name, channel, expected_qty_tier, owner, memo, updated_by}}
 *        → {ok:true, id:'p...'}   ← id 를 돌려주면 클라이언트가 재조회 없이 즉시 반영한다
 *   POST {action:'delete', role, id}
 *        → {ok:true, id:'p...'}
 *   오류 시 {error:'메시지'}
 */

var SS_ID = '1FGxRu59DL7SMB4siYE_IZiTU5rNrHWefIeI9e_Hqazs';

var SHEETS = {
  promotions: '프로모션',
  products: '상품',
  channels: '채널',
  owners: '담당자'
};

// 프로모션 탭 2행(필드키) 순서
var PROMO_FIELDS = ['id','title','start_date','end_date','product_name','channel',
                    'expected_qty_tier','owner','memo','updated_at','updated_by'];

var HEADER_ROWS = 2; // 1행 한글 라벨 + 2행 필드키

/* ===================== 진입점 ===================== */

function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) || 'load';
    if (action !== 'load') return json_({ error: '알 수 없는 action: ' + action });
    return json_(loadAll_());
  } catch (err) {
    return json_({ error: err.message });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    // 동시 저장이 겹쳐 행이 깨지지 않도록 직렬화한다.
    lock.waitLock(20000);

    var body = {};
    if (e && e.postData && e.postData.contents) body = JSON.parse(e.postData.contents);

    if (body.action === 'upsert') return json_(upsert_(body.data || {}));
    if (body.action === 'delete') return json_(remove_(body.id));
    return json_({ error: '알 수 없는 action: ' + body.action });
  } catch (err) {
    return json_({ error: err.message });
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}

/* ===================== 조회 ===================== */

function loadAll_() {
  return {
    promotions: readPromotions_(),
    products: readProducts_(),
    channels: readNames_(SHEETS.channels),
    owners: readNames_(SHEETS.owners)
  };
}

function readPromotions_() {
  var sheet = sheet_(SHEETS.promotions);
  var last = sheet.getLastRow();
  if (last <= HEADER_ROWS) return [];

  var values = sheet.getRange(HEADER_ROWS + 1, 1, last - HEADER_ROWS, PROMO_FIELDS.length).getValues();
  var out = [];
  values.forEach(function (row) {
    if (!row[0]) return; // id 없는 행은 건너뜀
    var rec = {};
    PROMO_FIELDS.forEach(function (key, i) {
      rec[key] = (key === 'start_date' || key === 'end_date') ? dateKey_(row[i]) : text_(row[i]);
    });
    out.push(rec);
  });
  return out;
}

/** 상품 탭: 명칭 / 사용여부 / 정상가 → [{name, price}] (사용여부 FALSE 제외) */
function readProducts_() {
  var sheet = sheet_(SHEETS.products);
  var last = sheet.getLastRow();
  if (last <= HEADER_ROWS) return [];

  var values = sheet.getRange(HEADER_ROWS + 1, 1, last - HEADER_ROWS, 3).getValues();
  var out = [];
  values.forEach(function (row) {
    var name = text_(row[0]);
    if (!name || isFalse_(row[1])) return;
    out.push({ name: name, price: numeric_(row[2]) });
  });
  return out;
}

/** 채널·담당자 탭: 명칭 / 사용여부 → [이름] */
function readNames_(sheetName) {
  var sheet = sheet_(sheetName);
  var last = sheet.getLastRow();
  if (last <= HEADER_ROWS) return [];

  var values = sheet.getRange(HEADER_ROWS + 1, 1, last - HEADER_ROWS, 2).getValues();
  var out = [];
  values.forEach(function (row) {
    var name = text_(row[0]);
    if (name && !isFalse_(row[1])) out.push(name);
  });
  return out;
}

/* ===================== 저장 / 삭제 ===================== */

function upsert_(data) {
  if (!data.title) throw new Error('프로모션명이 없습니다.');
  if (!data.start_date || !data.end_date) throw new Error('시작일/종료일이 없습니다.');
  if (String(data.start_date) > String(data.end_date)) throw new Error('종료일은 시작일 이후여야 합니다.');

  var sheet = sheet_(SHEETS.promotions);
  var id = text_(data.id) || newId_();
  var row = PROMO_FIELDS.map(function (key) {
    if (key === 'id') return id;
    if (key === 'updated_at') return now_();
    return text_(data[key]);
  });

  var at = findRow_(sheet, id);
  if (at > 0) sheet.getRange(at, 1, 1, row.length).setValues([row]);
  else sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length).setValues([row]);

  return { ok: true, id: id };
}

function remove_(id) {
  id = text_(id);
  if (!id) throw new Error('삭제할 id 가 없습니다.');

  var sheet = sheet_(SHEETS.promotions);
  var at = findRow_(sheet, id);
  if (at > 0) sheet.deleteRow(at);
  // 이미 지워진 경우도 성공으로 본다(재시도 안전).
  return { ok: true, id: id };
}

/** id 가 있는 시트 행 번호. 없으면 0 */
function findRow_(sheet, id) {
  var last = sheet.getLastRow();
  if (last <= HEADER_ROWS) return 0;
  var ids = sheet.getRange(HEADER_ROWS + 1, 1, last - HEADER_ROWS, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (text_(ids[i][0]) === id) return HEADER_ROWS + 1 + i;
  }
  return 0;
}

/* ===================== 유틸 ===================== */

function sheet_(name) {
  var sheet = SpreadsheetApp.openById(SS_ID).getSheetByName(name);
  if (!sheet) throw new Error('탭 "' + name + '" 을 찾지 못했습니다.');
  return sheet;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function newId_() {
  return 'p' + new Date().getTime();
}

function now_() {
  return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm');
}

function text_(v) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return dateKey_(v);
  return String(v).trim();
}

/** 클라이언트가 문자열로 날짜를 비교하므로 항상 yyyy-MM-dd 로 맞춘다. */
function dateKey_(v) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, 'Asia/Seoul', 'yyyy-MM-dd');
  }
  return String(v).trim();
}

function numeric_(v) {
  if (v === null || v === undefined || v === '') return 0;
  return Number(String(v).replace(/[^0-9.-]/g, '')) || 0;
}

function isFalse_(v) {
  var s = String(v).trim().toUpperCase();
  return s === 'FALSE' || s === 'N' || s === '0';
}
