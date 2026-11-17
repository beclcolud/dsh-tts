import json, re, pathlib
p = pathlib.Path(r'E:/<工作区>/配音/voicebank/index.json')
if not p.exists():
    print('no bank'); raise SystemExit
d = json.loads(p.read_text(encoding='utf-8'))
out = {}
renamed = []
for k, v in d.items():
    m = re.match(r'^(.*?)-(\d{4}(?:-\d+)?)$', k)
    if m and len(m.group(1)) > 12:
        base = m.group(1).split('，')[0][:12]
        nk = base + '-' + m.group(2)
        v['name'] = nk
        renamed.append((k, nk))
    else:
        nk = k
    while nk in out:
        nk = nk + 'x'
        v['name'] = nk
    out[nk] = v
p.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')
print('entries:', len(out))
for a, b in renamed: print(' -', a[:28], '=>', b)