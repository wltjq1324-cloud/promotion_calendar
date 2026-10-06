# promotion_calendar — 프로모션 캘린더 · SKU 재고 · 박스 실재고 (Claude Code 프로젝트 지침)

밭(주) 온라인팀(존, wltjq1324@gmail.com)의 GitHub Pages 정적 사이트. 다른 저장소(`batt_ops` 운영포털, `b2c_dashboard_ourbox` 매출 대시보드)와의 관계와 비밀값 위치는 **`batt_ops/docs/REPO-MAP.md`**를 먼저 읽는다. 존과 일하는 규칙은 `batt_ops/CLAUDE.md`와 같다(끝까지 직접 하고 되묻지 않는다, 비밀값 출력 금지, 아워박스 정기 조회는 매일 08:00 1회).

## 페이지·파일

| 파일 | 역할 |
|---|---|
| `index.html`, `calendar-base.html` | 프로모션 운영 캘린더. 서버는 Apps Script 웹앱(`scripts/promotion-api.gs` 백업본) |
| `inven.html` (`/inven`) | SKU별 재고 현황 + **박스 실재고(근사치)** 섹션. 접속 코드 게이트(`ACCESS_CODES`) |
| `inventory-latest.json` | 아워박스 재고 스냅샷. `update-inventory` 워크플로가 30분마다 갱신(`scripts/update-inventory.ps1`) |
| `box-stock-latest.json`, `box-daily.json` | 박스 실재고 결과·일별 출고 캐시. `update-box-stock` 워크플로가 매일 08:00 KST 갱신 |
| `scripts/box-stock.mjs` | 박스 실재고 계산(순수 함수 export). 테스트 `node scripts/box-stock.test.js` |
| `box-stock-config.json` | 품목 코드·묶음·리드타임(7일)·검토주기(7일)·안전재고율(0.2)·룩업 오버라이드·1회 재수집 플래그 |
| `box-lookup.json` | 송장 내용물 서명(`업체품목코드x수량\|…`) → 박스 종류. OMS 엑셀 49,799송장(2026-05~09)에서 생성 |
| `scripts/velocity-cache.gs`, `sku-sync.gs`, `sku-mapping-assistant.gs` | 시트 "*OURBOX_프로모션_운영_DB" 쪽 Apps Script 백업본 |

## 박스 실재고 계산 규칙 (2026-09-18 확정)

```
실재고 ≈ 마지막 실사 잔고 + 실사 이후 입고 − 실사 이후 출고 송장 수
```

- **실사 잔고** = `product_stock.total_stock − 실사 이후 입고`. API `stock_adj_hist.af_qty`는 셀 단위라 품목 합계가 아니므로 쓰지 않는다(실사 **시각**만 쓴다). 이 역산값은 수불표와 정확히 일치한다.
- **입고** = `put_perf`(입고완료일, 7일 창, 업체코드 `S-TB001/002/008`).
- **출고** = `out_perf_period`(출고완료일) 송장 1건 = 박스 1개. 창고 담당자 2026-09-16 계산과 대조: 1호 +7, 2호 −73, 3호 −53. **보정계수는 1.0** — 과거 실사에서 드러난 손실(1호 10%, 2호 14%)은 카드에 참고 표시만 하고 계산에 넣지 않는다.
- **박스 종류**는 공개 API에 없어 송장 내용물 서명으로 추정한다. 미판정률이 15%를 넘으면 카드에 경고. 포장 관행이 바뀌면 `lookupOverrides`에 `{box, from}`으로 적는다 — 8개입(G-O142) 조합은 2026-09-03부터 3호→4호.
- **창고 실사 기준점** (`box-stock-config.json` `manualCounts`, 2026-10-06 추가): 아워박스 조정 이력에 없는 창고 실물 수량을 기준점으로 쓴다. 이후 입고 = **실제 입고일(`input_dt`)**이 실사일 다음 날부터(입고완료일은 하루 늦게 찍혀 이중 가산됨 — 9/23 입고 11276은 입고일 9/22), 이후 출고 = **출고등록일(`out_dt_type '1'`)** 기준 상자 수(`box-daily.json` `regDays`), 실사일 등록분은 `alreadyDeductedBoxes`만큼 창고가 이미 뺀 것으로 본다. 아워박스에 더 늦은 재고 조정이 생기면 그쪽이 우선. 화면 타임라인 재고는 이 경우 스크립트의 `stockDaily`를 쓴다.
  - 왜: 9/18 조정 잔고 128로 계산하면 9/19~21에 −316(있을 수 없는 음수)이 나와 기준점 자체가 의심됐다. 10/06 창고 실사 1호 2,302(오늘 입고 2,016 포함, 오늘 출고등록 1호 219상자 차감 후)로 교체. 같은 날 엑셀 대조: 일별 출고 박스 판정은 8/27~9/14 실제 포장박스 5,433 vs 화면 5,435, 10/06 1호 219 vs 판정 218 — 출고 쪽은 정확, 오차는 기준점에서 나왔다.
  - 포털(`batt_ops` `oms_orders`) 주문 데이터로 박스를 세지 말 것: 판매상품 수량이라 세트 구성품 서명이 달라 1호가 과다 판정된다(10/06 실측 320 vs 실제 219).
- 4호(아워박스 3호)는 아워박스 소유 박스라 재고 계산 제외, 사용량만 집계.
- 송장 없는 행(B2B 벌크)은 `noInvoiceGroups/noInvoiceQty`로 따로 센다. 박스 집계에 안 들어간다.
- 발주 제안 = 최근 4주 평균 × (리드타임+검토주기)/7 × (1+안전재고율) − 실재고, 묶음 올림. **온라인 수요는 스파이크가 커서 평균만 믿지 않는다** — 일자별 표에서 스파이크(주 일평균 2배↑)를 본다.

## 운영

- 룩업·오버라이드·품목 코드를 바꾸면 `box-stock-config.json`의 `rebuildDailyOnce: true`로 일별 캐시를 1회 전부 다시 받는다(API ~215회, 4.5분). 평소 증분은 ~47회, 1분.
- 워크플로 수동 실행 권한이 앱 토큰에 없다. `update-box-stock.yml`·`scripts/box-stock.mjs`·`box-stock-config.json`·`box-lookup.json` 변경을 푸시하면 즉시 1회 실행된다.
- 두 워크플로가 모두 `main`에 커밋하므로 push 충돌 시 `git pull --rebase` 후 재시도(워크플로에 내장).
- 화면은 파일만 읽는다. 새로고침 버튼이 아워박스를 부르지 않는다.
- 배포 = `main` 푸시(GitHub Pages). PR 관행 없음.

## 검증

```bash
node scripts/box-stock.test.js      # 순수 로직
node scripts/velocity-cache.test.js
node scripts/sku-sync.test.js
```

아워박스 API 사실은 `batt_ops/docs/handover/ourbox-api.md`가 원본이다. 여기에는 적지 않는다.
