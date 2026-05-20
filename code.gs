// ============================================================
// 아워박스 MVP 대시보드 — Apps Script v3.5
// ============================================================
// v3.3 유지:
//   - map_channel E열 "담당자" 읽기
//   - 가공_데이터 17열 "담당자" 추가
//   - JSON orders에 manager 필드 포함
//
// v3.4 유지:
//   - 기본 doGet()은 기존 orders 응답 유지
//   - 새 대시보드만 ?mode=cache로 dashboard_cache 요약 응답 사용
//   - refreshProcessedData() 실행 시 dashboard_cache 숨김 시트 함께 갱신(단일 버튼)
//
// v3.5 변경:
//   - 성능: writeDashboardCache_의 autoResizeColumns 제거(거대 json 셀로 수 분 소요)
//   - 성능: setValuesChunked_ 청크마다의 flush 제거
//   - 성능: updateMappingStatus 행별 setNumberFormat → 1회 일괄 적용
//   - 안정성: refreshProcessedData를 LockService로 보호(동시 실행 방지)
//   - UX: 메뉴 실행 결과를 alert로 표시(notifyUser_)
//   - 장기 누적: 행 수가 임계치를 넘으면 경고 메시지 표시
// ============================================================

// 가공_데이터 행 수가 이 값을 넘으면 갱신 완료 메시지에 경고를 덧붙입니다.
var ROW_WARN_THRESHOLD = 150000;

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('📊 아워박스')
    .addItem('🔄 가공_데이터 갱신', 'refreshProcessedData')
    .addItem('⚡ 대시보드 캐시만 갱신', 'refreshDashboardCacheMenu')
    .addItem('📋 테스트: 데이터 확인', 'testGetData')
    .addToUi();
}

function doGet(e) {
  try {
    var params = (e && e.parameter) ? e.parameter : {};
    var data;

    // 기존 대시보드 호환성을 위해 기본값은 기존 전체 orders 응답으로 유지합니다.
    // 새 HTML에서만 ?mode=cache를 붙여 요약 캐시를 받습니다.
    if (params.mode === 'cache') {
      data = getDashboardCache();
    } else {
      data = getProcessedData();
    }

    return ContentService.createTextOutput(JSON.stringify(data))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      error: true,
      message: err.message
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

// 메뉴 실행 결과를 사용자에게 표시합니다.
// UI가 없는 컨텍스트(시간 기반 트리거 등)에서는 alert가 실패하므로 무시합니다.
function notifyUser_(msg) {
  Logger.log(msg);
  try {
    SpreadsheetApp.getUi().alert(msg);
  } catch (err) {
    // UI 컨텍스트 없음 — 로그만 남깁니다.
  }
}

// ============================================================
// 가공_데이터 자동 생성/갱신
// ============================================================
function refreshProcessedData() {
  // 동시 실행 방지: 갱신 중 재실행하면 깨진 시트가 노출될 수 있습니다.
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(2000)) {
    notifyUser_('⚠️ 이미 갱신이 진행 중입니다. 잠시 후 다시 시도해주세요.');
    return;
  }

  try {
    var msg = refreshProcessedDataCore_();
    notifyUser_(msg);
  } catch (err) {
    notifyUser_('❌ 가공_데이터 갱신 실패\n\n' + err.message);
    throw err;
  } finally {
    lock.releaseLock();
  }
}

function refreshProcessedDataCore_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var rawSheet = ss.getSheetByName('raw_orders');
  if (!rawSheet || rawSheet.getLastRow() < 2) {
    throw new Error('raw_orders 시트가 비어있습니다.');
  }

  var rawData = rawSheet.getRange(2, 1, rawSheet.getLastRow() - 1, 7).getValues();

  // 1. 새 품목 자동 추가
  var newItems = autoAddNewItems(ss, rawData);

  // 2. 매핑 테이블 로드
  var chMap = loadChannelMap(ss);
  var prMap = loadProductMap(ss);
  var costMap = loadCostMap(ss);
  var shipCost = loadShipCost(ss);

  // 3. 매핑상태/원가 열 업데이트
  updateMappingStatus(ss, costMap);

  // 4. 가공 데이터 생성
  var headers = [
    '주문번호', '품목명', '수량', '실결제금액', '배송비(고객)', '쇼핑몰명', '주문일시',
    '주문일', '채널그룹', '표준품목명', '상품군', '수수료율', '정산액',
    '상품원가', '출고배송비', '마진', '담당자'
  ];
  var rows = [];

  for (var i = 0; i < rawData.length; i++) {
    var raw = rawData[i];
    var orderId = String(raw[0]).trim();
    var itemName = String(raw[1]).trim();
    var qty = Number(raw[2]) || 0;
    var revenue = Number(raw[3]) || 0;
    var shipCustomer = Number(raw[4]) || 0;
    var shopName = String(raw[5]).trim();
    var dtRaw = raw[6];
    if (!orderId && !itemName) continue;

    var dtStr = parseAnyDate(dtRaw);
    var dateStr = dtStr ? dtStr.substring(0, 10) : '';
    var chInfo = chMap[shopName] || { group: '미매핑', fee: 0, manager: '미지정' };
    var prInfo = prMap[itemName] || { std: '미매핑', cat: '미매핑', parts: '' };
    var settlement = Math.round(revenue * (1 - chInfo.fee));
    var unitCost = calcProductCost(prInfo.std, prInfo.parts, costMap, qty);
    var manager = chInfo.manager || '미지정';

    rows.push([
      orderId, itemName, qty, revenue, shipCustomer, shopName, dtStr, dateStr,
      chInfo.group, prInfo.std, prInfo.cat, chInfo.fee, settlement, unitCost,
      0, 0, manager
    ]);
  }

  // 5. 배송비: 주문번호 기준 첫 행에만
  var seenOrders = {};
  for (var j = 0; j < rows.length; j++) {
    var oid = rows[j][0];
    if (oid && !seenOrders[oid]) {
      seenOrders[oid] = true;
      rows[j][14] = shipCost;
    }
    rows[j][15] = rows[j][12] - (rows[j][13] + rows[j][14]);
  }

  // 6. 시트 쓰기
  var procSheet = ss.getSheetByName('가공_데이터');
  if (!procSheet) {
    procSheet = ss.insertSheet('가공_데이터');
  } else {
    if (procSheet.getFilter()) procSheet.getFilter().remove();
    procSheet.clear();
  }

  procSheet.getRange(1, 1, 1, headers.length)
    .setValues([headers])
    .setFontWeight('bold')
    .setBackground('#1F2937')
    .setFontColor('#FFFFFF');

  if (rows.length > 0) {
    setValuesChunked_(procSheet, 2, 1, rows, 4000);
    procSheet.getRange(2, 4, rows.length, 1).setNumberFormat('#,##0');
    procSheet.getRange(2, 12, rows.length, 1).setNumberFormat('0.0%');
    procSheet.getRange(2, 13, rows.length, 1).setNumberFormat('#,##0');
    procSheet.getRange(2, 14, rows.length, 1).setNumberFormat('#,##0');
    procSheet.getRange(2, 15, rows.length, 1).setNumberFormat('#,##0');
    procSheet.getRange(2, 16, rows.length, 1).setNumberFormat('#,##0');
    procSheet.getRange(1, 1, rows.length + 1, headers.length).createFilter();
  }

  SpreadsheetApp.flush();

  // 7. 새 대시보드용 요약 캐시 생성 (단일 버튼 — 가공+캐시 항상 함께)
  var cacheStats = refreshDashboardCache(ss, rows);

  var distinctOrders = Object.keys(seenOrders).length;
  var msg = '✅ 가공_데이터 갱신 완료!\n\n' +
    '처리 행 수: ' + rows.length + '건\n' +
    '고유 주문 수: ' + distinctOrders + '건\n' +
    '요약 캐시: base ' + cacheStats.baseRows +
    ' / product ' + cacheStats.productRows +
    ' / quality ' + cacheStats.qualityRows + '행\n';

  if (newItems.length > 0) {
    var previewItems = newItems.slice(0, 20);
    msg += '\n⚠️ 새로 추가된 품목 ' + newItems.length + '개:\n' + previewItems.join('\n');
    if (newItems.length > previewItems.length) {
      msg += '\n...외 ' + (newItems.length - previewItems.length) + '개';
    }
    msg += '\n\n→ map_product에서 표준품목명/상품군을 입력해주세요.';
  }

  if (rows.length > ROW_WARN_THRESHOLD) {
    msg += '\n\n⚠️ 행 수(' + rows.length + ')가 많아 갱신이 Apps Script 6분 제한에' +
      ' 근접할 수 있습니다.\n오래된 주문은 별도 시트로 분리(아카이브)를 검토하세요.';
  }

  msg += '\n\n갱신 시각: ' + new Date().toLocaleString('ko-KR');
  return msg;
}

// ============================================================
// 새 품목 자동 추가
// ============================================================
function autoAddNewItems(ss, rawData) {
  var prSheet = ss.getSheetByName('map_product');
  if (!prSheet) return [];

  var lastRow = prSheet.getLastRow();
  var existingItems = {};
  if (lastRow > 1) {
    var existing = prSheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < existing.length; i++) {
      var name = String(existing[i][0]).trim();
      if (name) existingItems[name] = true;
    }
  }

  var newItems = [];
  var seen = {};
  for (var j = 0; j < rawData.length; j++) {
    var itemName = String(rawData[j][1]).trim();
    if (!itemName || itemName === '-' || existingItems[itemName] || seen[itemName]) continue;
    seen[itemName] = true;
    newItems.push(itemName);
  }

  if (newItems.length > 0) {
    var newRows = newItems.map(function(name) {
      return [name, '', '', 'Y', ''];
    });
    prSheet.getRange(lastRow + 1, 1, newRows.length, 5).setValues(newRows);
    prSheet.getRange(lastRow + 1, 1, newRows.length, 5).setBackground('#FEF3C7');
  }

  return newItems;
}

// ============================================================
// 매핑상태/원가 열 업데이트
// ============================================================
function updateMappingStatus(ss, costMap) {
  var prSheet = ss.getSheetByName('map_product');
  if (!prSheet || prSheet.getLastRow() < 2) return;

  var lastRow = prSheet.getLastRow();
  prSheet.getRange('F1')
    .setValue('매핑상태/원가')
    .setFontWeight('bold')
    .setBackground('#1F2937')
    .setFontColor('#FFFFFF');

  var data = prSheet.getRange(2, 1, lastRow - 1, 5).getValues();
  var statusValues = [];

  for (var i = 0; i < data.length; i++) {
    var origName = String(data[i][0]).trim();
    var stdName = String(data[i][1]).trim();
    var parts = data[i][4] ? String(data[i][4]).trim() : '';

    if (!origName || origName === '-') {
      statusValues.push(['']);
      continue;
    }
    if (!stdName) {
      statusValues.push(['⚠️ 미매핑']);
      continue;
    }

    var cost = 0;
    if (parts && parts.length > 0) {
      var partList = parts.split(',');
      var allFound = true;
      for (var p = 0; p < partList.length; p++) {
        var partName = partList[p].trim();
        if (costMap[partName]) {
          cost += costMap[partName];
        } else {
          allFound = false;
        }
      }
      if (!allFound) {
        statusValues.push(['❌ 원가미등록 (구성단품)']);
        continue;
      }
    } else {
      cost = costMap[stdName] || 0;
    }

    if (cost > 0) {
      statusValues.push([cost]);
    } else {
      if (stdName.indexOf('*') >= 0) {
        var baseName = stdName.split('*')[0].trim();
        var baseCost = costMap[baseName] || 0;
        if (baseCost > 0) {
          var multiplier = parseInt(stdName.split('*')[1], 10) || 1;
          statusValues.push([baseCost * multiplier]);
          continue;
        }
      }
      statusValues.push(['❌ 원가미등록']);
    }
  }

  // 값 일괄 쓰기
  prSheet.getRange(2, 6, statusValues.length, 1).setValues(statusValues);

  // 숫자 포맷도 1회 일괄 적용 (행별 setNumberFormat 루프 제거 — 성능)
  var numberFormats = statusValues.map(function(row) {
    return [typeof row[0] === 'number' ? '#,##0' : '@'];
  });
  prSheet.getRange(2, 6, numberFormats.length, 1).setNumberFormats(numberFormats);
}

// ============================================================
// 데이터 읽기: 기존 웹앱용 orders 응답
// ============================================================
function getProcessedData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('가공_데이터');
  if (sheet && sheet.getLastRow() > 1) {
    var result = readProcessedSheet(sheet);
    result.unmapped = getUnmappedInfo(ss);
    return result;
  }

  var fallback = buildFromRawFallback(ss);
  fallback.unmapped = getUnmappedInfo(ss);
  return fallback;
}

function getUnmappedInfo(ss) {
  var prSheet = ss.getSheetByName('map_product');
  if (!prSheet || prSheet.getLastRow() < 2) return [];

  var data = prSheet.getRange(2, 1, prSheet.getLastRow() - 1, 6).getValues();
  var unmapped = [];

  for (var i = 0; i < data.length; i++) {
    var orig = String(data[i][0]).trim();
    var std = String(data[i][1]).trim();
    var status = String(data[i][5]).trim();
    if (!orig || orig === '-') continue;
    if (!std || status.indexOf('⚠️') >= 0 || status.indexOf('❌') >= 0) {
      unmapped.push({ item: orig, stdName: std, status: status || '미확인' });
    }
  }

  return unmapped;
}

function setValuesChunked_(sheet, startRow, startCol, values, chunkSize, flushEachChunk) {
  if (!values || values.length === 0) return;

  chunkSize = chunkSize || 4000;
  for (var offset = 0; offset < values.length; offset += chunkSize) {
    var chunk = values.slice(offset, offset + chunkSize);
    sheet.getRange(startRow + offset, startCol, chunk.length, chunk[0].length).setValues(chunk);
    // 청크마다의 flush는 비싼 연산이라 기본적으로 호출하지 않습니다.
    // 호출부에서 종료 후 1회만 flush합니다.
    if (flushEachChunk) SpreadsheetApp.flush();
  }
}

function readProcessedSheet(sheet) {
  var lastRow = sheet.getLastRow();
  var lastCol = Math.max(sheet.getLastColumn(), 17);
  var data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var orders = [];

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    if (!row[0] && !row[1]) continue;

    var dateVal = row[7];
    var dateStr;
    if (dateVal instanceof Date) {
      dateStr = dateVal.getFullYear() + '-' + p2(dateVal.getMonth() + 1) + '-' + p2(dateVal.getDate());
    } else {
      dateStr = String(dateVal).substring(0, 10);
    }

    orders.push({
      id: String(row[0]),
      item: String(row[1]),
      qty: Number(row[2]) || 0,
      revenue: Number(row[3]) || 0,
      ship: Number(row[4]) || 0,
      shop: String(row[5]),
      dt: String(row[6]),
      date: dateStr,
      channel: String(row[8]),
      product: String(row[9]),
      category: String(row[10]),
      feeRate: Number(row[11]) || 0,
      settlement: Number(row[12]) || 0,
      cost: Number(row[13]) || 0,
      shipCost: Number(row[14]) || 0,
      margin: Number(row[15]) || 0,
      manager: String(row[16]) || '미지정'
    });
  }

  return {
    orders: orders,
    meta: {
      source: '가공_데이터',
      rows: orders.length,
      timestamp: new Date().toISOString(),
      version: 'v3.5'
    }
  };
}

function buildFromRawFallback(ss) {
  var rawSheet = ss.getSheetByName('raw_orders');
  if (!rawSheet || rawSheet.getLastRow() < 2) {
    return { orders: [], meta: { source: 'raw_orders', rows: 0 } };
  }

  var rawData = rawSheet.getRange(2, 1, rawSheet.getLastRow() - 1, 7).getValues();
  var chMap = loadChannelMap(ss);
  var prMap = loadProductMap(ss);
  var costMap = loadCostMap(ss);
  var shipCost = loadShipCost(ss);
  var orders = [];

  for (var i = 0; i < rawData.length; i++) {
    var raw = rawData[i];
    var oid = String(raw[0]).trim();
    var itn = String(raw[1]).trim();
    if (!oid && !itn) continue;

    var qty = Number(raw[2]) || 0;
    var rev = Number(raw[3]) || 0;
    var sn = String(raw[5]).trim();
    var dt = parseAnyDate(raw[6]);
    var ch = chMap[sn] || { group: '미매핑', fee: 0, manager: '미지정' };
    var pr = prMap[itn] || { std: '미매핑', cat: '미매핑', parts: '' };
    var stl = Math.round(rev * (1 - ch.fee));
    var uc = calcProductCost(pr.std, pr.parts, costMap, qty);

    orders.push({
      id: oid,
      item: itn,
      qty: qty,
      revenue: rev,
      ship: Number(raw[4]) || 0,
      shop: sn,
      dt: dt,
      date: dt ? dt.substring(0, 10) : '',
      channel: ch.group,
      product: pr.std,
      category: pr.cat,
      feeRate: ch.fee,
      settlement: stl,
      cost: uc,
      shipCost: 0,
      margin: 0,
      manager: ch.manager || '미지정'
    });
  }

  var seenOids = {};
  for (var j = 0; j < orders.length; j++) {
    if (orders[j].id && !seenOids[orders[j].id]) {
      seenOids[orders[j].id] = true;
      orders[j].shipCost = shipCost;
    }
    orders[j].margin = orders[j].settlement - (orders[j].cost + orders[j].shipCost);
  }

  return {
    orders: orders,
    meta: {
      source: 'raw_orders+매핑(폴백)',
      rows: orders.length,
      timestamp: new Date().toISOString(),
      version: 'v3.5'
    }
  };
}

// ============================================================
// 대시보드 요약 캐시
// ============================================================
function refreshDashboardCacheMenu() {
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(2000)) {
    notifyUser_('⚠️ 이미 갱신이 진행 중입니다. 잠시 후 다시 시도해주세요.');
    return;
  }

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var stats = refreshDashboardCache(ss);
    notifyUser_(
      '✅ 대시보드 캐시 갱신 완료\n\n' +
      '원본 행 수: ' + stats.rawRows + '건\n' +
      'baseRows: ' + stats.baseRows + '행\n' +
      'productRows: ' + stats.productRows + '행\n' +
      'qualityRows: ' + stats.qualityRows + '행\n\n' +
      '갱신 시각: ' + new Date().toLocaleString('ko-KR')
    );
  } catch (err) {
    notifyUser_('❌ 대시보드 캐시 갱신 실패\n\n' + err.message);
    throw err;
  } finally {
    lock.releaseLock();
  }
}

function getDashboardCache() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('dashboard_cache');

  if (sheet && sheet.getLastRow() > 1) {
    return readDashboardCacheSheet_(sheet);
  }

  var processed = getProcessedData();
  var cache = buildDashboardCacheFromOrders_(processed.orders || []);
  cache.meta.source = 'built_on_demand';
  cache.meta.warning = 'dashboard_cache sheet was missing; run refreshProcessedData once';
  return { dashboardCache: cache, meta: cache.meta };
}

function refreshDashboardCache(ss, processedRows) {
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  var orders = processedRows
    ? processedRows.map(function(row, i) { return processedRowToOrder_(row, i); })
    : readProcessedOrdersForCache_(ss);

  var cache = buildDashboardCacheFromOrders_(orders);
  writeDashboardCache_(ss, cache);

  return {
    rawRows: orders.length,
    baseRows: cache.baseRows.length,
    productRows: cache.productRows.length,
    qualityRows: cache.qualityRows.length
  };
}

function readProcessedOrdersForCache_(ss) {
  var sheet = ss.getSheetByName('가공_데이터');
  if (!sheet || sheet.getLastRow() < 2) {
    var fallback = getProcessedData();
    return fallback.orders || [];
  }

  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 17).getValues();
  return data.map(function(row, i) {
    return processedRowToOrder_(row, i);
  }).filter(function(order) {
    return order.id || order.item;
  });
}

function processedRowToOrder_(row, i) {
  return {
    sheetRow: i + 2,
    id: String(row[0] || '').trim(),
    item: String(row[1] || '').trim(),
    qty: Number(row[2]) || 0,
    revenue: Number(row[3]) || 0,
    ship: Number(row[4]) || 0,
    shop: String(row[5] || '').trim(),
    dt: String(row[6] || '').trim(),
    date: normalizeDateOnly_(row[7] || row[6]),
    channel: String(row[8] || '미매핑').trim(),
    product: String(row[9] || '미매핑').trim(),
    category: String(row[10] || '미매핑').trim(),
    feeRate: Number(row[11]) || 0,
    settlement: Number(row[12]) || 0,
    cost: Number(row[13]) || 0,
    shipCost: Number(row[14]) || 0,
    margin: Number(row[15]) || 0,
    manager: String(row[16] || '미지정').trim()
  };
}

function buildDashboardCacheFromOrders_(orders) {
  var baseMap = {};
  var productMap = {};
  var qualityRows = [];

  for (var i = 0; i < orders.length; i++) {
    var order = orders[i];
    if (!order || !order.date) continue;

    addAgg_(baseMap, [
      order.date,
      order.channel,
      order.category,
      order.manager
    ], {
      date: order.date,
      channel: order.channel,
      category: order.category,
      manager: order.manager
    }, order);

    addAgg_(productMap, [
      order.date,
      order.channel,
      order.category,
      order.manager,
      order.product
    ], {
      date: order.date,
      channel: order.channel,
      category: order.category,
      manager: order.manager,
      product: order.product
    }, order);

    if (qualityIssueKeys_(order).length > 0) {
      qualityRows.push(compactQualityRow_(order));
    }
  }

  var baseRows = finalizeAgg_(baseMap);
  var productRows = finalizeAgg_(productMap);
  var meta = {
    source: 'dashboard_cache',
    version: 'v3.5',
    generatedAt: new Date().toISOString(),
    rawRows: orders.length,
    baseRows: baseRows.length,
    productRows: productRows.length,
    qualityRows: qualityRows.length
  };

  return {
    meta: meta,
    baseRows: baseRows,
    productRows: productRows,
    qualityRows: qualityRows
  };
}

function addAgg_(map, keyParts, seed, order) {
  var key = keyParts.join('\u001f');
  if (!map[key]) {
    map[key] = seed;
    map[key].qty = 0;
    map[key].revenue = 0;
    map[key].settlement = 0;
    map[key].cost = 0;
    map[key].shipCost = 0;
    map[key].margin = 0;
    map[key]._orders = {};
  }

  var row = map[key];
  row.qty += order.qty || 0;
  row.revenue += order.revenue || 0;
  row.settlement += order.settlement || 0;
  row.cost += order.cost || 0;
  row.shipCost += order.shipCost || 0;
  row.margin += order.margin || 0;
  if (order.id) row._orders[order.id] = true;
}

function finalizeAgg_(map) {
  var rows = [];
  for (var key in map) {
    var row = map[key];
    row.orders = Object.keys(row._orders || {}).length;
    delete row._orders;
    rows.push(row);
  }

  return rows.sort(function(a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if ((a.channel || '') !== (b.channel || '')) {
      return (a.channel || '').localeCompare(b.channel || '');
    }
    if ((a.category || '') !== (b.category || '')) {
      return (a.category || '').localeCompare(b.category || '');
    }
    return (a.manager || '').localeCompare(b.manager || '');
  });
}

function qualityIssueKeys_(order) {
  var keys = [];
  if (order.channel === '미매핑') keys.push('channelUnmapped');
  if (order.product === '미매핑' || order.category === '미매핑') keys.push('productUnmapped');
  if (!order.manager || order.manager === '미지정') keys.push('managerMissing');
  if (order.cost <= 1 && order.revenue > 0) keys.push('costMissing');
  if (order.revenue === 0) keys.push('zeroRevenue');
  if (order.margin < 0) keys.push('negativeMargin');
  return keys;
}

function compactQualityRow_(order) {
  return {
    sheetRow: order.sheetRow,
    id: order.id,
    item: order.item,
    qty: order.qty,
    revenue: order.revenue,
    ship: order.ship,
    shop: order.shop,
    date: order.date,
    channel: order.channel,
    product: order.product,
    category: order.category,
    settlement: order.settlement,
    cost: order.cost,
    shipCost: order.shipCost,
    margin: order.margin,
    manager: order.manager,
    issueKeys: qualityIssueKeys_(order).join(',')
  };
}

function writeDashboardCache_(ss, cache) {
  var sheet = ss.getSheetByName('dashboard_cache');
  if (!sheet) sheet = ss.insertSheet('dashboard_cache');
  if (sheet.getFilter()) sheet.getFilter().remove();
  sheet.clear();

  var rows = [['section', 'part', 'json']];
  appendJsonChunks_(rows, 'meta', cache.meta);
  appendJsonChunks_(rows, 'baseRows', cache.baseRows);
  appendJsonChunks_(rows, 'productRows', cache.productRows);
  appendJsonChunks_(rows, 'qualityRows', cache.qualityRows);

  setValuesChunked_(sheet, 1, 1, rows, 1000);
  sheet.getRange(1, 1, 1, 3)
    .setFontWeight('bold')
    .setBackground('#1F2937')
    .setFontColor('#FFFFFF');

  // autoResizeColumns는 json 열(셀당 최대 45,000자)의 폭을 측정하느라
  // 수 분이 걸리므로 사용하지 않고 고정 폭을 지정합니다.
  sheet.setColumnWidth(1, 120);
  sheet.setColumnWidth(2, 60);
  sheet.setColumnWidth(3, 400);

  try {
    sheet.hideSheet();
  } catch (err) {
    // 숨김 실패는 대시보드 기능에 영향이 없어 무시합니다.
  }
}

function appendJsonChunks_(rows, section, value) {
  var text = JSON.stringify(value || null);
  var chunkSize = 45000;
  var part = 0;

  for (var i = 0; i < text.length; i += chunkSize) {
    rows.push([section, part, text.substring(i, i + chunkSize)]);
    part++;
  }

  if (text.length === 0) {
    rows.push([section, 0, '']);
  }
}

function readDashboardCacheSheet_(sheet) {
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
  var buckets = {};

  for (var i = 0; i < data.length; i++) {
    var section = String(data[i][0] || '').trim();
    if (!section) continue;
    if (!buckets[section]) buckets[section] = [];
    buckets[section].push({
      part: Number(data[i][1]) || 0,
      text: String(data[i][2] || '')
    });
  }

  var cache = {};
  for (var key in buckets) {
    buckets[key].sort(function(a, b) {
      return a.part - b.part;
    });
    var jsonText = buckets[key].map(function(part) {
      return part.text;
    }).join('');
    cache[key] = jsonText ? JSON.parse(jsonText) : null;
  }

  cache.meta = cache.meta || {};
  cache.baseRows = cache.baseRows || [];
  cache.productRows = cache.productRows || [];
  cache.qualityRows = cache.qualityRows || [];

  return {
    dashboardCache: cache,
    meta: cache.meta
  };
}

function normalizeDateOnly_(value) {
  if (!value) return '';
  if (value instanceof Date && !isNaN(value.getTime())) {
    return value.getFullYear() + '-' + p2_(value.getMonth() + 1) + '-' + p2_(value.getDate());
  }

  var text = String(value).trim();
  var m = text.match(/^(\d{4})[-.\/]\s*(\d{1,2})[-.\/]\s*(\d{1,2})/);
  if (m) return m[1] + '-' + p2_(m[2]) + '-' + p2_(m[3]);

  var parsed = new Date(text);
  if (!isNaN(parsed.getTime())) {
    return parsed.getFullYear() + '-' + p2_(parsed.getMonth() + 1) + '-' + p2_(parsed.getDate());
  }
  return '';
}

function p2_(value) {
  var text = String(value);
  return text.length < 2 ? '0' + text : text;
}

// ============================================================
// 매핑 테이블
// ============================================================
function loadChannelMap(ss) {
  var m = {};
  var s = ss.getSheetByName('map_channel');
  if (!s || s.getLastRow() < 2) return m;

  var colCount = Math.max(s.getLastColumn(), 5);
  var d = s.getRange(2, 1, s.getLastRow() - 1, colCount).getValues();

  for (var i = 0; i < d.length; i++) {
    var n = String(d[i][0]).trim();
    var g = String(d[i][1]).trim();
    var f = d[i][3] ? Number(d[i][3]) : 0;
    if (f > 1) f = f / 100;
    var mgr = d[i][4] ? String(d[i][4]).trim() : '미지정';
    if (n) m[n] = { group: g, fee: f, manager: mgr };
  }

  return m;
}

function loadProductMap(ss) {
  var m = {};
  var s = ss.getSheetByName('map_product');
  if (!s || s.getLastRow() < 2) return m;

  var d = s.getRange(2, 1, s.getLastRow() - 1, Math.max(s.getLastColumn(), 5)).getValues();
  for (var i = 0; i < d.length; i++) {
    var o = String(d[i][0]).trim();
    var st = String(d[i][1]).trim();
    var c = String(d[i][2]).trim();
    var p = d[i][4] ? String(d[i][4]).trim() : '';
    if (o) m[o] = { std: st, cat: c, parts: p };
  }

  return m;
}

function loadCostMap(ss) {
  var m = {};
  var s = ss.getSheetByName('map_cost');
  if (!s || s.getLastRow() < 2) return m;

  var d = s.getRange(2, 1, s.getLastRow() - 1, 2).getValues();
  for (var i = 0; i < d.length; i++) {
    var n = String(d[i][0]).trim();
    var c = Number(d[i][1]) || 0;
    if (n) m[n] = c;
  }

  return m;
}

function loadShipCost(ss) {
  var s = ss.getSheetByName('map_cost');
  if (!s) return 4521;
  var v = s.getRange('D2').getValue();
  return Number(v) || 4521;
}

function calcProductCost(stdName, partsStr, costMap, qty) {
  if (partsStr && partsStr.length > 0) {
    var parts = partsStr.split(',');
    var total = 0;
    for (var i = 0; i < parts.length; i++) {
      total += (costMap[parts[i].trim()] || 0);
    }
    return total * qty;
  }
  return (costMap[stdName] || 0) * qty;
}

// ============================================================
// 날짜 파서
// ============================================================
function parseAnyDate(val) {
  if (!val) return '';
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return '';
    return fmtDate(val);
  }
  if (typeof val === 'number' && val > 30000 && val < 60000) {
    var d = new Date((val - 25569) * 86400 * 1000);
    if (!isNaN(d.getTime())) return fmtDate(d);
    return '';
  }

  var s = String(val).trim();
  if (!s) return '';

  var m = s.match(/^(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})(.*)/);
  if (m) {
    var o = m[1] + '-' + p2(m[2]) + '-' + p2(m[3]);
    var tp = m[4] ? m[4].trim() : '';
    if (tp) {
      var t = tp.match(/(\d{1,2})[:\.](\d{2})(?:[:\.](\d{2}))?/);
      if (t) o += ' ' + p2(t[1]) + ':' + p2(t[2]) + ':' + p2(t[3] || '0');
    }
    return o;
  }

  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(.*)/);
  if (m) {
    var o2 = m[1] + '-' + p2(m[2]) + '-' + p2(m[3]);
    var t2 = m[4] ? m[4].trim() : '';
    if (t2) {
      var tt = t2.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
      if (tt) o2 += ' ' + p2(tt[1]) + ':' + p2(tt[2]) + ':' + p2(tt[3] || '0');
    }
    return o2;
  }

  m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (m) return m[1] + '-' + p2(m[2]) + '-' + p2(m[3]);

  var last = new Date(s);
  if (!isNaN(last.getTime())) return fmtDate(last);
  return '';
}

function p2(n) {
  var s = String(n);
  return s.length < 2 ? '0' + s : s;
}

function fmtDate(d) {
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) +
    ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
}

function testGetData() {
  var r = getProcessedData();
  var lines = [];
  lines.push('총 행: ' + r.orders.length);

  var ids = {};
  for (var i = 0; i < r.orders.length; i++) {
    ids[r.orders[i].id] = true;
  }
  lines.push('고유 주문: ' + Object.keys(ids).length);

  if (r.orders.length > 0) {
    var o = r.orders[0];
    lines.push(
      '첫번째: 매출=' + o.revenue +
      ' 정산=' + o.settlement +
      ' 원가=' + o.cost +
      ' 배송=' + o.shipCost +
      ' 마진=' + o.margin +
      ' 담당자=' + o.manager +
      ' 날짜=' + o.date
    );
  }

  lines.push('미매핑: ' + r.unmapped.length + '건');
  if (r.unmapped.length > 0) {
    Logger.log('미매핑 예시: ' + JSON.stringify(r.unmapped.slice(0, 3)));
  }

  var cache = getDashboardCache();
  lines.push('캐시 meta: ' + JSON.stringify(cache.meta));

  var mgrAgg = {};
  for (var j = 0; j < r.orders.length; j++) {
    var mgr = r.orders[j].manager || '미지정';
    if (!mgrAgg[mgr]) mgrAgg[mgr] = { rev: 0, cnt: 0 };
    mgrAgg[mgr].rev += r.orders[j].revenue;
    mgrAgg[mgr].cnt++;
  }
  lines.push('담당자별: ' + JSON.stringify(mgrAgg));

  notifyUser_('📋 데이터 확인\n\n' + lines.join('\n'));
}
