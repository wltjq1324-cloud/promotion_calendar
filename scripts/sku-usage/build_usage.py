# 2026 SKU 주차별 출고 데이터셋: 아워박스 실출고(첫 출고일~) + 출고 시트 주문 추정(1/1~첫 출고 전날)
# 사용: python3 build_usage.py ../../sku-usage-2026.json productRows.json ../../inventory-latest.json dataset.json
#       python3 build_xlsx.py dataset.json SKU_주차별_출고_2026.xlsx
# productRows.json = 시트 "*아워박스_DB_초안" 숨김 탭 dashboard_cache 의 section=productRows 조각(C열)을 이어 붙인 JSON 배열
#   [{date, channel, product(표준품목명), qty, ...}]. 매출·마진이 들어 있어 저장소에 올리지 않는다.
import json, sys, re, collections, datetime, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sheet_decompose import decompose

usage = json.load(open(sys.argv[1])); rows = json.load(open(sys.argv[2])); inv = json.load(open(sys.argv[3]))
LAG = 1   # 주문일 + 1일을 출고일로 본다(겹치는 기간에서 주 단위 오차가 가장 작은 값)
END = max(d['date'] for d in usage['days'] if not d.get('partial') and d['rows'] > 0)
Y0 = '2026-01-01'
D = datetime.date.fromisoformat
def wk(d): return D(d).isocalendar()[1]          # ISO 주차(월요일 시작). 1/1~1/4 는 W01
def norm(s): return re.sub(r'[\s()\[\]]', '', s or '')

# ── 재고 스냅샷: 상품코드 → 구분·이름
inv_by = {}
for it in inv['items']:
    e = inv_by.setdefault(it['product_code'], {'name': it['product_name'], 'cat': it['category'], 'cc': set()})
    if it.get('company_code'): e['cc'].add(it['company_code'])
def category(name, code):
    if code in inv_by: return inv_by[code]['cat']
    if '프리미엄 선물 세트' in name: return '세트'
    if re.search(r'보냉백|가방|아이스박스|엽서|박스|아이스팩|테이프|스티커', name): return '부자재'
    if re.search(r'굿즈|키링|포크|라한|증정', name): return '증정품'
    if re.search(r'세트', name) and not re.search(r'선물세트 1[02]0g', name): return '세트'
    return '판매상품'

# ── 아워박스: 상품코드별 일별 택배 / 대량
api_p = collections.defaultdict(collections.Counter); api_b = collections.defaultdict(collections.Counter)
bulk_ch = collections.Counter(); parcel_ch = collections.Counter()
for d in usage['days']:
    dt = d['date']
    if dt > END or dt < Y0: continue
    for c, q in d['parcel'].items(): api_p[c][dt] += q
    for c, q in d['bulk'].items(): api_b[c][dt] += q
    for ch, m in d['bulkCh'].items(): bulk_ch[ch] += sum(m.values())
    for ch, m in d['parcelCh'].items(): parcel_ch[ch] += sum(m.values())
api_names = {c: re.sub(r'\s{2,}', ' ', (v.get('name') or inv_by.get(c, {}).get('name') or c)) for c, v in usage['products'].items()}
codes = sorted(set(api_p) | set(api_b))  # list
first_api = min(dt for c in codes for dt in list(api_p[c]) + list(api_b[c]))
API_START = first_api
EST_END = (D(API_START) - datetime.timedelta(days=1)).isoformat()

# ── 시트: 단품명별 일별 수량 (주문일 기준)
sh = collections.defaultdict(collections.Counter)
sh_bulkish = collections.defaultdict(collections.Counter)   # 아워박스가 대량으로 세는 채널(검증에서 뺀다)
for r in rows:
    dt = (D(r['date']) + datetime.timedelta(days=LAG)).isoformat()
    if not (Y0 <= dt <= END): continue
    for k, m in decompose(r['product']).items():
        sh[k][dt] += r['qty'] * m
        if r['channel'] in ('다이클로', '롯데홈쇼핑-업체배송'): sh_bulkish[k][dt] += r['qty'] * m

# ── 시트 단품명 → 상품코드 연결: 이름이 같으면 자동, 나머지는 손으로
MANUAL = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'link_manual.json'))) if os.path.exists(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'link_manual.json')) else {}
by_norm = collections.defaultdict(list)
for c in codes: by_norm[norm(api_names[c])].append(c)
link = {}
for k in sh:
    if k in MANUAL: link[k] = MANUAL[k]
    elif len(by_norm.get(norm(k), [])) == 1: link[k] = by_norm[norm(k)][0]
    else: link[k] = None

# ── 행 만들기
days_all = [(D(Y0) + datetime.timedelta(days=i)).isoformat() for i in range((D(END) - D(Y0)).days + 1)]
weeks = sorted({wk(d) for d in days_all})
w_days = {w: [d for d in days_all if wk(d) == w] for w in weeks}
months = sorted({int(d[5:7]) for d in days_all})
bulk_w0 = wk(API_START)
out_rows = []
def series(code, sname):
    p = collections.Counter(); b = collections.Counter()
    if sname:
        for dt, q in sh[sname].items():
            if dt < API_START or code is None: p[dt] += q      # 연결 안 된 단품은 4/17 뒤에도 시트 값
    if code:
        for dt, q in api_p[code].items():
            if dt >= API_START: p[dt] += q
        for dt, q in api_b[code].items(): b[dt] += q
    return p, b
linked_codes = {c: k for k, c in link.items() if c}
for c in linked_codes:
    if c not in codes: codes.append(c); api_names[c] = inv_by.get(c, {}).get('name', linked_codes[c])
keys = [(c, linked_codes.get(c)) for c in codes] + [(None, k) for k in sh if not link[k]]
for code, sname in keys:
    p, b = series(code, sname)
    name = api_names[code] if code else sname
    row = {
        'cat': category(name, code), 'name': name, 'code': code or '', 'cc': '/'.join(sorted(inv_by.get(code, {}).get('cc', []))) or (usage['products'].get(code, {}).get('company', '') if code else ''),
        'src': 'both' if (code and sname) else ('api' if code else 'sheet'),
        'pw': [sum(p[d] for d in w_days[w]) for w in weeks],
        'bw': [sum(b[d] for d in w_days[w]) if w >= bulk_w0 else None for w in weeks],
        'pm': [sum(q for d, q in p.items() if int(d[5:7]) == m) for m in months],
        'bm': [sum(q for d, q in b.items() if int(d[5:7]) == m) if m >= 4 else None for m in months],
        # 합계(택배+대량)용: 4/17 이후 택배만
        'prw': [sum(p[d] for d in w_days[w] if d >= API_START) if w >= bulk_w0 else None for w in weeks],
        'prm': [sum(q for d, q in p.items() if int(d[5:7]) == m and d >= API_START) if m >= 4 else None for m in months],
        'pEst': sum(q for d, q in p.items() if d < API_START), 'pReal': sum(q for d, q in p.items() if d >= API_START and code),
    }
    row['pt'] = sum(row['pw']); row['bt'] = sum(v or 0 for v in row['bw'])
    if row['pt'] + row['bt'] > 0: out_rows.append(row)
CAT = {'판매상품': 0, '세트': 1, '증정품': 2, '부자재': 3}
out_rows.sort(key=lambda r: (CAT.get(r['cat'], 9), -(r['pt'] + r['bt'])))

# ── 검증: 4/17~END 겹치는 구간에서 시트 추정 vs 실출고 (연결된 SKU)
VAL_ALIAS = {'202927000001': ['202927000028']}   # [L]오리지널 10개입은 시트에서 오리지널 10개입으로 적힌다
val = []
for k, c in link.items():
    if not c or category(api_names[c], c) not in ('판매상품', '세트'): continue
    cs = [c] + VAL_ALIAS.get(c, [])
    s = sum(q for d, q in sh[k].items() if d >= API_START) - sum(q for d, q in sh_bulkish[k].items() if d >= API_START)
    a = sum(q for x in cs for d, q in api_p[x].items() if d >= API_START)
    val.append({'sheet': k, 'code': c, 'api_name': api_names[c] + (' (+[L])' if len(cs) > 1 else ''), 'est': s, 'real': a, 'pct': round((s - a) / a * 100, 1) if a else None})
val.sort(key=lambda v: -v['real'])
# 주 단위 오차(검증 대상 합계, 꽉 찬 주만)
vk = [(k, [c] + VAL_ALIAS.get(c, [])) for k, c in link.items() if c and category(api_names[c], c) in ('판매상품', '세트')]
werr = []
for w in weeks:
    ds = w_days[w]
    if len(ds) < 7 or ds[0] < API_START: continue
    e = sum(sh[k][d] - sh_bulkish[k][d] for k, _ in vk for d in ds); a = sum(api_p[x][d] for _, cs in vk for x in cs for d in ds)
    if a: werr.append(abs(e - a) / a)
werr.sort()

zero_inv = [v['name'] for c, v in inv_by.items() if v['cat'] != '부자재' and not any(r['code'] == c for r in out_rows)]
data = {
    'end': END, 'apiStart': API_START, 'estEnd': EST_END, 'lag': LAG, 'generated': usage['generated_at'],
    'weekErr': {'median': round(werr[len(werr) // 2] * 100, 1), 'p90': round(werr[int(len(werr) * .9)] * 100, 1), 'n': len(werr)},
    'weeks': [{'w': w, 'from': w_days[w][0][5:], 'to': w_days[w][-1][5:], 'n': len(w_days[w]),
               'src': 'est' if w_days[w][-1] < API_START else ('real' if w_days[w][0] >= API_START else 'mix')} for w in weeks],
    'months': months, 'rows': out_rows, 'val': val, 'zeroInv': zero_inv,
    'bulkCh': bulk_ch.most_common(), 'parcelCh': parcel_ch.most_common(12),
    'mismatch': usage['mismatches'], 'calls': usage['calls'],
}
json.dump(data, open(sys.argv[4], 'w'), ensure_ascii=False)

# ── 보고
print('END', END, '| 첫 아워박스 출고일', first_api, '| 호출', usage['calls'], '| 행수 불일치', usage['mismatches'])
print('주차', weeks[0], '~', weeks[-1], '| 행', len(out_rows), '| 택배 합', sum(r['pt'] for r in out_rows), '| 대량 합', sum(r['bt'] for r in out_rows))
print('\n[연결 안 된 시트 단품] (이름, 아워박스 시작 전, 시작 뒤)')
for k in sh:
    if not link[k]: print('  ', k, sum(q for d, q in sh[k].items() if d < API_START), sum(q for d, q in sh[k].items() if d >= API_START))
print('\n[시트에 짝이 없는 아워박스 상품코드] (코드, 이름, 택배, 대량, 첫날~끝날)')
for c in codes:
    if c not in linked_codes:
        ds = sorted(list(api_p[c]) + list(api_b[c]))
        print('  ', c, api_names[c], sum(api_p[c].values()), sum(api_b[c].values()), ds[0][5:], '~', ds[-1][5:])
print('\n[검증: 아워박스 시작일~END] 시트추정 / 실출고 / 차이%')
te = tr = 0
for v in val:
    te += v['est']; tr += v['real']
    print('  ', str(v['est']).rjust(7), str(v['real']).rjust(7), str(v['pct']).rjust(7), v['api_name'], '←', v['sheet'])
print('   합계', te, tr, round((te - tr) / tr * 100, 1), '| 주 단위 오차 중앙값·90분위·주 수', data['weekErr'])
print('\n대량 채널:', bulk_ch.most_common()); print('택배 채널 상위:', parcel_ch.most_common(12))
print('출고 0인 재고 SKU:', zero_inv)
