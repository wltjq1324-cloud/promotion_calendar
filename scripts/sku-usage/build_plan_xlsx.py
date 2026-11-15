# plan.json → B2C 계획 기초 엑셀. 사용: python3 build_plan_xlsx.py plan.json out.xlsx
import json, sys
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter as L

P = json.load(open(sys.argv[1])); F_ = P['find']
F = Font(name='Arial', size=10); FB = Font(name='Arial', size=10, bold=True); FH = Font(name='Arial', size=10, bold=True, color='FFFFFF')
FBLUE = Font(name='Arial', size=10, color='0000FF'); FGREEN = Font(name='Arial', size=10, color='008000'); FT = Font(name='Arial', size=13, bold=True)
HEAD = PatternFill('solid', fgColor='176B87'); EST = PatternFill('solid', fgColor='FBF3D0'); GRP = PatternFill('solid', fgColor='EEF2F7'); INP = PatternFill('solid', fgColor='FFFF00')
NUM = '#,##0;-#,##0;0'; PCT = '0.0%'; CENTER = Alignment(horizontal='center'); WRAP = Alignment(wrap_text=True, vertical='top')
md = lambda s: f"{int(s[:2])}/{int(s[3:])}"; md2 = lambda s: f"{int(s[5:7])}/{int(s[8:10])}"
A_, X_, E_ = md2(P['apiStart']), md2(P['estEnd']), md2(P['end'])
wb = Workbook(); wb.remove(wb.active)

def head(ws, row, labels, widths=None):
    for j, h in enumerate(labels, 1):
        c = ws.cell(row=row, column=j, value=h); c.font = FH; c.fill = HEAD; c.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
    for j, w in enumerate(widths or [], 1): ws.column_dimensions[L(j)].width = w
def put(ws, r, c, v, font=F, fmt=None, fill=None, align=None):
    x = ws.cell(row=r, column=c, value=v); x.font = font
    if fmt: x.number_format = fmt
    if fill: x.fill = fill
    if align: x.alignment = align
    return x

# ── 실적표(월별·주차별): 구분 | SKU | 상품코드 | 상태 | 합계 | 값…
def grid(title, note, cols, key):
    ws = wb.create_sheet(title); put(ws, 1, 1, note, FB)
    head(ws, 3, ['구분', 'SKU', '상품코드', '상태', '합계'] + [c[0] for c in cols], [9, 38, 19, 7, 11])
    for j, c in enumerate(cols, 6):
        for k, r in enumerate((4, 5), 1): put(ws, r, j, c[k], F, None, EST if c[3] else None, CENTER)
        ws.column_dimensions[L(j)].width = 11
    put(ws, 4, 1, cols[0][4], FB); put(ws, 5, 1, '출처', FB)
    r0 = 6; last = L(5 + len(cols)); rowmap = {}
    for i, r in enumerate(P['rows']):
        y = r0 + i; rowmap[(r['name'], r['code'])] = y
        for j, v in enumerate([r['cat'], r['name'], r['code'] or '(시트 품목)', r['status']], 1): put(ws, y, j, v)
        put(ws, y, 5, f'=SUM(F{y}:{last}{y})', FB, NUM)
        for j, v in enumerate(r[key], 6): put(ws, y, j, v, F, NUM, EST if cols[j - 6][3] else None)
    y = r0 + len(P['rows']); put(ws, y, 2, f"합계 ({len(P['rows'])}개 SKU)", FB)
    for j in range(1, 6 + len(cols)): ws.cell(row=y, column=j).fill = GRP
    for j in range(5, 6 + len(cols)): put(ws, y, j, f'=SUM({L(j)}{r0}:{L(j)}{y - 1})', FB, NUM, GRP)
    ws.freeze_panes = 'F6'
    return ws, rowmap

SRC = {'est': '추정', 'mix': '혼합', 'real': '실출고'}
mcols = [(f'{m}월', f"{d}일", '추정' if m < 4 else ('혼합' if m == 4 else '실출고'), m <= 4, '일수') for m, d in zip(P['months'], P['mdays'])]
ws_m, row_m = grid('월별', f"B2C 택배 월별 출고 수량 (EA) · 2026-01-01 ~ {P['end']} · 달력 월(날짜 기준) · 노란 열은 출고 시트 주문으로 추정 · 11월은 {P['mdays'][-1]}일치", mcols, 'pm')
import datetime
def thu_month(w): return (datetime.date.fromisocalendar(2026, w['w'], 4)).month
wcols = [(f"W{w['w']:02d}", f"{md(w['from'])}~{md(w['to'])}", SRC[w['src']], w['src'] != 'real', '기간') for w in P['weeks']]
ws_w, _ = grid('주차별', f"B2C 택배 주차별 출고 수량 (EA) · 2026-01-01 ~ {P['end']} · 주는 월요일 시작 · 노란 열은 추정(W16은 {X_}까지 추정)", wcols, 'pw')
put(ws_w, 2, 1, '속한 달', FB)
for j, w in enumerate(P['weeks'], 6): put(ws_w, 2, j, f"{thu_month(w)}월", F, None, None, CENTER)

# ── SKU 진단
ws = wb.create_sheet('SKU진단')
put(ws, 1, 1, f"SKU 진단 (판매상품·세트 {len(P['diag'])}개) · 평시 = 출고가 있던 기간의 주 물량 중앙값 · 행사 주 = 평시의 2배를 넘은 주 · 최근 13주 = W33~W45", FB)
head(ws, 3, ['구분', 'SKU', '상태', '등급', '합계', '비중', '누적 비중', '평시 주 물량', '행사 주 수', '행사 초과분 비중', '최대 주', '최대 주 수량', '최대 ÷ 평시', '최근 13주 평시', '그 전 평시', '추세', '첫 출고', '마지막 출고'],
     [9, 38, 7, 6, 10, 8, 9, 10, 8, 10, 8, 10, 9, 10, 9, 8, 11, 11])
ws.row_dimensions[3].height = 30
r0 = 4; n = len(P['diag']); rl = r0 + n - 1
for i, x in enumerate(P['diag']):
    y = r0 + i
    for j, v in enumerate([x['cat'], x['name'], x['status'], x['grade']], 1): put(ws, y, j, v, F, None, None, CENTER if j > 2 else None)
    put(ws, y, 5, f"='월별'!E{row_m[(x['name'], x['code'])]}", FGREEN, NUM)
    put(ws, y, 6, f'=E{y}/SUM($E${r0}:$E${rl})', F, PCT); put(ws, y, 7, f'=SUM($F${r0}:F{y})', F, PCT)
    put(ws, y, 8, round(x['med'], 1), F, NUM); put(ws, y, 9, x['nSpike'], F, NUM); put(ws, y, 10, round(x['spikeShare'], 4), F, PCT)
    put(ws, y, 11, f"W{x['pkW']:02d}" if x['pkQty'] else '', F, None, None, CENTER); put(ws, y, 12, x['pkQty'], F, NUM)
    put(ws, y, 13, f'=IF(H{y}>0,L{y}/H{y},"")', F, '0.0"배"')
    put(ws, y, 14, None if x['r13'] is None or x['status'] == '종료' else round(x['r13'], 1), F, NUM)
    put(ws, y, 15, None if x['prior'] is None else round(x['prior'], 1), F, NUM)
    put(ws, y, 16, f'=IF(AND(ISNUMBER(N{y}),ISNUMBER(O{y}),O{y}>0),N{y}/O{y}-1,"")', F, '+0%;-0%;0%')
    put(ws, y, 17, x['first']); put(ws, y, 18, x['last'])
put(ws, rl + 1, 2, '합계', FB); put(ws, rl + 1, 5, f'=SUM(E{r0}:E{rl})', FB, NUM)
put(ws, rl + 3, 1, '등급: 물량 큰 순서로 누적 80%까지 A, 95%까지 B, 나머지 C. 상태: 최근 4주 출고가 없으면 종료, 2월 이후 처음 나갔으면 신규, 그 밖은 상시.', F)
put(ws, rl + 4, 1, f"[L]오리지널 10개입은 출고 시트에서 오리지널 10개입으로 적혀 {X_}까지는 오리지널(10개입)에 들어 있습니다. 그래서 추세 값이 실제보다 크게 나옵니다.", F)
ws.freeze_panes = 'C4'

# ── 행사 주
ws = wb.create_sheet('행사주')
put(ws, 1, 1, f"행사 주: B2C 판매상품·세트 합계가 평시의 1.5배 이상인 주 ({F_['nSpike']}주 / 꽉 찬 {F_['nFull']}주)", FB)
put(ws, 2, 1, '평시 주 물량(중앙값)', FB); put(ws, 2, 3, F_['medT'], FBLUE, NUM)
put(ws, 2, 5, '꽉 찬 주 전체 물량', FB); put(ws, 2, 7, F_['spikeQty'] / F_['spikeShare'], FBLUE, NUM)
head(ws, 4, ['주차', '기간', '물량', '평시 대비', '평시 초과분', '많이 늘어난 SKU (그 주 수량)', '많이 늘어난 채널 (주문 기준)', '프로모션 캘린더에 적힌 행사 (예상 수량 큰 순)', '비고'], [7, 13, 10, 9, 11, 58, 34, 80, 22])
r0 = 5
for i, s in enumerate(P['spikes']):
    y = r0 + i
    put(ws, y, 1, f"W{s['w']:02d}", F, None, None, CENTER); put(ws, y, 2, f"{md2(s['from'])}~{md2(s['to'])}", F, None, None, CENTER)
    put(ws, y, 3, s['qty'], F, NUM); put(ws, y, 4, f'=C{y}/$C$2', F, '0.0"배"'); put(ws, y, 5, f'=C{y}-$C$2', F, NUM)
    put(ws, y, 6, ' / '.join(s['skus']), F, None, None, WRAP); put(ws, y, 7, ' / '.join(s['channels']), F, None, None, WRAP)
    put(ws, y, 8, '캘린더 기록 전 (5/18부터 기록)' if s['promos'] is None else (' / '.join(s['promos']) or '캘린더에 없음'), F, None, None, WRAP)
    put(ws, y, 9, s['note'], F, None, None, WRAP)
    ws.row_dimensions[y].height = 42
y = r0 + len(P['spikes'])
put(ws, y, 2, '행사 주 합계', FB); put(ws, y, 3, f'=SUM(C{r0}:C{y - 1})', FB, NUM); put(ws, y, 5, f'=SUM(E{r0}:E{y - 1})', FB, NUM)
put(ws, y + 1, 2, '전체 대비 비중', FB); put(ws, y + 1, 3, f'=C{y}/$G$2', FB, PCT); put(ws, y + 1, 5, f'=E{y}/$G$2', FB, PCT)
put(ws, y + 3, 1, '채널 수량은 출고 시트 주문(주문일 다음 날 기준)이라 출고 수량과 조금 다릅니다. 쿠팡·컬리·B마트·GS리테일 행사는 대량출고라 뺐습니다.', F)
ws.freeze_panes = 'C5'

# ── 계절지수
ws = wb.create_sheet('계절지수')
put(ws, 1, 1, '월별 일평균과 지수 (지수 = 그 달 일평균 ÷ 기간 전체 일평균) · 1년치뿐이라 계절과 성장을 구분하지 못합니다', FB)
head(ws, 3, ['월', '일수', '물량', '일평균', '지수'], [8, 8, 11, 10, 8])
r0 = 4; n = len(P['season']); rl = r0 + n - 1
for i, s in enumerate(P['season']):
    y = r0 + i
    put(ws, y, 1, f"{s['m']}월", F, None, EST if s['m'] <= 4 else None, CENTER); put(ws, y, 2, s['days'], F, NUM)
    put(ws, y, 3, f"=SUMIF('월별'!$A$6:$A$200,\"판매상품\",'월별'!{L(5 + s['m'])}$6:{L(5 + s['m'])}$200)+SUMIF('월별'!$A$6:$A$200,\"세트\",'월별'!{L(5 + s['m'])}$6:{L(5 + s['m'])}$200)", FGREEN, NUM)
    put(ws, y, 4, f'=C{y}/B{y}', F, NUM); put(ws, y, 5, f'=D{y}/(SUM($C${r0}:$C${rl})/SUM($B${r0}:$B${rl}))', F, '0.00')
put(ws, rl + 1, 1, '합계', FB); put(ws, rl + 1, 2, f'=SUM(B{r0}:B{rl})', FB, NUM); put(ws, rl + 1, 3, f'=SUM(C{r0}:C{rl})', FB, NUM); put(ws, rl + 1, 4, f'=C{rl + 1}/B{rl + 1}', FB, NUM)
y0 = rl + 4
put(ws, y0 - 1, 1, '상시 SKU별 지수 (각 SKU의 기간 일평균 = 1.00)', FB)
head(ws, y0, ['SKU'] + [f"{m}월" for m in P['months']])
ws.column_dimensions['A'].width = 30
for i, s in enumerate(P['seasonSku']):
    put(ws, y0 + 1 + i, 1, s['name'])
    for j, v in enumerate(s['idx'], 2): put(ws, y0 + 1 + i, j, round(v, 2), F, '0.00')

# ── 2027 기준선
ws = wb.create_sheet('2027기준선')
put(ws, 1, 1, '2027 B2C 기준선 초안: 올해 수준이 그대로 반복된다고 볼 때의 월 물량 (EA)', FT)
put(ws, 3, 1, '성장률', FB); put(ws, 3, 3, 0, FBLUE, '0%', INP); put(ws, 3, 4, '← 노란 칸에 내년 성장률을 넣으면 아래 [2027 기준선]이 바뀝니다. 12월 노란 칸은 12월 실적이 쌓이면 넣습니다.', F)
put(ws, 4, 1, '글자색: 초록 = 월별 탭 실적을 끌어온 값, 파랑 = 추정해 넣은 값(고칠 수 있음). 종료된 SKU는 뺐습니다.', F)
labels = ['구분', 'SKU', '상태', '넣은 방법'] + [f'{m}월' for m in range(1, 13)] + ['합계']
B = P['base']; r0 = 7; r1 = r0 + len(B) + 4
put(ws, r0 - 1, 1, '[기준 수량] 성장률을 곱하기 전', FB); head(ws, r0, labels, [9, 36, 7, 40] + [9] * 12 + [11])
put(ws, r1 - 1, 1, '[2027 기준선] 기준 수량 × (1 + 성장률)', FB); head(ws, r1, labels)
for i, b in enumerate(B):
    ya, yb = r0 + 1 + i, r1 + 1 + i
    for y in (ya, yb):
        for j, v in enumerate([b['cat'], b['name'], b['status'], b['how']], 1): put(ws, y, j, v)
    for m in range(1, 13):
        c = 4 + m; v = b['vals'][m - 1]
        if v is None: put(ws, ya, c, None, FBLUE, NUM, INP if (m == 12 or b['how'].startswith('이력')) else None)
        elif b['status'] == '상시' and m <= 10: put(ws, ya, c, f"='월별'!{L(5 + m)}{row_m[(b['name'], b['code'])]}", FGREEN, NUM)
        else: put(ws, ya, c, v, FBLUE, NUM)
        put(ws, yb, c, f'=IF({L(c)}{ya}="","",ROUND({L(c)}{ya}*(1+$C$3),0))', F, NUM)
    for y in (ya, yb): put(ws, y, 17, f'=SUM(E{y}:P{y})', FB, NUM)
for base_row, n0 in ((r0, r0 + 1), (r1, r1 + 1)):
    y = n0 + len(B); put(ws, y, 2, '합계', FB)
    for c in range(5, 18): put(ws, y, c, f'=SUM({L(c)}{n0}:{L(c)}{y - 1})', FB, NUM, GRP)
ws.freeze_panes = 'E8'

# ── 채널별 월 (주문 기준)
ws = wb.create_sheet('채널별_월')
put(ws, 1, 1, 'B2C 채널별 월 수량 (단품 환산 EA) · 출고 시트 주문 기준(주문일 다음 날) · 출고 수량과 합계가 조금 다릅니다', FB)
head(ws, 3, ['채널', '합계', '비중'] + [f'{m}월' for m in P['months']], [26, 11, 8] + [9] * 11)
r0 = 4; n = len(P['channels']); rl = r0 + n - 1
for i, c in enumerate(P['channels']):
    y = r0 + i; put(ws, y, 1, c['name']); put(ws, y, 2, f'=SUM(D{y}:{L(3 + len(P["months"]))}{y})', FB, NUM); put(ws, y, 3, f'=B{y}/SUM($B${r0}:$B${rl})', F, PCT)
    for j, v in enumerate(c['m'], 4): put(ws, y, j, v, F, NUM)
put(ws, rl + 1, 1, '합계', FB)
for c in [2] + list(range(4, 4 + len(P['months']))): put(ws, rl + 1, c, f'=SUM({L(c)}{r0}:{L(c)}{rl})', FB, NUM, GRP)

# ── 요약 (맨 앞)
ws = wb.create_sheet('요약', 0); ws.column_dimensions['A'].width = 150
d5 = next(x for x in P['diag'] if x['code'] == '202927000005')
lines = [
    ('B2C SKU 출고 2026 — 내년 계획 기초 자료', FT),
    (f"범위: B2C 택배만. 2026-01-01 ~ {P['end']}. {A_} 이후는 아워박스 실출고, 그 전은 출고 시트 주문으로 추정(노란 칸).", F), ('', F),
    ('먼저 볼 것', FB),
    (f"1. 평균으로 계획하면 틀립니다. 꽉 찬 {F_['nFull']}주 중 {F_['nSpike']}주에 물량의 {F_['spikeShare'] * 100:.0f}%가 몰렸습니다. 평시는 주 {F_['medT']:,.0f}개, 행사 주는 6,000~7,800개입니다. → [행사주]", F),
    (f"2. SKU {F_['aN']}개가 물량의 {F_['aShare'] * 100:.0f}%입니다. 오리지널(10개입) 하나가 {P['diag'][0]['share'] * 100:.0f}%입니다. → [SKU진단]", F),
    (f"3. 늘고 있는 것은 오리지널(5개입)입니다. 최근 13주 평시가 주 {d5['r13']:,.0f}개로 그 전({d5['prior']:,.0f}개)보다 {d5['trend'] * 100:+.0f}%입니다. 오리지널(10개입)은 제자리입니다.", F),
    (f"4. 11월 1~{P['mdays'][-1]}일 오리지널(10개입)은 하루 {F_['o10nov']:,.0f}개로 10월({F_['o10oct']:,.0f}개)의 {F_['o10nov'] / F_['o10oct'] * 100:.0f}%입니다. 10/28~31 '감자빵 인상 전 앵콜 특가' 직후입니다. 가격 인상 영향인지 당겨 산 반동인지는 {P['mdays'][-1]}일치로 가릴 수 없습니다.", F),
    (f"5. 올해 새로 나간 SKU {F_['newN']}개가 {F_['newShare'] * 100:.0f}%, 끝난 SKU {F_['endN']}개가 {F_['endShare'] * 100:.0f}%입니다. 내년 기준선에서 끝난 SKU는 뺐습니다. → [2027기준선]", F),
    (f"6. 일평균은 4월이 가장 높고({P['season'][3]['avg']:,.0f}개) 1월이 가장 낮습니다({P['season'][0]['avg']:,.0f}개). 1년치뿐이라 계절 탓인지 성장 탓인지는 구분하지 못합니다. → [계절지수]", F), ('', F),
    ('탭 안내', FB),
    ('월별 / 주차별: SKU별 실적. 월은 달력 월(날짜 기준)이라 월 경계에 걸친 주는 날짜대로 나뉩니다. 주차별 2행에 그 주가 속한 달을 적었습니다.', F),
    ('SKU진단: 상태(상시·신규·종료), 등급, 평시 주 물량, 행사 주 수, 추세.', F),
    ('행사주: 물량이 평시의 1.5배를 넘은 주와 그 주에 늘어난 SKU·채널·프로모션 캘린더 행사.', F),
    ('2027기준선: 올해 수준 반복 가정의 월 물량. 성장률 칸 하나로 조정합니다.', F),
    ('채널별_월: 채널별 월 수량(주문 기준).', F), ('', F),
    ('숫자의 기준과 한계', FB),
    (f"택배 = 송장이 있는 출고 + 홈쇼핑 직택배. {A_} 이후는 출고완료일·상품코드 기준(아워박스 출고실적, /inven 화면과 같은 규칙).", F),
    (f"1/1~{X_}은 출고 시트 주문에서 세트를 단품으로 풀고 주문일 다음 날을 출고일로 봤습니다. 같은 방법을 {A_} 이후에 적용하면 실출고와 합계 +2.4%, 주 단위 오차 중앙값 4.0%입니다.", F),
    ('1~3월 출고 시트가 그때의 모든 채널을 담고 있는지는 확인하지 못했습니다. 빠진 채널이 있으면 1~3월이 실제보다 작게 나옵니다.', F),
    ('12월 자료는 없습니다. 올해 12월 실적이 쌓이면 다시 받아 채웁니다.', F),
    ('증정품·부자재는 주문에 잡히지 않고 같이 나가는 수량이 많아 추정 구간에서는 적게 잡힙니다. 진단·기준선은 판매상품·세트만 다룹니다.', F),
    ('합계·비중·지수·기준선은 수식입니다. 평시·행사 주 수 같은 진단 값은 계산해 넣은 값입니다.', F),
]
for i, (t, f) in enumerate(lines, 1): put(ws, i, 1, t, f)
wb.save(sys.argv[2]); print('sheets', wb.sheetnames)
