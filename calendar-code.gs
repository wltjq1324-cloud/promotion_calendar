/**
 * OURBOX 프로모션 운영 캘린더 API
 * v2.1 (2026-05-20)
 *
 * 엔드포인트:
 *   GET  ?action=load&role=edit|view|ext
 *   POST action=upsert     프로모션 등록·수정
 *   POST action=delete     프로모션 삭제
 *
 * v2.1 변경:
 *   - loadAll 응답에 outbound(SKU별 7/14/30일 출고량) 포함
 *   - imp_출고요약 탭(대시보드 출고요약 IMPORTRANGE)을 readOutbound_로 읽음
 */

// ================= 설정 =================
const SHEET_ID = '1FGxRu59DL7SMB4siYE_IZiTU5rNrHWefIeI9e_Hqazs';
const SHEETS = {
  PROMOTIONS: '프로모션',
  PRODUCTS:   '상품',
  CHANNELS:   '채널',
  OWNERS:     '담당자'
};

// 대시보드 '출고요약'을 IMPORTRANGE로 가져오는 탭 (헤더 1행 + 데이터)
const OUTBOUND_SHEET = 'imp_출고요약';

// 외부 권한자(ext)에게 가릴 필드
const EXT_HIDDEN_FIELDS = ['channel', 'owner', 'memo', 'updated_by'];

// ================= 진입점 =================
function doGet(e) {
  try {
    const role = (e.parameter.role || 'view').toLowerCase();
    const action = e.parameter.action || 'load';
    let result;
    if (action === 'load') {
      result = loadAll(role);
    } else {
      result = { error: 'Unknown action: ' + action };
    }
    return jsonOut(result);
  } catch (err) {
    return jsonOut({ error: err.toString() });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    const role = (body.role || 'view').toLowerCase();
    let result;

    if (role !== 'edit') {
      return jsonOut({ error: 'permission_denied' });
    }

    if (action === 'upsert') {
      result = upsertPromotion(body.data);
    } else if (action === 'delete') {
      result = deletePromotion(body.id);
    } else {
      result = { error: 'Unknown action: ' + action };
    }
    return jsonOut(result);
  } catch (err) {
    return jsonOut({ error: err.toString() });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ================= 시트 헬퍼 =================
function readSheet(sheetName) {
  const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(sheetName);
  if (!sh) throw new Error('Sheet not found: ' + sheetName);
  const values = sh.getDataRange().getValues();
  if (values.length < 3) return [];
  const keys = values[1];
  const rows = values.slice(2);
  return rows
    .filter(r => r.some(c => c !== '' && c !== null))
    .map(r => {
      const obj = {};
      keys.forEach((k, i) => { if (k) obj[k] = r[i]; });
      return obj;
    });
}

function getSheet(name) {
  return SpreadsheetApp.openById(SHEET_ID).getSheetByName(name);
}

function isActive(v) {
  return v === true || v === 'TRUE' || v === 'true' || v === 1;
}

// imp_출고요약 탭을 읽어 SKU별 출고량을 반환.
// 이 탭은 IMPORTRANGE 결과라 1행=헤더(product_code,상품명,d7,d14,d30,기준일,갱신시각),
// 2행 이하=데이터 구조다. (readSheet의 1행 라벨/2행 키 규칙과 다름)
function readOutbound_() {
  const empty = { items: [], anchorDate: '', updatedAt: '' };
  const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(OUTBOUND_SHEET);
  if (!sh) return empty;
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return empty;

  const items = [];
  let anchorDate = '';
  let updatedAt = '';
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    const code = String(r[0] || '').trim();
    if (!code) continue;
    items.push({
      product_code: code,
      name: String(r[1] || ''),
      d7: Number(r[2]) || 0,
      d14: Number(r[3]) || 0,
      d30: Number(r[4]) || 0
    });
    if (r[5]) anchorDate = String(r[5]);
    if (r[6]) updatedAt = String(r[6]);
  }
  return { items: items, anchorDate: anchorDate, updatedAt: updatedAt };
}

// ================= 데이터 로드 =================
function loadAll(role) {
  const promotions = readSheet(SHEETS.PROMOTIONS).map(p => normalizePromotion(p));
  const products = readSheet(SHEETS.PRODUCTS).filter(r => isActive(r.active));
  const channels   = readSheet(SHEETS.CHANNELS).filter(r => isActive(r.active));
  const allOwners  = readSheet(SHEETS.OWNERS).filter(r => isActive(r.active));
  const owners     = role === 'ext'
    ? allOwners.filter(r => isActive(r.external))
    : allOwners;

  let finalPromotions = promotions;
  if (role === 'ext') {
    finalPromotions = promotions.map(p => maskForExternal(p));
  }

  return {
    role: role,
    promotions: finalPromotions,
    products: products.map(r => ({ name: r.name, price: Number(r.price) || 0 })),
    channels: role === 'ext' ? [] : channels.map(r => r.name),
    owners:   owners.map(r => r.name),
    outbound: role === 'ext'
      ? { items: [], anchorDate: '', updatedAt: '' }
      : readOutbound_(),
    server_time: new Date().toISOString()
  };
}

function normalizePromotion(p) {
  return {
    id: String(p.id || ''),
    title: String(p.title || ''),
    start_date: toDateStr(p.start_date),
    end_date: toDateStr(p.end_date),
    product_name: String(p.product_name || ''),
    channel: String(p.channel || ''),
    expected_qty_tier: String(p.expected_qty_tier || ''),
    owner: String(p.owner || ''),
    memo: String(p.memo || ''),
    updated_at: toDateTimeStr(p.updated_at),
    updated_by: String(p.updated_by || '')
  };
}

function maskForExternal(p) {
  const masked = Object.assign({}, p);
  EXT_HIDDEN_FIELDS.forEach(f => { masked[f] = ''; });
  return masked;
}

// ================= 프로모션 CRUD =================
function upsertPromotion(data) {
  const sh = getSheet(SHEETS.PROMOTIONS);
  const all = readSheet(SHEETS.PROMOTIONS);
  const now = formatNow();
  const user = data.updated_by || 'unknown';

  if (!data.id) data.id = 'p' + new Date().getTime();

  const idx = all.findIndex(r => String(r.id) === String(data.id));
  const keys = sh.getRange(2, 1, 1, sh.getLastColumn()).getValues()[0];
  const row = keys.map(k => {
    if (k === 'updated_at') return now;
    if (k === 'updated_by') return user;
    return data[k] !== undefined ? data[k] : '';
  });

  if (idx === -1) {
    sh.appendRow(row);
  } else {
    sh.getRange(idx + 3, 1, 1, row.length).setValues([row]);
  }
  return { ok: true, id: data.id, mode: idx === -1 ? 'insert' : 'update' };
}

function deletePromotion(id) {
  const sh = getSheet(SHEETS.PROMOTIONS);
  const all = readSheet(SHEETS.PROMOTIONS);
  const idx = all.findIndex(r => String(r.id) === String(id));
  if (idx === -1) return { ok: false, error: 'not_found' };
  sh.deleteRow(idx + 3);
  return { ok: true, id: id };
}

// ================= 유틸 =================
function toDateStr(v) {
  if (!v) return '';
  try {
    const formatted = Utilities.formatDate(new Date(v), 'Asia/Seoul', 'yyyy-MM-dd');
    if (formatted && formatted.match(/^\d{4}-\d{2}-\d{2}$/)) return formatted;
  } catch (e) {}
  return String(v);
}

function toDateTimeStr(v) {
  if (!v) return '';
  try {
    const formatted = Utilities.formatDate(new Date(v), 'Asia/Seoul', 'yyyy-MM-dd HH:mm');
    if (formatted && formatted.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)) return formatted;
  } catch (e) {}
  return String(v);
}

function formatNow() {
  return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm');
}

// ================= 테스트 =================
function testLoad() {
  Logger.log(JSON.stringify(loadAll('edit'), null, 2));
}
