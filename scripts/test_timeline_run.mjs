import path from 'node:path'
import { pathToFileURL } from 'node:url'

const HOME = process.env.DSH_TTS_HOME || path.resolve(import.meta.dirname, '..', '..')
const mod = await import(pathToFileURL(`${HOME}/dsh-tts/lib/index.js`).href)
let tools = {}
const ctx = { tools: { register: (t) => { tools[t.name] = t } } }
const root = { inject: (_d, fn) => fn(ctx), logger: { info() {}, warn() {} } }
mod.apply(root, {
  port: 17322,
  pythonPath: `${HOME}/ComfyUI/ComfyUI_windows_portable/python_embeded/python.exe`,
  libs: `${HOME}/_tts_probe/pylibs`,
  models: { custom: `${HOME}/models/Qwen3-TTS-0.6B-CustomVoice`, design: `${HOME}/models/Qwen3-TTS-1.7B-VoiceDesign`, base: `${HOME}/models/Qwen3-TTS-0.6B-Base`, asr: `${HOME}/models/Qwen3-ASR-0.6B` },
  workDir: `${HOME}/配音`, idleShutdownMs: 300000, defaultVoice: 'Dylan',
  logFile: `${HOME}/配音/tool-test.log`,
})
const out = await tools['voiceover_timeline'].execute({
  xmlFile: `${HOME}/dsh-tts/scripts/fixtures/sample.fcpxml`,
  scriptFile: `${HOME}/dsh-tts/scripts/fixtures/sample.txt`,
  stage: 'run', outDir: `${HOME}/配音/_tl_test`,
}, { agent: { session: { cwd: `${HOME}` } } })
console.log('stage=' + out.stage)
console.log(out.message)
console.log('files:')
for (const f of out.files) console.log('  ' + f)