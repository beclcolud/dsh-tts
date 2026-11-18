import json, pathlib
import os
from pathlib import Path

HOME = Path(os.environ.get('DSH_TTS_HOME') or Path(__file__).resolve().parents[2])
p = pathlib.Path(str(HOME) + r"/配音/voicebank/index.json")
d = json.loads(p.read_text(encoding='utf-8'))
for k, v in d.items():
    if v.get('kind') == 'base':
        v.setdefault('voice', {})['blur'] = False
        print('blur=false ->', k)
p.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding='utf-8')