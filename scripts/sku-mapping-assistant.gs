/**
 * SKU 매핑 어시스턴트 (Google Apps Script)
 * ------------------------------------------------------------------
 * 대상 스프레드시트: "*아워박스_DB_초안"
 *   - raw_orders  탭: 주문 원본 (주문번호, 품목명, 수량, 실결제금액, 배송비, 쇼핑몰명, 주문일시)
 *   - map_product 탭: 상품명 매핑 (원본 품목명, 표준 품목명, 상품군, 사용여부, 구성단품, 매핑상태/원가)
 *
 * 무엇을 하나 ("자동 초안 + 드롭다운 승인" 구조)
 *   1) raw_orders 에 등장했지만 map_product 에 없는 신규 품목명을 감지
 *   2) 기존 매핑 이력을 사전으로 삼아 자동 매칭:
 *      - 정규화 완전일치            → ✅ 자동매핑 (기존 표준명 복사)
 *      - 번들 분해 성공 (A + B 패턴) → ✅ 자동매핑 (구성단품 자동 기입, 상품군=세트)
 *      - 부분 일치 후보 존재         → ⚠️ 자동추천-검토 (후보 채워두고 사람이 확인)
 *      - 매칭 실패                  → ⚠️ 미매핑 (드롭다운에서 직접 선택)
 *   3) map_product 하단에 초안 행을 append (기존 행은 절대 수정하지 않음)
 *   4) 신규 행의 "표준 품목명"/"상품군" 셀에 데이터 유효성 드롭다운 적용
 *   5) ⚠️ 검토 필요 건만 요약 메일 발송 (중복 발송 방지)
 *
 * 안전 원칙
 *   - append-only: 기존 행 수정/삭제 없음
 *   - 원가는 자동 기입하지 않음 (오염 위험) → 매핑상태 열에 상태 텍스트만
 *   - 재실행해도 이미 추가된 품목은 다시 추가되지 않음 (map_product 자체가 기억장치)
 *
 * 사용 방법 (최초 1회)
 *   1) https://script.google.com 새 프로젝트 → 이 파일 붙여넣기
 *   2) setup 실행 → 권한 승인 (시트 읽기/쓰기 + 메일)
 *   3) 끝. 매일 오전 9시 자동 실행. 수동 실행은 runMappingAssistant.
 */

var CONFIG = {
  SPREADSHEET_ID: '1C3gJ1gClD5LQlRLsQEBFsu1_MTeIvWKztw6l886MoTQ',

  ORDERS_SHEET: 'raw_orders',
  ORDERS_ITEM_HEADER: '품목명',
  ORDERS_DATE_HEADER: '주문일시',

  MAP_SHEET: 'map_product',
  H_RAW: '원본 품목명',
  H_STD: '표준 품목명',
  H_TYPE: '상품군',
  H_ACTIVE: '사용여부',
  H_COMP: '구성단품',
  H_STATUS: '매핑상태/원가',

  // 상태 라벨
  STATUS_AUTO: '✅ 자동매핑',
  STATUS_REVIEW: '⚠️ 자동추천-검토',
  STATUS_UNMAPPED: '⚠️ 미매핑',

  // 이 날짜 이후 주문만 검사 (매핑이 멈춘 시점 이후). 비우면 전체.
  SINCE_DATE: '2026-05-20',

  RECIPIENT: 'wltjq1324@gmail.com',
  EXAMPLES_PER_ITEM: 3,

  // 주문 유입 정체 감시: raw_orders 최신 주문일시가 오늘로부터 N일 이상
  // 오래됐으면 경고 메일 (0 이면 감시 끔)
  STALE_DAYS: 3
};

/* -------------------------------------------------------------------
 * [사이트 연동] 캘린더 /inven 페이지가 직접 읽는 운영_DB 의 sku_mapping 탭.
 * 여기가 갱신돼야 사이트의 미매핑 경고가 사라지고 소진예상일 계산이 살아난다.
 * ------------------------------------------------------------------- */
var SITE = {
  MAPPING_SS_ID: '1FGxRu59DL7SMB4siYE_IZiTU5rNrHWefIeI9e_Hqazs', // OURBOX_프로모션_운영_DB
  MAPPING_SHEET: 'sku_mapping',
  INVENTORY_JSON_URL: 'https://wltjq1324-cloud.github.io/promotion_calendar/inventory-latest.json',
  RECENT_DAYS: 60, // 최근 N일 내 출고된 상품만 동기화 대상
  MAX_NAME_SLOTS: 6 // inventory_product_name_1~6
};

/** 최초 1회: 일일 트리거 + 편집 트리거 + 즉시 실행 */
function setup() {
  removeTriggers_();
  ScriptApp.newTrigger('runDailyPipeline').timeBased().everyDays(1).atHour(9).create();
  // map_product 에서 표준 품목명을 드롭다운으로 고르는 순간 구성단품/상품군 자동 채움
  ScriptApp.newTrigger('onMapEdit')
    .forSpreadsheet(CONFIG.SPREADSHEET_ID)
    .onEdit()
    .create();
  runDailyPipeline();
}

/** 매일 실행: 사이트용 sku_mapping 동기화 → 내부 map_product 어시스턴트 */
function runDailyPipeline() {
  var errors = [];
  try { runSkuMappingSync(); } catch (e) { errors.push('sku_mapping 동기화: ' + e.message); }
  try { runMappingAssistant(); } catch (e) { errors.push('map_product 어시스턴트: ' + e.message); }
  if (errors.length) throw new Error(errors.join(' / '));
}

function removeTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'runMappingAssistant' || fn === 'runDailyPipeline' || fn === 'onMapEdit') ScriptApp.deleteTrigger(t);
  });
}

/** 알림 기록 초기화 (검토 메일을 처음부터 다시 받고 싶을 때) */
function resetAlertMemory() {
  PropertiesService.getScriptProperties().deleteProperty('alertedItems');
  PropertiesService.getScriptProperties().deleteProperty('siteAlertedItems');
}

/* ===================== [사이트] sku_mapping 자동 동기화 ===================== */

/**
 * /inven 페이지가 읽는 운영_DB sku_mapping 탭을 자동 갱신한다.
 *  1) 출고 원본 시트(raw_orders)에서 최근 RECENT_DAYS일 상품 목록 수집
 *  2) sku_mapping 에 이미 있는 상품은 건너뜀 (append-only)
 *  3) 기존 매핑 행 + 실시간 재고 상품명으로 자동 매칭:
 *     - 단품 완전일치            → 자동 (needs_review FALSE)
 *     - 번들 분해 (A + B / A*N)  → 자동 (needs_review TRUE, 사이트 관례 유지)
 *     - 실패                     → unmapped (재고상품명 비움, 드롭다운으로 선택)
 *  4) 신규 행의 inventory_product_name_1~6 셀에 재고 상품명 드롭다운 적용
 *  5) 미매핑 건만 요약 메일
 */
function runSkuMappingSync() {
  var ss = SpreadsheetApp.openById(SITE.MAPPING_SS_ID);
  var sheet = ss.getSheetByName(SITE.MAPPING_SHEET);
  if (!sheet) throw new Error('탭 "' + SITE.MAPPING_SHEET + '" 을 찾지 못했습니다.');

  var values = sheet.getDataRange().getValues();
  if (!values.length) throw new Error('sku_mapping 이 비어 있습니다.');
  var header = values[0];
  var col = {
    gen: header.indexOf('generated_at'),
    latest: header.indexOf('dashboard_latest_date'),
    dash: header.indexOf('dashboard_product'),
    std: header.indexOf('standard_product_name'),
    type: header.indexOf('product_type'),
    inv1: header.indexOf('inventory_product_name_1'),
    match: header.indexOf('match_type'),
    conf: header.indexOf('confidence'),
    review: header.indexOf('needs_review')
  };
  if (col.dash < 0 || col.inv1 < 0) throw new Error('sku_mapping 헤더(dashboard_product / inventory_product_name_1)를 찾지 못했습니다.');

  // 기존 매핑: 존재 집합 + 단품 사전 (dashboard/standard → 재고상품명)
  var existing = {}, unitDict = {};
  for (var r = 1; r < values.length; r++) {
    var dash = String(values[r][col.dash] || '').trim();
    if (!dash || dash === '대시보드 상품명(원문)') continue;
    existing[normalize_(dash)] = true;
    var inv1 = String(values[r][col.inv1] || '').trim();
    var type = col.type >= 0 ? String(values[r][col.type] || '').trim() : '';
    var inv2 = col.inv1 + 1 < header.length ? String(values[r][col.inv1 + 1] || '').trim() : '';
    if (inv1 && !inv2 && type !== '세트') { // 단품 매핑만 사전에 등록
      unitDict[normalize_(dash)] = inv1;
      var std = col.std >= 0 ? String(values[r][col.std] || '').trim() : '';
      if (std) unitDict[normalize_(std)] = inv1;
    }
  }

  // 실시간 재고 상품명 (정확 일치 매칭 + 드롭다운 후보)
  var invNames = fetchInventoryNames_();
  var invByNorm = {};
  invNames.forEach(function (n) { if (!invByNorm[normalize_(n)]) invByNorm[normalize_(n)] = n; });

  // 대시보드 최근 상품
  var dash = fetchDashboardProducts_();
  if (!dash.products.length) { Logger.log('출고 원본에 최근 상품 없음.'); return; }

  var newOnes = dash.products.filter(function (p) { return !existing[normalize_(p.name)]; });
  if (!newOnes.length) { Logger.log('sku_mapping: 신규 상품 없음.'); return; }

  var now = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
  var width = sheet.getLastColumn();
  var rows = [];
  var unmappedForMail = [];

  newOnes.forEach(function (p) {
    var m = matchSiteProduct_(p.name, unitDict, invByNorm);
    var row = new Array(width).fill('');
    if (col.gen >= 0) row[col.gen] = now;
    if (col.latest >= 0) row[col.latest] = dash.latestDate;
    row[col.dash] = p.name;
    if (col.std >= 0) row[col.std] = m.standard;
    if (col.type >= 0) row[col.type] = m.type;
    for (var i = 0; i < Math.min(m.invNames.length, SITE.MAX_NAME_SLOTS); i++) {
      row[col.inv1 + i] = m.invNames[i];
    }
    if (col.match >= 0) row[col.match] = m.matchType;
    if (col.conf >= 0) row[col.conf] = m.confidence;
    if (col.review >= 0) row[col.review] = m.needsReview ? 'TRUE' : 'FALSE';
    rows.push(row);
    if (m.matchType === 'unmapped') unmappedForMail.push({ name: p.name, qty: p.qty });
  });

  var startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, rows.length, width).setValues(rows);

  // 재고상품명 슬롯에 드롭다운 (실시간 재고 상품명 목록)
  if (invNames.length) {
    var rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(invNames.slice().sort(), true)
      .setAllowInvalid(true)
      .setHelpText('재고 상품명에서 선택하세요.')
      .build();
    sheet.getRange(startRow, col.inv1 + 1, rows.length, SITE.MAX_NAME_SLOTS).setDataValidation(rule);
  }

  if (unmappedForMail.length) sendSiteDigest_(unmappedForMail, rows.length);
  Logger.log('sku_mapping: ' + rows.length + '행 추가 (미매핑 ' + unmappedForMail.length + ')');
}

/**
 * 출고 원본 시트(raw_orders)를 직접 읽어 최근 상품 목록을 만든다.
 *
 * 예전에는 대시보드 캐시 웹앱을 거쳤으나
 *   - 그 웹앱이 멈추면 매핑 동기화도 함께 멈추고
 *   - 캐시 갱신 시점만큼 데이터가 늦어진다.
 * 어차피 같은 데이터를 보므로 원본을 직접 읽는다. (읽기만 하며 원본은 수정하지 않는다)
 */
function fetchDashboardProducts_() {
  var sheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getSheetByName(CONFIG.ORDERS_SHEET);
  if (!sheet) throw new Error('탭 "' + CONFIG.ORDERS_SHEET + '" 을 찾지 못했습니다.');
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return { latestDate: '', products: [] };

  var header = values[0];
  var iName = header.indexOf(CONFIG.ORDERS_ITEM_HEADER);
  var iDate = header.indexOf(CONFIG.ORDERS_DATE_HEADER);
  var iQty = header.indexOf('수량');
  if (iName < 0) throw new Error('raw_orders 에서 "' + CONFIG.ORDERS_ITEM_HEADER + '" 헤더를 찾지 못했습니다.');

  // 1) 최신 출고일 파악
  var latestD = null;
  for (var r = 1; r < values.length; r++) {
    var d = iDate >= 0 ? parseDate_(values[r][iDate]) : null;
    if (d && (!latestD || d > latestD)) latestD = d;
  }
  var latest = latestD ? formatDate_(latestD) : '';
  var cutoffD = latestD ? new Date(latestD.getTime()) : null;
  if (cutoffD) cutoffD.setDate(cutoffD.getDate() - SITE.RECENT_DAYS);

  // 2) 최근 구간 상품별 수량 집계
  var agg = {};
  for (var i = 1; i < values.length; i++) {
    var name = String(values[i][iName] || '').trim();
    if (!name) continue;
    var od = iDate >= 0 ? parseDate_(values[i][iDate]) : null;
    if (cutoffD && od && od < cutoffD) continue;
    var key = normalize_(name);
    if (!key) continue;
    if (!agg[key]) agg[key] = { name: name, qty: 0 };
    agg[key].qty += iQty >= 0 ? (Number(values[i][iQty]) || 0) : 1;
  }
  return { latestDate: latest, products: Object.keys(agg).map(function (k) { return agg[k]; }) };
}

/** GitHub Pages 재고 JSON 에서 상품명 유니크 목록 */
function fetchInventoryNames_() {
  var res = UrlFetchApp.fetch(SITE.INVENTORY_JSON_URL + '?t=' + new Date().getTime(), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('재고 JSON HTTP ' + res.getResponseCode());
  var data = JSON.parse(res.getContentText());
  var seen = {}, out = [];
  (data.items || []).forEach(function (it) {
    var n = String(it.product_name || '').trim();
    if (n && !seen[n]) { seen[n] = true; out.push(n); }
  });
  return out;
}

/** 대시보드 상품명 → 재고상품명 슬롯 매칭 */
function matchSiteProduct_(name, unitDict, invByNorm) {
  function unit(piece) {
    var k = normalize_(piece);
    if (unitDict[k]) return unitDict[k];
    if (invByNorm[k]) return invByNorm[k];
    var s = normalize_(stripTags_(piece));
    if (unitDict[s]) return unitDict[s];
    if (invByNorm[s]) return invByNorm[s];
    return null;
  }

  // "X * N" 반복
  var mult = name.match(/^(.*?)\s*[\*xX×]\s*(\d+)\s*$/);
  if (mult) {
    var base = unit(mult[1]);
    if (base) {
      var n = Math.max(1, Number(mult[2]) || 1);
      var reps = [];
      for (var i = 0; i < n; i++) reps.push(base);
      return { standard: name, type: '세트', invNames: reps, matchType: 'auto_multiple', confidence: 'high', needsReview: true };
    }
  }

  // "A + B" 번들
  var pieces = name.split(/\s*\+\s*/);
  if (pieces.length > 1) {
    var comps = [];
    for (var p = 0; p < pieces.length; p++) {
      var parsed = parsePiece_(pieces[p]);
      var u = unit(parsed.name);
      if (!u) { comps = null; break; }
      for (var q = 0; q < parsed.ea; q++) comps.push(u);
    }
    if (comps) return { standard: name, type: '세트', invNames: comps, matchType: 'auto_bundle', confidence: 'high', needsReview: true };
  } else {
    // 단일 + (NEA)
    var single = parsePiece_(name);
    var u1 = unit(single.name);
    if (u1) {
      if (single.ea > 1) {
        var rep = [];
        for (var m = 0; m < single.ea; m++) rep.push(u1);
        return { standard: single.name + ' * ' + single.ea, type: '세트', invNames: rep, matchType: 'auto_multiple', confidence: 'high', needsReview: true };
      }
      return { standard: name, type: '단품', invNames: [u1], matchType: 'auto_alias', confidence: 'high', needsReview: false };
    }
  }

  return { standard: name, type: '', invNames: [], matchType: 'unmapped', confidence: 'low', needsReview: true };
}

/** 미매핑 요약 메일 (중복 발송 방지) */
function sendSiteDigest_(unmapped, totalAdded) {
  var props = PropertiesService.getScriptProperties();
  var alerted = {};
  try { alerted = JSON.parse(props.getProperty('siteAlertedItems') || '{}'); } catch (e) { alerted = {}; }
  var fresh = unmapped.filter(function (u) { return !alerted[normalize_(u.name)]; });
  if (!fresh.length) return;

  fresh.sort(function (a, b) { return b.qty - a.qty; });
  var to = CONFIG.RECIPIENT || Session.getEffectiveUser().getEmail();
  var lines = [];
  lines.push('/inven 페이지용 sku_mapping 에 신규 상품 ' + totalAdded + '행이 자동 추가되었습니다.');
  lines.push('아래 ' + fresh.length + '건은 자동 매칭에 실패했습니다. 시트에서 재고상품명을 드롭다운으로 선택해 주세요.');
  lines.push('');
  fresh.forEach(function (u, i) {
    lines.push((i + 1) + '. ' + u.name + ' (최근 출고 ' + u.qty + '개)');
  });
  lines.push('');
  lines.push('sku_mapping 바로가기:');
  lines.push('https://docs.google.com/spreadsheets/d/' + SITE.MAPPING_SS_ID + '/edit');
  lines.push('');
  lines.push('— 자동 알림 (sku-mapping-sync)');
  MailApp.sendEmail(to, '[OURBOX] 재고 페이지 미매핑 상품 ' + fresh.length + '건', lines.join('\n'));

  fresh.forEach(function (u) { alerted[normalize_(u.name)] = new Date().toISOString(); });
  props.setProperty('siteAlertedItems', JSON.stringify(alerted));
}

/** 날짜키 이동: '2026-08-03' + (-60) → '2026-06-04' */
function shiftDateKey_(key, days) {
  var d = parseDate_(key);
  if (!d) return '';
  d.setDate(d.getDate() + days);
  return Utilities.formatDate(d, 'Asia/Seoul', 'yyyy-MM-dd');
}

/* ===================== 메인 ===================== */

function runMappingAssistant() {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var mapSheet = ss.getSheetByName(CONFIG.MAP_SHEET);
  if (!mapSheet) throw new Error('탭 "' + CONFIG.MAP_SHEET + '" 을 찾지 못했습니다.');

  checkStaleness_(ss);

  var dict = buildDictionaries_(mapSheet);
  var newItems = findNewItems_(ss, dict);

  if (!newItems.length) {
    Logger.log('신규 품목 없음.');
    return;
  }

  // 자동 매칭
  var drafts = newItems.map(function (it) {
    var m = matchItem_(it.display, dict);
    return {
      raw: it.display,
      std: m.standard,
      type: m.type,
      comp: m.components.join(','),
      status: m.status,
      count: it.count,
      latest: it.latest,
      examples: it.examples
    };
  });

  appendDraftRows_(mapSheet, dict, drafts);

  // 검토 필요 건만 메일
  var review = drafts.filter(function (d) { return d.status !== CONFIG.STATUS_AUTO; });
  if (review.length) sendReviewDigest_(review, drafts.length);

  Logger.log('추가 ' + drafts.length + '건 (자동 ' + (drafts.length - review.length) + ' / 검토 ' + review.length + ')');
}

/* ===================== 사전 구축 ===================== */

/**
 * map_product 를 읽어 매칭 사전을 만든다.
 *  - alias: 정규화(원본 품목명) -> 표준 품목명
 *  - aliasStd: 정규화(표준 품목명) -> 표준 품목명 (표준명 자체로도 조각 해석)
 *  - units: 단품 행의 표준 품목명 목록 (번들 분해용 사전)
 *  - stdList: 드롭다운용 표준 품목명 유니크 목록
 *  - existing: 정규화(원본 품목명) 집합 (신규 판별용)
 *  - col / headerRow: 열 위치 정보
 */
function buildDictionaries_(mapSheet) {
  var values = mapSheet.getDataRange().getValues();
  if (!values.length) throw new Error('map_product 가 비어 있습니다.');

  var header = values[0];
  var col = {
    raw: header.indexOf(CONFIG.H_RAW),
    std: header.indexOf(CONFIG.H_STD),
    type: header.indexOf(CONFIG.H_TYPE),
    active: header.indexOf(CONFIG.H_ACTIVE),
    comp: header.indexOf(CONFIG.H_COMP),
    status: header.indexOf(CONFIG.H_STATUS)
  };
  if (col.raw < 0 || col.std < 0) {
    throw new Error('map_product 헤더에서 "' + CONFIG.H_RAW + '" 또는 "' + CONFIG.H_STD + '" 을 찾지 못했습니다.');
  }

  var alias = {}, aliasStd = {}, unitSet = {}, stdSet = {}, existing = {};
  for (var r = 1; r < values.length; r++) {
    var raw = String(values[r][col.raw] || '').trim();
    if (!raw) continue;
    var std = String(values[r][col.std] || '').trim();
    var type = col.type >= 0 ? String(values[r][col.type] || '').trim() : '';

    var keyRaw = normalize_(raw);
    existing[keyRaw] = true;
    if (std) {
      if (!alias[keyRaw]) alias[keyRaw] = std;
      var keyStd = normalize_(std);
      if (!aliasStd[keyStd]) aliasStd[keyStd] = std;
      stdSet[std] = true;
      if (type === '단품') unitSet[std] = true;
    }
  }

  return {
    alias: alias,
    aliasStd: aliasStd,
    units: unitSet,
    stdList: Object.keys(stdSet).sort(),
    existing: existing,
    col: col,
    lastRow: values.length // 1-based data 끝 (헤더 포함 행수)
  };
}

/* ===================== 신규 품목 감지 ===================== */

function findNewItems_(ss, dict) {
  var sheet = ss.getSheetByName(CONFIG.ORDERS_SHEET);
  if (!sheet) throw new Error('탭 "' + CONFIG.ORDERS_SHEET + '" 을 찾지 못했습니다.');
  var values = sheet.getDataRange().getValues();
  if (!values.length) return [];

  var header = values[0];
  var iName = header.indexOf(CONFIG.ORDERS_ITEM_HEADER);
  var iDate = header.indexOf(CONFIG.ORDERS_DATE_HEADER);
  var iNo = header.indexOf('주문번호');
  if (iName < 0) throw new Error('raw_orders 에서 "' + CONFIG.ORDERS_ITEM_HEADER + '" 헤더를 찾지 못했습니다.');

  var since = CONFIG.SINCE_DATE ? parseDate_(CONFIG.SINCE_DATE) : null;
  var found = {};
  var order = []; // 발견 순서 유지

  for (var r = 1; r < values.length; r++) {
    var name = String(values[r][iName] || '').trim();
    if (!name) continue;
    var d = iDate >= 0 ? parseDate_(values[r][iDate]) : null;
    if (since && d && d < since) continue;

    var key = normalize_(name);
    if (!key || dict.existing[key]) continue;

    if (!found[key]) {
      found[key] = { display: name, count: 0, latest: null, examples: [] };
      order.push(key);
    }
    var f = found[key];
    f.count++;
    if (d && (!f.latest || d > f.latest)) f.latest = d;
    if (f.examples.length < CONFIG.EXAMPLES_PER_ITEM && iNo >= 0) {
      f.examples.push(String(values[r][iNo]));
    }
  }
  return order.map(function (k) { return found[k]; });
}

/* ===================== 자동 매칭 엔진 ===================== */

/**
 * 매칭 규칙 (우선순위 순)
 *  1. 정규화 완전일치 (원본/표준 사전)          → 자동
 *  2. 대괄호 태그 제거 후 완전일치               → 자동
 *  3. 번들 분해: " + " 로 쪼개 전 조각 해석 성공  → 자동 (구성단품 기입)
 *  4. 부분 일치 후보                            → 검토
 *  5. 실패                                      → 미매핑
 */
function matchItem_(name, dict) {
  // 1. 완전일치
  var direct = lookupPiece_(name, dict);
  if (direct) {
    return { standard: direct, type: dict.units[direct] ? '단품' : '세트', components: componentsFor_(direct, dict), status: CONFIG.STATUS_AUTO };
  }

  // 3. 번들 분해
  var pieces = name.split(/\s*\+\s*/);
  if (pieces.length > 1) {
    var comps = [];
    var ok = true;
    for (var i = 0; i < pieces.length; i++) {
      var parsed = parsePiece_(pieces[i]);
      var std = lookupPiece_(parsed.name, dict);
      if (!std) { ok = false; break; }
      for (var n = 0; n < parsed.ea; n++) comps.push(std);
    }
    if (ok) {
      return { standard: name, type: '세트', components: comps, status: CONFIG.STATUS_AUTO };
    }
  } else {
    // 단일 품목인데 (NEA) 수량 표기가 붙은 경우: "고구마빵(4개입) (2EA)"
    var single = parsePiece_(name);
    if (single.ea > 1) {
      var stdS = lookupPiece_(single.name, dict);
      if (stdS) {
        var compsS = [];
        for (var m = 0; m < single.ea; m++) compsS.push(stdS);
        return { standard: stdS + ' * ' + single.ea, type: '세트', components: compsS, status: CONFIG.STATUS_AUTO };
      }
    }
  }

  // 4. 부분 일치 (포함 관계) — 후보를 찾아 검토 상태로
  var key = normalize_(stripTags_(name));
  var candidates = dict.stdList.filter(function (s) {
    var ks = normalize_(s);
    return ks && key && (key.indexOf(ks) >= 0 || ks.indexOf(key) >= 0);
  });
  if (candidates.length) {
    // 가장 긴(=구체적) 후보 우선
    candidates.sort(function (a, b) { return b.length - a.length; });
    return { standard: candidates[0], type: dict.units[candidates[0]] ? '단품' : '세트', components: [], status: CONFIG.STATUS_REVIEW };
  }

  // 5. 실패
  return { standard: '', type: '', components: [], status: CONFIG.STATUS_UNMAPPED };
}

/** 조각 하나를 사전에서 해석 (원본 alias → 표준 alias → 태그 제거 재시도) */
function lookupPiece_(name, dict) {
  var key = normalize_(name);
  if (dict.alias[key]) return dict.alias[key];
  if (dict.aliasStd[key]) return dict.aliasStd[key];
  var stripped = normalize_(stripTags_(name));
  if (stripped !== key) {
    if (dict.alias[stripped]) return dict.alias[stripped];
    if (dict.aliasStd[stripped]) return dict.aliasStd[stripped];
  }
  return null;
}

/** 표준명이 단품이면 자기 자신, 아니면 빈 배열(세트 구성은 알 수 없음) */
function componentsFor_(std, dict) {
  return dict.units[std] ? [std] : [];
}

/** "이름 (2EA)" / "(2EA) 이름" → {name, ea} */
function parsePiece_(s) {
  var ea = 1;
  var out = String(s).replace(/\(\s*(\d+)\s*EA\s*\)/i, function (_, n) { ea = Number(n) || 1; return ''; });
  return { name: out.trim(), ea: ea };
}

/** 선두의 대괄호 태그 제거: "[만월상회] 오리지널..." → "오리지널..." */
function stripTags_(s) {
  return String(s).replace(/\[[^\]]*\]/g, '').trim();
}

/* ===================== 시트 쓰기 ===================== */

function appendDraftRows_(mapSheet, dict, drafts) {
  if (!drafts.length) return;
  var width = mapSheet.getLastColumn();
  var startRow = mapSheet.getLastRow() + 1;

  var rows = drafts.map(function (d) {
    var row = new Array(width).fill('');
    row[dict.col.raw] = d.raw;
    row[dict.col.std] = d.std;
    if (dict.col.type >= 0) row[dict.col.type] = d.type;
    if (dict.col.active >= 0) row[dict.col.active] = 'Y';
    if (dict.col.comp >= 0) row[dict.col.comp] = d.comp;
    if (dict.col.status >= 0) row[dict.col.status] = d.status;
    return row;
  });

  mapSheet.getRange(startRow, 1, rows.length, width).setValues(rows);
  applyValidation_(mapSheet, dict, startRow, rows.length);
}

/** 신규 행의 표준 품목명/상품군 셀에 드롭다운 적용 */
function applyValidation_(mapSheet, dict, startRow, numRows) {
  if (dict.col.std >= 0 && dict.stdList.length) {
    var ruleStd = SpreadsheetApp.newDataValidation()
      .requireValueInList(dict.stdList, true)
      .setAllowInvalid(true) // 자동 기입된 신규 번들명(목록에 없음)이 오류 표시되지 않도록
      .setHelpText('기존 표준 품목명에서 선택하거나 새 이름을 입력하세요.')
      .build();
    mapSheet.getRange(startRow, dict.col.std + 1, numRows, 1).setDataValidation(ruleStd);
  }
  if (dict.col.type >= 0) {
    var ruleType = SpreadsheetApp.newDataValidation()
      .requireValueInList(['단품', '세트'], true)
      .setAllowInvalid(true)
      .build();
    mapSheet.getRange(startRow, dict.col.type + 1, numRows, 1).setDataValidation(ruleType);
  }
}

/* ===================== 메일 ===================== */

function sendReviewDigest_(review, totalAdded) {
  // 중복 발송 방지
  var props = PropertiesService.getScriptProperties();
  var alerted = {};
  try { alerted = JSON.parse(props.getProperty('alertedItems') || '{}'); } catch (e) { alerted = {}; }

  var fresh = review.filter(function (d) { return !alerted[normalize_(d.raw)]; });
  if (!fresh.length) return;

  fresh.sort(function (a, b) { return b.count - a.count; });
  var to = CONFIG.RECIPIENT || Session.getEffectiveUser().getEmail();
  var subject = '[OURBOX] SKU 매핑 검토 필요 ' + fresh.length + '건 (자동추가 총 ' + totalAdded + '건)';

  var lines = [];
  lines.push('신규 품목이 map_product 에 자동 추가되었습니다.');
  lines.push('아래 항목은 자동 확정하지 못해 검토가 필요합니다. 시트에서 드롭다운으로 표준 품목명을 선택해 주세요.');
  lines.push('');
  fresh.forEach(function (d, i) {
    lines.push((i + 1) + '. ' + d.raw);
    lines.push('   - 상태: ' + d.status + (d.std ? ' (추천: ' + d.std + ')' : ''));
    lines.push('   - 주문 ' + d.count + '건' + (d.latest ? ' / 최근 ' + formatDate_(d.latest) : '') +
      (d.examples.length ? ' / 예시 ' + d.examples.join(', ') : ''));
  });
  lines.push('');
  lines.push('map_product 바로가기:');
  lines.push('https://docs.google.com/spreadsheets/d/' + CONFIG.SPREADSHEET_ID + '/edit');
  lines.push('');
  lines.push('— 자동 알림 (sku-mapping-assistant)');

  MailApp.sendEmail(to, subject, lines.join('\n'));

  fresh.forEach(function (d) { alerted[normalize_(d.raw)] = new Date().toISOString(); });
  props.setProperty('alertedItems', JSON.stringify(alerted));
}

/* ===================== onEdit 자동완성 ===================== */

/**
 * map_product 에서 "표준 품목명" 셀이 편집되는 순간(드롭다운 선택 포함),
 * 구성단품/상품군을 자동으로 채운다.
 *  - 구성단품이 이미 입력돼 있으면 절대 덮어쓰지 않음
 *  - "A + B" / "A * 2" 패턴은 단품 사전으로 분해해 구성단품 기입, 상품군=세트
 *  - 알려진 단품이면 상품군=단품 (구성단품은 관례대로 비움)
 *  - 매핑상태가 ⚠️ 였으면 "✅ 수동확정" 으로 갱신 (원가 숫자는 건드리지 않음)
 */
function onMapEdit(e) {
  try {
    if (!e || !e.range) return;
    var sheet = e.range.getSheet();
    if (sheet.getName() !== CONFIG.MAP_SHEET) return;

    var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var col = {
      std: header.indexOf(CONFIG.H_STD),
      type: header.indexOf(CONFIG.H_TYPE),
      comp: header.indexOf(CONFIG.H_COMP),
      status: header.indexOf(CONFIG.H_STATUS)
    };
    if (col.std < 0) return;
    if (e.range.getColumn() !== col.std + 1 || e.range.getNumColumns() !== 1) return;

    var dict = buildDictionaries_(sheet);

    var startRow = e.range.getRow();
    for (var i = 0; i < e.range.getNumRows(); i++) {
      var row = startRow + i;
      if (row === 1) continue;
      autofillRow_(sheet, dict, col, row);
    }
  } catch (err) {
    Logger.log('onMapEdit 오류: ' + err.message);
  }
}

function autofillRow_(sheet, dict, col, row) {
  var std = String(sheet.getRange(row, col.std + 1).getValue()).trim();
  if (!std) return;

  // 구성단품이 이미 있으면 건드리지 않음
  if (col.comp >= 0 && String(sheet.getRange(row, col.comp + 1).getValue()).trim()) return;

  var comps = decomposeStandard_(std, dict);
  if (comps === null) return; // 해석 불가 — 사람이 마저 입력

  var isSet = comps.length > 1;
  if (col.comp >= 0 && isSet) sheet.getRange(row, col.comp + 1).setValue(comps.join(','));
  if (col.type >= 0 && !String(sheet.getRange(row, col.type + 1).getValue()).trim()) {
    sheet.getRange(row, col.type + 1).setValue(isSet ? '세트' : '단품');
  }
  if (col.status >= 0) {
    var status = String(sheet.getRange(row, col.status + 1).getValue()).trim();
    if (status.indexOf('⚠️') >= 0) sheet.getRange(row, col.status + 1).setValue('✅ 수동확정');
  }
}

/**
 * 표준 품목명을 단품 구성으로 분해.
 *  - "A + B"      → [A표준, B표준]
 *  - "A * 3"      → [A표준, A표준, A표준]
 *  - 알려진 단품   → [자기 자신]
 *  - 해석 불가     → null
 */
function decomposeStandard_(std, dict) {
  // "X * N" 반복 패턴
  var mult = std.match(/^(.*?)\s*[\*xX×]\s*(\d+)\s*$/);
  if (mult) {
    var base = lookupPiece_(mult[1], dict);
    if (!base) return null;
    var n = Math.max(1, Number(mult[2]) || 1);
    var reps = [];
    for (var i = 0; i < n; i++) reps.push(base);
    return reps;
  }

  // "A + B" 번들 패턴
  var pieces = std.split(/\s*\+\s*/);
  if (pieces.length > 1) {
    var comps = [];
    for (var p = 0; p < pieces.length; p++) {
      var parsed = parsePiece_(pieces[p]);
      var unit = lookupPiece_(parsed.name, dict);
      if (!unit) return null;
      for (var q = 0; q < parsed.ea; q++) comps.push(unit);
    }
    return comps;
  }

  // 단일 품목
  var single = lookupPiece_(std, dict);
  return single ? [single] : null;
}

/* ===================== 주문 유입 정체 감시 ===================== */

/**
 * raw_orders 의 최신 주문일시가 STALE_DAYS 이상 오래됐으면 경고 메일.
 * (매핑이 아니라 "주문 데이터 유입"이 멈춘 것을 조기에 알리는 watchdog.
 *  같은 날 중복 발송하지 않음.)
 */
function checkStaleness_(ss) {
  if (!CONFIG.STALE_DAYS) return;
  var sheet = ss.getSheetByName(CONFIG.ORDERS_SHEET);
  if (!sheet) return;
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return;

  var iDate = values[0].indexOf(CONFIG.ORDERS_DATE_HEADER);
  if (iDate < 0) return;

  var latest = null;
  for (var r = 1; r < values.length; r++) {
    var d = parseDate_(values[r][iDate]);
    if (d && (!latest || d > latest)) latest = d;
  }
  if (!latest) return;

  var days = Math.floor((new Date() - latest) / 86400000);
  if (days < CONFIG.STALE_DAYS) return;

  var props = PropertiesService.getScriptProperties();
  var todayKey = formatDate_(new Date());
  if (props.getProperty('staleAlertDate') === todayKey) return; // 오늘 이미 발송

  var to = CONFIG.RECIPIENT || Session.getEffectiveUser().getEmail();
  var subject = '[OURBOX] ⚠️ 주문 데이터가 ' + days + '일째 멈춰 있습니다';
  var body = [
    'raw_orders 의 최신 주문일시가 ' + formatDate_(latest) + ' 입니다. (' + days + '일 경과)',
    '',
    '주문 수집(엑셀 붙여넣기 또는 자동 유입)이 중단된 것으로 보입니다.',
    '주문이 들어오지 않으면 SKU 매핑/재고 차감 계산도 모두 멈춥니다.',
    '',
    '시트 바로가기:',
    'https://docs.google.com/spreadsheets/d/' + CONFIG.SPREADSHEET_ID + '/edit',
    '',
    '— 자동 알림 (sku-mapping-assistant / 정체 감시)'
  ].join('\n');
  MailApp.sendEmail(to, subject, body);
  props.setProperty('staleAlertDate', todayKey);
  Logger.log('정체 경고 발송: 최신 주문 ' + formatDate_(latest) + ' (' + days + '일 경과)');
}

/* ===================== 유틸 ===================== */

function normalize_(s) {
  if (s === '' || s == null) return '';
  return String(s)
    .toLowerCase()
    .replace(/\(\s*1\s*EA\s*\)/gi, '') // (1EA) 는 의미 없으므로 제거
    .replace(/[\s()\[\]（）【】.*]/g, '')
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
