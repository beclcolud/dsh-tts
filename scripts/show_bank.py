import json, pathlib
d = json.loads(pathlib.Path(r'E:/<工作区>/配音/voicebank/index.json').read_text(encoding='utf-8'))
e = d['bili音色-1116']
print(json.dumps(e.get('voice'), ensure_ascii=False)[:400])