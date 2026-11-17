/**
 * 아침 갱신 실행기 (Google Apps Script) — GitHub 예약 실행 대신 구글 시간 트리거로 매일 07:30 KST 에 돌린다.
 * ------------------------------------------------------------------
 * 왜
 *   GitHub 예약 실행(schedule)은 보장이 없다. 07:50 예약은 2~4시간 늦게(10:30~13:30) 돌았고,
 *   새벽 03:15~07:30 매시 예약으로 바꾼 첫날(2026-11-18)은 한 번도 돌지 않았다.
 *   구글 시간 트리거는 지정한 시간대 안에서 거의 정확히 실행되므로, 여기서 GitHub 실행 버튼(workflow_dispatch)을 누른다.
 *
 * 사용법 (한 번만)
 *   1) 운영_DB 시트 → 확장 프로그램 → Apps Script → 새 스크립트 파일에 이 파일 내용을 붙여넣기
 *   2) 프로젝트 설정(톱니바퀴) → 시간대 "(GMT+09:00) 서울" 확인
 *   3) 프로젝트 설정 → 스크립트 속성 → 속성 GH_TOKEN, 값 = GitHub Fine-grained 토큰
 *      (저장소 promotion_calendar 만, 권한 Actions: Read and write). 토큰은 코드나 채팅에 적지 않는다.
 *   4) 함수 setupMorningTrigger 실행 → 권한 승인 (트리거 등록 + 즉시 1회 실행)
 *   수동 실행은 runMorningUpdate.
 *
 * 워크플로 쪽 새벽 예약은 예비로 남아 있고, "오늘 이미 받았으면 건너뜀"이라 아워박스 조회는 하루 1회 그대로다.
 */

var GH = {
  OWNER: 'wltjq1324-cloud',
  REPO: 'promotion_calendar',
  REF: 'main',
  WORKFLOWS: ['update-inventory.yml', 'update-box-stock.yml']
};

/** 최초 1회: 매일 07시 30분 무렵 트리거 등록 + 즉시 1회 실행 */
function setupMorningTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runMorningUpdate') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runMorningUpdate').timeBased().everyDays(1).atHour(7).nearMinute(30).create();
  return runMorningUpdate();
}

/** 두 워크플로(재고 스냅샷, 박스·출고·입출고 누적)를 실행시킨다 */
function runMorningUpdate() {
  var token = PropertiesService.getScriptProperties().getProperty('GH_TOKEN');
  if (!token) throw new Error('스크립트 속성 GH_TOKEN 이 없습니다. 프로젝트 설정 → 스크립트 속성에 GitHub 토큰을 넣어 주세요.');
  var results = GH.WORKFLOWS.map(function (wf) {
    var url = 'https://api.github.com/repos/' + GH.OWNER + '/' + GH.REPO + '/actions/workflows/' + wf + '/dispatches';
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      payload: JSON.stringify({ ref: GH.REF }),
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    // 204 = 실행 요청 성공
    return wf + ': ' + (code === 204 ? '실행 요청 완료' : '실패 HTTP ' + code + ' ' + res.getContentText().slice(0, 200));
  });
  var msg = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm') + ' ' + results.join(' / ');
  Logger.log(msg);
  if (results.some(function (r) { return r.indexOf('실패') >= 0; })) throw new Error(msg);
  return msg;
}
