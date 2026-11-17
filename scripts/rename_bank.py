import json, pathlib
p = pathlib.Path(r'E:/<工作区>/配音/voicebank/index.json')
d = json.loads(p.read_text(encoding='utf-8'))
out = {}; i = 0
for k, v in d.items():
    if v.get('kind') == 'base' and '克隆自' in k:
        i += 1
        nk = 'bili音色-1116' + ('' if i == 1 else '-%d' % i)
        v['name'] = nk; out[nk] = v; print('renamed ->', nk)
    else:
        out[k] = v
p.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')
print('total', len(out))