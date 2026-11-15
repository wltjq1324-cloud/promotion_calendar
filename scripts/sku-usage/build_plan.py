# B2C 계획 기초 자료: 월별·주차별 실적 + SKU 진단 + 행사 주 + 계절지수 + 2027 기준선
# 사용: python3 build_plan.py daily.json productRows.json promos.json plan.json
#   daily.json = build_usage.py 다섯째 인자로 만든 SKU별 일별 택배 수량
#   promos.json = 시트 "*OURBOX_프로모션_운영_DB" 프로모션 탭 [{title,start,end,channel,qty}]
import json, sys, re, os, collections, datetime, calendar, statistics as st
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sheet_decompose import decompose

daily = json.load(open(sys.argv[1])); prow = json.load(open(sys.argv[2])); promos = json.load(open(sys.argv[3]))
days, END, API_START, LAG = daily['days'], daily['end'], daily['apiStart'], daily['lag']
D = datetime.date.fromisoformat
md = lambda s: f"{int(s[5:7])}/{int(s[8:10])}"
wk_of = [D(x).isocalendar()[1] for x in days]
weeks = sorted(set(wk_of)); w_idx = {w: [i for i, x in enumerate(wk_of) if x == w] for w in weeks}
full = [w for w in weeks if len(w_idx[w]) == 7]
months = sorted({int(x[5:7]) for x in days}); m_idx = {m: [i for i, x in enumerate(days) if int(x[5:7]) == m] for m in months}
EST_END = (D(API_START) - datetime.timedelta(days=1)).isoformat()
SPIKE_SKU, SPIKE_ALL, ENDED_DAYS, RECENT = 2.0, 1.5, 28, 13
STATUS_FIX = {'202927000028': '상시'}   # [L]오리지널 10개입: 4/15까지는 오리지널(10개입) 행에 들어 있다
HOLIDAY = {7: '설 전주 (설날 2/17)', 38: '추석 전주 (추석 9/25)'}

rows = []
for r in daily['rows']:
    d = r['d']
    if sum(d) == 0: continue
    rows.append({**r, 'pw': {w: sum(d[i] for i in w_idx[w]) for w in weeks}, 'pm': {m: sum(d[i] for i in m_idx[m]) for m in months}, 'total': sum(d)})
CAT = {'판매상품': 0, '세트': 1, '증정품': 2, '부자재': 3}
rows.sort(key=lambda r: (CAT[r['cat']], -r['total']))
goods = [r for r in rows if r['cat'] in ('판매상품', '세트')]
G = sum(r['total'] for r in goods)

# ── SKU 진단
diag = []
for r in sorted(goods, key=lambda r: -r['total']):
    d = r['d']; nz = [i for i, v in enumerate(d) if v > 0]
    first, last = days[nz[0]], days[nz[-1]]
    act = [w for w in full if wk_of[nz[0]] <= w <= wk_of[nz[-1]]]
    med = st.median([r['pw'][w] for w in act]) if act else 0
    sp = [w for w in act if med > 0 and r['pw'][w] > SPIKE_SKU * med and r['pw'][w] >= 30]
    pk = max(full, key=lambda w: r['pw'][w])
    rec = [w for w in act if w > full[-1] - RECENT]; pri = [w for w in act if w <= full[-1] - RECENT]
    r13 = st.median([r['pw'][w] for w in rec]) if rec else None
    r13avg = st.mean([r['pw'][w] for w in rec]) if rec else None
    p0 = st.median([r['pw'][w] for w in pri]) if len(pri) >= 8 else None
    ended = (D(END) - D(last)).days > ENDED_DAYS
    status = STATUS_FIX.get(r['code']) or ('종료' if ended else ('신규' if first >= '2026-02-01' else '상시'))
    r.update(med=med, status=status, r13=r13, r13avg=r13avg, nrec=len(rec), first=first, last=last, act=len(act))
    diag.append({'name': r['name'], 'code': r['code'], 'cat': r['cat'], 'status': status, 'first': first, 'last': last, 'weeks': len(act),
                 'total': r['total'], 'share': r['total'] / G, 'med': med, 'nSpike': len(sp),
                 'spikeShare': sum(r['pw'][w] - med for w in sp) / r['total'] if r['total'] else 0,
                 'pkW': pk, 'pkQty': r['pw'][pk], 'pkMult': (r['pw'][pk] / med) if med else None,
                 'r13': r13, 'prior': p0, 'trend': ((r13 - p0) / p0) if (p0 and r13 is not None and status != '종료') else None})
cum = 0
for x in diag:
    cum += x['share']; x['cum'] = cum; x['grade'] = 'A' if cum - x['share'] < 0.8 else ('B' if cum - x['share'] < 0.95 else 'C')

# ── 채널(출고 시트 주문 기준, 주문일+LAG): 주차·월별 수량
ch_w = collections.defaultdict(collections.Counter); ch_m = collections.defaultdict(collections.Counter)
day_pos = {x: i for i, x in enumerate(days)}
for x in prow:
    if x['channel'] in ('다이클로', '롯데홈쇼핑-업체배송'): continue
    dt = (D(x['date']) + datetime.timedelta(days=LAG)).isoformat()
    if dt not in day_pos: continue
    q = sum(decompose(x['product']).values()) * x['qty']
    if not q: continue
    c = x['channel'] or '(채널 없음)'
    ch_w[c][wk_of[day_pos[dt]]] += q; ch_m[c][int(dt[5:7])] += q
ch_tot = {c: sum(v.values()) for c, v in ch_m.items()}; CT = sum(ch_tot.values())
ch_med = {c: st.median([ch_w[c][w] for w in full]) for c in ch_w}

# ── 행사 주(전체 B2C 상품 합계가 평시의 1.5배 이상인 주)
T = {w: sum(r['pw'][w] for r in goods) for w in weeks}
medT = st.median([T[w] for w in full])
bulkish = re.compile(r'쿠팡|컬리|B마트|GS리테일')
spikes = []
for w in full:
    if T[w] < SPIKE_ALL * medT: continue
    a, b = days[w_idx[w][0]], days[w_idx[w][-1]]
    up = sorted(((r['pw'][w] - r['med'], r) for r in goods), key=lambda t: -t[0])[:3]
    cu = sorted(((ch_w[c][w] - ch_med[c], c) for c in ch_w), key=lambda t: -t[0])[:2]
    ps = sorted((p for p in promos if p['start'] <= b and p['end'] >= a and not bulkish.search(p['title'])), key=lambda p: -p['qty'])
    spikes.append({'w': w, 'from': a, 'to': b, 'qty': T[w], 'mult': T[w] / medT, 'excess': T[w] - medT,
                   'skus': [f"{r['name']} {r['pw'][w]:,}" for u, r in up if u > 0],
                   'channels': [f"{c} {ch_w[c][w]:,}" for u, c in cu if u > 0],
                   'promos': [f"{p['title']} (예상 {p['qty']:,})" for p in ps[:3]] if b >= '2026-05-18' else None,
                   'nPromo': len(ps), 'note': HOLIDAY.get(w, '')})

# ── 계절지수: 월 일평균 ÷ 기간 일평균
overall = G / len(days)
season = [{'m': m, 'qty': sum(r['pm'][m] for r in goods), 'days': len(m_idx[m])} for m in months]
for s in season: s['avg'] = s['qty'] / s['days']; s['idx'] = s['avg'] / overall
season_sku = [{'name': r['name'], 'idx': [(r['pm'][m] / len(m_idx[m])) / (r['total'] / len(days)) for m in months]}
              for r in sorted(goods, key=lambda r: -r['total']) if r['status'] == '상시' and r['code'] not in STATUS_FIX][:6]

# ── 2027 기준선 초안: 상시 = 올해 월 실적 그대로(11월은 12일치 일평균×30), 신규 = 최근 13주 평균(행사 포함)을 매달 같게. 12월은 자료 없음
nov_i = m_idx[11]
base = []
for r in sorted(goods, key=lambda r: (CAT[r['cat']], -r['total'])):
    if r['status'] == '종료': continue
    if r['status'] == '상시':
        vals = [r['pm'][m] for m in range(1, 11)] + [round(sum(r['d'][i] for i in nov_i) / len(nov_i) * 30), None]
        est = [m < 4 or (m == 4) for m in range(1, 11)] + [True, False]
        how = '올해 월 실적 그대로'
    elif r['r13avg'] is not None and r['act'] >= 4:
        vals = [round(r['r13avg'] * calendar.monthrange(2027, m)[1] / 7) for m in range(1, 12)] + [None]
        est = [True] * 11 + [False]; how = f"최근 {r['nrec']}주 평균(주 {r['r13avg']:,.0f}개, 행사 포함)을 매달 같게"
    else:
        vals = [None] * 12; est = [False] * 12; how = '이력 부족(출고 4주 미만)'
    base.append({'name': r['name'], 'code': r['code'], 'cat': r['cat'], 'status': r['status'], 'vals': vals, 'est': est, 'how': how})

chan_names = [c for c, q in sorted(ch_tot.items(), key=lambda t: -t[1]) if q / CT >= 0.01]
channels = [{'name': c, 'm': [ch_m[c][m] for m in months], 'total': ch_tot[c]} for c in chan_names]
other = [sum(ch_m[c][m] for c in ch_m if c not in chan_names) for m in months]
channels.append({'name': '그 밖의 채널', 'm': other, 'total': sum(other)})

spike_qty = sum(s['qty'] for s in spikes)
A = [x for x in diag if x['grade'] == 'A']
def dayavg(r, m): return sum(r['d'][i] for i in m_idx[m]) / len(m_idx[m])
o10 = next(r for r in goods if r['code'] == '202927000001')
find = {
    'o10oct': dayavg(o10, 10), 'o10nov': dayavg(o10, 11), 'allOct': sum(dayavg(r, 10) for r in goods), 'allNov': sum(dayavg(r, 11) for r in goods),
    'total': G, 'allTotal': sum(r['total'] for r in rows), 'est': sum(sum(r['d'][i] for i, x in enumerate(days) if x < API_START) for r in goods),
    'medT': medT, 'nFull': len(full), 'nSpike': len(spikes), 'spikeQty': spike_qty, 'spikeShare': spike_qty / sum(T[w] for w in full),
    'spikeExcess': sum(s['excess'] for s in spikes),
    'aN': len(A), 'aShare': sum(x['share'] for x in A), 'nGoods': len(diag),
    'newN': sum(1 for x in diag if x['status'] == '신규'), 'newShare': sum(x['share'] for x in diag if x['status'] == '신규'),
    'endN': sum(1 for x in diag if x['status'] == '종료'), 'endShare': sum(x['share'] for x in diag if x['status'] == '종료'),
    'peakM': max(season[:-1], key=lambda s: s['avg'])['m'], 'lowM': min(season[:-1], key=lambda s: s['avg'])['m'],
    'baseTotal': sum(v for b in base for v in b['vals'] if v), 'chanTotal': CT,
}
out = {
    'end': END, 'apiStart': API_START, 'estEnd': EST_END, 'lag': LAG, 'find': find,
    'weeks': [{'w': w, 'from': days[w_idx[w][0]][5:], 'to': days[w_idx[w][-1]][5:], 'n': len(w_idx[w]),
               'src': 'est' if days[w_idx[w][-1]] < API_START else ('real' if days[w_idx[w][0]] >= API_START else 'mix')} for w in weeks],
    'months': months, 'mdays': [len(m_idx[m]) for m in months],
    'rows': [{'cat': r['cat'], 'name': r['name'], 'code': r['code'], 'src': r['src'], 'status': r.get('status', ''),
              'pw': [r['pw'][w] for w in weeks], 'pm': [r['pm'][m] for m in months], 'total': r['total']} for r in rows],
    'diag': diag, 'spikes': spikes, 'season': season, 'seasonSku': season_sku, 'base': base, 'channels': channels,
}
json.dump(out, open(sys.argv[4], 'w'), ensure_ascii=False)

# ── 보고
print(f"B2C 상품 {G:,} (전체 {find['allTotal']:,}) | 추정 {find['est']:,} | 주 중앙값 {medT:,.0f} | 행사 주 {len(spikes)}/{len(full)} · 물량 {find['spikeShare']*100:.0f}% · 초과분 {find['spikeExcess']:,.0f}")
print(f"A등급 {find['aN']}개 {find['aShare']*100:.0f}% | 신규 {find['newN']}개 {find['newShare']*100:.1f}% | 종료 {find['endN']}개 {find['endShare']*100:.1f}% | 기준선 합(1~11월) {find['baseTotal']:,}")
print('\n[SKU 진단] 상태 등급 합계 비중 | 평시 행사주 행사비중 | 최대주 배수 | 최근13 그전 추세 | 첫~끝')
for x in diag:
    tr = f"{x['trend']*100:+.0f}%" if x['trend'] is not None else '-'
    print(f"  {x['status']} {x['grade']} {x['total']:>6,} {x['share']*100:4.1f}% | {x['med']:>6,.0f} {x['nSpike']:>2} {x['spikeShare']*100:3.0f}% | W{x['pkW']} {x['pkQty']:,} x{(x['pkMult'] or 0):.1f} | {(x['r13'] if x['r13'] is not None else 0):,.0f} {(x['prior'] or 0):,.0f} {tr} | {x['first'][5:]}~{x['last'][5:]} {x['name']}")
print('\n[행사 주]')
for s in spikes: print(f"  W{s['w']} {md(s['from'])}~{md(s['to'])} {s['qty']:,} x{s['mult']:.1f} | {s['skus']} | {s['channels']} | {s['promos']} {s['note']}")
print('\n[계절지수]', [(s['m'], round(s['avg']), round(s['idx'], 2)) for s in season])
print('[채널]', [(c['name'], c['total'], round(c['total'] / CT * 100, 1)) for c in channels])
print('[기준선]'); [print('  ', b['status'], b['name'], b['vals'], '|', b['how']) for b in base]
