# 데이터셋(JSON) → 엑셀. 사용: python3 build_xlsx.py dataset.json out.xlsx
import json, sys
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter as L

D = json.load(open(sys.argv[1]))
F = Font(name='Arial', size=10); FB = Font(name='Arial', size=10, bold=True); FH = Font(name='Arial', size=10, bold=True, color='FFFFFF')
HEAD = PatternFill('solid', fgColor='176B87'); EST = PatternFill('solid', fgColor='FBF3D0'); GRP = PatternFill('solid', fgColor='EEF2F7')
THIN = Side(style='thin', color='D8DEE8'); BOX = Border(bottom=THIN)
md = lambda s: f"{int(s[:2])}/{int(s[3:])}"
ORDER = ['판매상품', '세트', '증정품', '부자재']
W0 = next(i for i, w in enumerate(D['weeks']) if w['src'] != 'est'); M0 = D['months'].index(4)
SRC = {'est': '추정(출고 시트 주문)', 'mix': f"혼합({md(D['estEnd'][5:])}까지 추정)", 'real': '실출고(아워박스)'}
wb = Workbook(); wb.remove(wb.active)

def grid(title, cols, getter, note):
    """cols: [(머리글, 부제, 출처, est여부)], getter(row) → 값 리스트"""
    ws = wb.create_sheet(title)
    ws['A1'] = note; ws['A1'].font = FB
    heads = ['구분', 'SKU', '상품코드', '합계'] + [c[0] for c in cols]
    for j, h in enumerate(heads, 1):
        c = ws.cell(row=3, column=j, value=h); c.font = FH; c.fill = HEAD; c.alignment = Alignment(horizontal='center')
    for j, c0 in enumerate(cols, 5):
        a = ws.cell(row=4, column=j, value=c0[1]); a.font = F; a.alignment = Alignment(horizontal='center')
        b = ws.cell(row=5, column=j, value=c0[2]); b.font = F; b.alignment = Alignment(horizontal='center')
        if c0[3]: a.fill = EST; b.fill = EST
    ws.cell(row=4, column=1, value='기간').font = FB; ws.cell(row=5, column=1, value='출처').font = FB
    rows = [(r, getter(r)) for r in D['rows']]
    rows = [(r, v) for r, v in rows if sum(v) > 0]
    rows.sort(key=lambda x: (ORDER.index(x[0]['cat']), -sum(x[1])))
    r0 = 6; last = L(4 + len(cols))
    for i, (r, v) in enumerate(rows):
        y = r0 + i
        for j, val in enumerate([r['cat'], r['name'], r['code'] or '(시트 품목)'], 1): ws.cell(row=y, column=j, value=val).font = F
        t = ws.cell(row=y, column=4, value=f'=SUM(E{y}:{last}{y})'); t.font = FB; t.number_format = '#,##0'
        for j, x in enumerate(v, 5):
            c = ws.cell(row=y, column=j, value=x); c.font = F; c.number_format = '#,##0;-#,##0;0'
            if cols[j - 5][3]: c.fill = EST
    y = r0 + len(rows)
    ws.cell(row=y, column=2, value=f'합계 ({len(rows)}개 SKU)').font = FB
    for j in range(4, 5 + len(cols)):
        c = ws.cell(row=y, column=j, value=f'=SUM({L(j)}{r0}:{L(j)}{y - 1})'); c.font = FB; c.number_format = '#,##0'; c.fill = GRP
    for j in range(1, 4): ws.cell(row=y, column=j).fill = GRP
    ws.freeze_panes = 'E6'
    ws.column_dimensions['A'].width = 9; ws.column_dimensions['B'].width = 40; ws.column_dimensions['C'].width = 19; ws.column_dimensions['D'].width = 11
    for j in range(5, 5 + len(cols)): ws.column_dimensions[L(j)].width = 11.5
    return len(rows)

wk = [(f"W{w['w']:02d}", f"{md(w['from'])}~{md(w['to'])}", SRC[w['src']].split('(')[0], w['src'] != 'real') for w in D['weeks']]
wk_real = [(h, (f"{md(D['apiStart'][5:])}~{md(D['weeks'][W0]['to'])}" if i == W0 else s), '실출고', False) for i, (h, s, _, _) in enumerate(wk) if i >= W0]
mo = [(f"{m}월", ('~' + md(D['end'][5:]) if m == D['months'][-1] else ''), '추정' if m < 4 else ('혼합' if m == 4 else '실출고'), m <= 4) for m in D['months']]
mo_real = [(f"{m}월", (f"{int(D['apiStart'][8:])}일부터" if m == 4 else ('~' + md(D['end'][5:]) if m == D['months'][-1] else '')), '실출고', False) for m in D['months'] if m >= 4]
end = md(D['end'][5:])
n1 = grid('택배_주차', wk, lambda r: r['pw'], f"B2C 택배 주차별 출고 수량 (EA) · 2026-01-01 ~ {D['end']} · 노란 열은 출고 시트 주문으로 추정")
n2 = grid('대량_주차', wk_real, lambda r: [v or 0 for v in r['bw'][W0:]], f"B2B 대량출고 주차별 수량 (EA) · {D['apiStart']} ~ {D['end']} · 아워박스 실출고")
n3 = grid('합계_주차', wk_real, lambda r: [(a or 0) + (b or 0) for a, b in zip(r['prw'][W0:], r['bw'][W0:])], f"택배 + 대량출고 주차별 수량 (EA) · {D['apiStart']} ~ {D['end']} · 아워박스 실출고")
grid('택배_월', mo, lambda r: r['pm'], f"B2C 택배 월별 출고 수량 (EA) · 2026-01-01 ~ {D['end']} · 노란 열은 추정 포함")
grid('대량_월', mo_real, lambda r: [v or 0 for v in r['bm'][M0:]], f"B2B 대량출고 월별 수량 (EA) · {D['apiStart']} ~ {D['end']}")

# 긴 표 (피벗용): 0은 뺀다
ws = wb.create_sheet('긴표')
heads = ['구분', 'SKU', '상품코드', '흐름', '주차', '주 시작', '주 끝', '수량', '출처']
for j, h in enumerate(heads, 1):
    c = ws.cell(row=1, column=j, value=h); c.font = FH; c.fill = HEAD
y = 2
for r in D['rows']:
    for i, w in enumerate(D['weeks']):
        for flow, v, src in (('택배', r['pw'][i], SRC[w['src']]), ('대량출고', r['bw'][i], '실출고(아워박스)')):
            if not v: continue
            for j, val in enumerate([r['cat'], r['name'], r['code'] or '(시트 품목)', flow, f"W{w['w']:02d}", '2026-' + w['from'], '2026-' + w['to'], v, src], 1):
                c = ws.cell(row=y, column=j, value=val); c.font = F
                if j == 8: c.number_format = '#,##0'
            y += 1
ws.freeze_panes = 'A2'; ws.auto_filter.ref = f"A1:I{y - 1}"
for col, w in zip('ABCDEFGHI', [9, 40, 19, 10, 7, 12, 12, 10, 22]): ws.column_dimensions[col].width = w

# 설명
ws = wb.create_sheet('설명')
vok = [v for v in D['val'] if v['real'] > 0]; ve = sum(v['est'] for v in vok); vr = sum(v['real'] for v in vok)
lines = [
    'SKU 주차별 출고 2026 — 숫자의 기준',
    f"기간: 2026-01-01 ~ {D['end']} (자료가 있는 기간과 출고가 있었던 SKU만 넣었습니다)",
    f"{D['apiStart']} 이후: 아워박스 출고실적(out_perf_period), 출고완료일·상품코드 기준. /inven 화면과 같은 규칙.",
    '  택배 = 송장이 있는 출고 + 홈쇼핑 직택배. 대량출고 = 송장 없는 출고.',
    f"2026-01-01 ~ {D['estEnd']} 택배: 아워박스에 기록이 없어 출고 시트(*아워박스_DB_초안) 주문에서 세트를 단품으로 풀어 추정했습니다. 주문일 다음 날을 출고일로 봤습니다.",
    f"  같은 방법을 {D['apiStart']} 이후에 적용해 실출고와 비교하면 판매상품·세트 합계 {ve:,} vs {vr:,} (차이 {(ve - vr) / vr * 100:+.1f}%). 주 단위 오차는 중앙값 {D['weekErr']['median']}%, 열 주에 한 주꼴로 {D['weekErr']['p90']}%를 넘습니다.",
    f"2026-01-01 ~ {D['estEnd']} 대량출고: 자료가 없어 넣지 않았습니다.",
    f"증정품·부자재는 주문에 잡히지 않고 같이 나가는 수량이 많아 {D['estEnd']}까지의 추정에서는 빠지거나 적게 잡힙니다.",
    f"[L]오리지널 10개입(롯데홈쇼핑용)은 출고 시트에 오리지널 10개입으로 적혀 있어 {D['estEnd']}까지는 오리지널(10개입) 행에 들어 있습니다.",
    f"주는 월요일 시작. W01 = 1/1~1/4(4일). W{D['weeks'][W0]['w']} = {md(D['estEnd'][5:])}까지 추정 + {md(D['apiStart'][5:])}부터 실출고. 마지막 주 W{D['weeks'][-1]['w']} = {md(D['weeks'][-1]['from'])}~{md(D['weeks'][-1]['to'])} ({D['weeks'][-1]['n']}일, 진행 중).",
    "상품코드가 '(시트 품목)'인 행은 아워박스에 상품코드가 없는 품목(아워박스 출고 시작 전에 끝난 상품)입니다. 출고 시트 이름 그대로입니다.",
    '합계 칸은 수식(SUM)입니다. 값을 고치면 다시 계산됩니다.',
    '대량출고 채널: ' + ', '.join(f"{c} {q:,}개" for c, q in D['bulkCh']),
    ('재고 목록에는 있지만 올해 출고가 없어 뺀 SKU: ' + ', '.join(D['zeroInv'])) if D['zeroInv'] else '',
    f"수집: 아워박스 호출 {D['calls']:,}회, {D['generated'][:10]} 실행. 날짜별 행수 불일치 {len(D['mismatch'])}건.",
]
for i, t in enumerate([l for l in lines if l], 1):
    c = ws.cell(row=i, column=1, value=t); c.font = FB if i == 1 else F
ws.column_dimensions['A'].width = 140
wb.save(sys.argv[2])
print('sheets', wb.sheetnames, '| rows 택배', n1, '대량', n2, '합계', n3, '| 긴표', y - 2)
