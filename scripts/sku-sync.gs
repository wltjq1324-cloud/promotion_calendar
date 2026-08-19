/**
 * sku_mapping 자동 동기화 (Google Apps Script) — /inven 미매핑 해소용
 * ------------------------------------------------------------------
 * 무엇을 하나
 *   velocity_cache 탭(출고 집계)에 있는 상품 중 sku_mapping 에 없는 것을 찾아
 *   재고 상품명과 자동으로 연결한 뒤 sku_mapping 하단에 추가한다.
 *
 *   - 단품 완전일치        → 자동 (needs_review FALSE)
 *   - "A + B" 묶음 분해    → 자동 (needs_review TRUE)
 *   - "(2EA)" 반복        → 자동 (수량만큼 슬롯 반복)
 *   - "[만월상회]" 등 태그  → 태그 제거 후 재시도
 *   - 실패                → 재고상품명 비움 + 드롭다운 제공 (사람이 클릭 선택)
 *
 * 사용법
 *   1) 이 파일을 Apps Script 에 새 스크립트 파일로 추가
 *   2) setupSkuSync 실행 → 매일 오전 8시 10분 자동 실행 등록 + 즉시 1회 실행
 *   수동 실행은 syncSkuMapping.
 *
 * 안전: sku_mapping 기존 행은 수정/삭제하지 않고 아래에 추가만 한다(append-only).
 * 선행 조건: velocityCache.gs 의 rebuildVelocityCache 가 먼저 돌아 있어야 한다.
 */

var SK = {
  SS_ID: '1FGxRu59DL7SMB4siYE_IZiTU5rNrHWefIeI9e_Hqazs', // OURBOX_프로모션_운영_DB
  MAP_SHEET: 'sku_mapping',
  VELOCITY_SHEET: 'velocity_cache',
  INVENTORY_URL: 'https://wltjq1324-cloud.github.io/promotion_calendar/inventory-latest.json',
  SLOTS: 6, // inventory_product_name_1~6
  RECIPIENT: 'wltjq1324@gmail.com'
};

/** 최초 1회: 매일 자동 실행 등록 + 즉시 1회 실행 */
function setupSkuSync() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncSkuMapping') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncSkuMapping').timeBased().everyDays(1).atHour(8).nearMinute(10).create();
  return syncSkuMapping();
}

function syncSkuMapping() {
  var ss = SpreadsheetApp.openById(SK.SS_ID);
  var map = ss.getSheetByName(SK.MAP_SHEET);
  var vel = ss.getSheetByName(SK.VELOCITY_SHEET);
  if (!map) throw new Error('탭 "' + SK.MAP_SHEET + '" 을 찾지 못했습니다.');
  if (!vel) throw new Error('탭 "' + SK.VELOCITY_SHEET + '" 이 없습니다. rebuildVelocityCache 를 먼저 실행하세요.');

  // 1) 출고된 상품 목록 (velocity_cache: date, product, qty)
  var v = vel.getDataRange().getValues();
  var vh = v[0] || [], iP = vh.indexOf('product'), iQ = vh.indexOf('qty');
  if (iP < 0) throw new Error('velocity_cache 형식이 올바르지 않습니다.');
  var shipped = {};
  for (var i = 1; i < v.length; i++) {
    var nm = String(v[i][iP] == null ? '' : v[i][iP]).trim();
    if (!nm) continue;
    if (!shipped[nm]) shipped[nm] = 0;
    shipped[nm] += iQ >= 0 ? (Number(v[i][iQ]) || 0) : 0;
  }

  // 2) sku_mapping 현황: 이미 있는 상품 + 단품 사전
  var m = map.getDataRange().getValues();
  var mh = m[0] || [];
  var col = {
    gen: mh.indexOf('generated_at'), latest: mh.indexOf('dashboard_latest_date'),
    dash: mh.indexOf('dashboard_product'), std: mh.indexOf('standard_product_name'),
    type: mh.indexOf('product_type'), inv1: mh.indexOf('inventory_product_name_1'),
    match: mh.indexOf('match_type'), conf: mh.indexOf('confidence'), review: mh.indexOf('needs_review')
  };
  if (col.dash < 0 || col.inv1 < 0) throw new Error('sku_mapping 헤더를 찾지 못했습니다.');

  var known = {}, dict = {};
  for (var r = 1; r < m.length; r++) {
    var dp = String(m[r][col.dash] || '').trim();
    if (!dp || dp === '대시보드 상품명(원문)') continue;
    known[skNorm(dp)] = true;
    var n1 = String(m[r][col.inv1] || '').trim();
    var n2 = String(m[r][col.inv1 + 1] || '').trim();
    if (n1 && !n2) { // 단품 매핑만 사전에 등록
      dict[skNorm(dp)] = n1;
      var sp = col.std >= 0 ? String(m[r][col.std] || '').trim() : '';
      if (sp) dict[skNorm(sp)] = n1;
    }
  }

  // 3) 재고 상품명 (매칭 후보 + 드롭다운 목록)
  var invNames = skInventoryNames();
  var invMap = {};
  invNames.forEach(function (n) { if (!invMap[skNorm(n)]) invMap[skNorm(n)] = n; });

  // 4) 신규만 골라 매칭
  var news = Object.keys(shipped).filter(function (n) { return !known[skNorm(n)]; });
  if (!news.length) { Logger.log('sku_mapping: 신규 상품 없음.'); return 'sku_mapping: 신규 상품 없음.'; }
  news.sort(function (a, b) { return shipped[b] - shipped[a]; });

  var now = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
  var today = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
  var width = map.getLastColumn(), rows = [], todo = [];

  news.forEach(function (name) {
    var res = skMatch(name, dict, invMap);
    var row = [];
    for (var c = 0; c < width; c++) row.push('');
    if (col.gen >= 0) row[col.gen] = now;
    if (col.latest >= 0) row[col.latest] = today;
    row[col.dash] = name;
    if (col.std >= 0) row[col.std] = res.standard;
    if (col.type >= 0) row[col.type] = res.type;
    for (var k = 0; k < Math.min(res.names.length, SK.SLOTS); k++) row[col.inv1 + k] = res.names[k];
    if (col.match >= 0) row[col.match] = res.matchType;
    if (col.conf >= 0) row[col.conf] = res.confidence;
    if (col.review >= 0) row[col.review] = res.review ? 'TRUE' : 'FALSE';
    rows.push(row);
    if (res.matchType === 'unmapped') todo.push({ name: name, qty: shipped[name] });
  });

  var start = map.getLastRow() + 1;
  map.getRange(start, 1, rows.length, width).setValues(rows);

  // 재고상품명 칸에 드롭다운 (미매핑 행을 클릭만으로 채울 수 있게)
  if (invNames.length) {
    var rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(invNames.slice().sort(), true).setAllowInvalid(true)
      .setHelpText('재고 상품명에서 선택하세요.').build();
    map.getRange(start, col.inv1 + 1, rows.length, SK.SLOTS).setDataValidation(rule);
  }

  if (todo.length) skMail(todo, rows.length);
  var msg = 'sku_mapping: ' + rows.length + '행 추가 (자동 ' + (rows.length - todo.length) + ' / 수동선택 필요 ' + todo.length + ')';
  Logger.log(msg);
  return msg;
}

/** 재고 JSON 에서 상품명 목록 */
function skInventoryNames() {
  var res = UrlFetchApp.fetch(SK.INVENTORY_URL + '?t=' + new Date().getTime(), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('재고 JSON HTTP ' + res.getResponseCode());
  var items = (JSON.parse(res.getContentText()).items) || [];
  var seen = {}, out = [];
  items.forEach(function (it) {
    var n = String(it.product_name || '').trim();
    if (n && !seen[n]) { seen[n] = true; out.push(n); }
  });
  return out;
}

/** 출고 상품명 → 재고상품명 슬롯 */
function skMatch(name, dict, invMap) {
  function unit(piece) {
    var k = skNorm(piece);
    if (dict[k]) return dict[k];
    if (invMap[k]) return invMap[k];
    var s = skNorm(skStripTags(piece));
    if (dict[s]) return dict[s];
    if (invMap[s]) return invMap[s];
    return null;
  }
  function rep(v, n) { var a = []; for (var i = 0; i < n; i++) a.push(v); return a; }

  // "A + B" 묶음
  var pieces = name.split(/\s*\+\s*/);
  if (pieces.length > 1) {
    var comps = [];
    for (var p = 0; p < pieces.length; p++) {
      var pp = skEa(pieces[p]);
      var u = unit(pp.name);
      if (!u) { comps = null; break; }
      comps = comps.concat(rep(u, pp.ea));
    }
    if (comps) return { standard: name, type: '세트', names: comps, matchType: 'auto_bundle', confidence: 'high', review: true };
  } else {
    var one = skEa(name);
    var u1 = unit(one.name);
    if (u1) {
      if (one.ea > 1) {
        return { standard: one.name + ' * ' + one.ea, type: '세트', names: rep(u1, one.ea), matchType: 'auto_multiple', confidence: 'high', review: true };
      }
      return { standard: name, type: '단품', names: [u1], matchType: 'auto_alias', confidence: 'high', review: false };
    }
  }
  return { standard: name, type: '', names: [], matchType: 'unmapped', confidence: 'low', review: true };
}

/** "이름 (2EA)" / "(4EA) 이름" → {name, ea} */
function skEa(s) {
  var ea = 1;
  var out = String(s).replace(/\(\s*(\d+)\s*EA\s*\)/i, function (_, n) { ea = Number(n) || 1; return ' '; });
  return { name: out.trim(), ea: ea };
}

/** "[만월상회] 오리지널..." → "오리지널..." (재고에 실제로 있는 [굿즈] 등은 먼저 원본으로 시도한다) */
function skStripTags(s) { return String(s).replace(/\[[^\]]*\]/g, ' ').trim(); }

/** 표기 차이를 없애는 정규화 */
function skNorm(s) {
  if (s === '' || s == null) return '';
  return String(s).toLowerCase()
    .replace(/\(\s*1\s*ea\s*\)/gi, '')
    .replace(/[\s()\[\]（）【】.,*]/g, '')
    .trim();
}

/** 수동 선택이 필요한 건만 메일 (중복 발송 방지) */
function skMail(todo, added) {
  var props = PropertiesService.getScriptProperties();
  var sent = {};
  try { sent = JSON.parse(props.getProperty('skSent') || '{}'); } catch (e) { sent = {}; }
  var fresh = todo.filter(function (t) { return !sent[skNorm(t.name)]; });
  if (!fresh.length) return;

  var lines = ['sku_mapping 에 신규 상품 ' + added + '행이 자동 추가되었습니다.',
    '아래 ' + fresh.length + '건은 자동 연결에 실패했습니다. 시트에서 재고상품명을 드롭다운으로 선택해 주세요.', ''];
  fresh.forEach(function (t, i) { lines.push((i + 1) + '. ' + t.name + ' (최근 30일 출고 ' + t.qty + '개)'); });
  lines.push('', 'https://docs.google.com/spreadsheets/d/' + SK.SS_ID + '/edit', '', '— 자동 알림 (sku-sync)');
  MailApp.sendEmail(SK.RECIPIENT || Session.getEffectiveUser().getEmail(),
    '[OURBOX] 재고 페이지 미매핑 ' + fresh.length + '건', lines.join('\n'));

  fresh.forEach(function (t) { sent[skNorm(t.name)] = new Date().toISOString(); });
  props.setProperty('skSent', JSON.stringify(sent));
}
