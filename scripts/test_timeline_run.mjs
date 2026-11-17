import { pathToFileURL } from 'node:url'
const mod = await import(pathToFileURL('E:/<工作区>/dsh-tts/lib/index.js').href)
let tools = {}
const ctx = { tools: { register: (t) => { tools[t.name] = t } } }
const root = { inject: (_d, fn) => fn(ctx), logger: { info() {}, warn() {} } }
mod.apply(root, {
  port: 17322,
  pythonPath: 'E:/<工作区>/ComfyUI/ComfyUI_windows_portable/python_embeded/python.exe',
  libs: 'E:/<工作区>/_tts_probe/pylibs',
  models: { custom: 'E:/<工作区>/models/Qwen3-TTS-0.6B-CustomVoice', design: 'E:/<工作区>/models/Qwen3-TTS-1.7B-VoiceDesign', base: 'E:/<工作区>/models/Qwen3-TTS-0.6B-Base', asr: 'E:/<工作区>/models/Qwen3-ASR-0.6B' },
  workDir: 'E:/<工作区>/配音', idleShutdownMs: 300000, defaultVoice: 'Dylan',
  logFile: 'E:/<工作区>/配音/tool-test.log',
})
const out = await tools['voiceover_timeline'].execute({
  xmlFile: 'E:/<工作区>/dsh-tts/scripts/fixtures/sample.fcpxml',
  scriptFile: 'E:/<工作区>/dsh-tts/scripts/fixtures/sample.txt',
  stage: 'run', outDir: 'E:/<工作区>/配音/_tl_test',
}, { agent: { session: { cwd: 'E:/<工作区>' } } })
console.log('stage=' + out.stage)
console.log(out.message)
console.log('files:')
for (const f of out.files) console.log('  ' + f)