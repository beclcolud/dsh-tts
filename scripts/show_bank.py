import json, pathlib
import os
from pathlib import Path

HOME = Path(os.environ.get('DSH_TTS_HOME') or Path(__file__).resolve().parents[2])
d = json.loads(pathlib.Path(str(HOME) + r"/配音/voicebank/index.json").read_text(encoding='utf-8'))
e = d['bili音色-1116']
print(json.dumps(e.get('voice'), ensure_ascii=False)[:400])