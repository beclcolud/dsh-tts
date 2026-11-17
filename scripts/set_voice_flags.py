import json, pathlib
p = pathlib.Path(r'E:/<工作区>/配音/voicebank/index.json')
d = json.loads(p.read_text(encoding='utf-8'))
for k, v in d.items():
    if v.get('kind') == 'base':
        v.setdefault('voice', {})['blur'] = False
        print('blur=false ->', k)
p.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding='utf-8')