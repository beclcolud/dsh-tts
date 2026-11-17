import { pathToFileURL } from 'node:url'
const mod = await import(pathToFileURL('E:/<工作区>/dsh-tts/lib/index.js').href)
let tools = {}
const ctx = { tools: { register: (x) => { tools[x.name] = x } } }
const root = { inject: (_d, fn) => fn(ctx), logger: { info() {}, warn() {} } }
mod.apply(root, {
  port: 17322,
  pythonPath: 'E:/<工作区>/ComfyUI/ComfyUI_windows_portable/python_embeded/python.exe',
  libs: 'E:/<工作区>/_tts_probe/pylibs',
  models: { custom: 'E:/<工作区>/models/Qwen3-TTS-0.6B-CustomVoice', design: 'E:/<工作区>/models/Qwen3-TTS-1.7B-VoiceDesign', base: 'E:/<工作区>/models/Qwen3-TTS-0.6B-Base', asr: 'E:/<工作区>/models/Qwen3-ASR-0.6B' },
  workDir: 'E:/<工作区>/配音', idleShutdownMs: 900000, defaultVoice: 'bili音色-1116',
})
console.log('工具:', Object.keys(tools).join(', '))
const exec = { agent: { session: { cwd: 'E:/<工作区>' } } }
const text = '大家好，欢迎来到这一期的视频。今天我们聊一个很实际的话题：同样一杯牛奶，为什么有人喝了很舒服，有人却会胀气、拉肚子？答案，就藏在乳糖和你的肠道菌群里。'
const r1 = await tools['voiceover_retakes'].execute({ text, segment: 2, takes: 2 }, exec)
console.log(r1.stage, '|', r1.message.slice(0, 700))