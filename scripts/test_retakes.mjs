import path from 'node:path'
import { pathToFileURL } from 'node:url'

const HOME = process.env.DSH_TTS_HOME || path.resolve(import.meta.dirname, '..', '..')
const mod = await import(pathToFileURL(`${HOME}/dsh-tts/lib/index.js`).href)
let tools = {}
const ctx = { tools: { register: (x) => { tools[x.name] = x } } }
const root = { inject: (_d, fn) => fn(ctx), logger: { info() {}, warn() {} } }
mod.apply(root, {
  port: 17322,
  pythonPath: `${HOME}/ComfyUI/ComfyUI_windows_portable/python_embeded/python.exe`,
  libs: `${HOME}/_tts_probe/pylibs`,
  models: { custom: `${HOME}/models/Qwen3-TTS-0.6B-CustomVoice`, design: `${HOME}/models/Qwen3-TTS-1.7B-VoiceDesign`, base: `${HOME}/models/Qwen3-TTS-0.6B-Base`, asr: `${HOME}/models/Qwen3-ASR-0.6B` },
  workDir: `${HOME}/配音`, idleShutdownMs: 900000, defaultVoice: 'bili音色-1116',
})
console.log('工具:', Object.keys(tools).join(', '))
const exec = { agent: { session: { cwd: `${HOME}` } } }
const text = '大家好，欢迎来到这一期的视频。今天我们聊一个很实际的话题：同样一杯牛奶，为什么有人喝了很舒服，有人却会胀气、拉肚子？答案，就藏在乳糖和你的肠道菌群里。'
const r1 = await tools['voiceover_retakes'].execute({ text, segment: 2, takes: 2 }, exec)
console.log(r1.stage, '|', r1.message.slice(0, 700))