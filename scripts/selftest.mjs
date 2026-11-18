/**
 * Out-of-band self test: loads the plugin entry, stubs the Cordis context,
 * registers the tool and executes one real voiceover call. Lets the plugin be
 * validated without restarting DSH.
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const HOME = process.env.DSH_TTS_HOME || path.resolve(import.meta.dirname, '..', '..')

const cfg = {
  port: 17321,
  pythonPath: `${HOME}/ComfyUI/ComfyUI_windows_portable/python_embeded/python.exe`,
  libs: `${HOME}/_tts_probe/pylibs`,
  models: {
    custom: `${HOME}/models/Qwen3-TTS-0.6B-CustomVoice`,
    design: `${HOME}/models/Qwen3-TTS-1.7B-VoiceDesign`,
    base: `${HOME}/models/Qwen3-TTS-0.6B-Base`,
    asr: `${HOME}/models/Qwen3-ASR-0.6B`,
  },
  workDir: `${HOME}/配音`,
  idleShutdownMs: 300000,
  logFile: `${HOME}/配音/service.log`,
}

const mod = await import(pathToFileURL(`${HOME}/dsh-tts/lib/index.js`).href)
let tool = null
const ctx = { tools: { register: (t) => { tool = t } } }
const root = {
  inject: (_deps, fn) => fn(ctx),
  logger: { info: (m) => console.log('[info]', m), warn: (m) => console.log('[warn]', m) },
}
mod.apply(root, cfg)
if (!tool) throw new Error('tool 未注册')
console.log('[selftest] tool =', tool.name)

const exec = { agent: { session: { cwd: `${HOME}` } } }
const out = await tool.execute({
  text: '大家好，欢迎来到这一期的视频。今天我们聊一个很实际的话题：同样一杯牛奶，为什么有人喝了很舒服，有人却会胀气、拉肚子？答案，就藏在乳糖和你的肠道菌群里。',
  voice: 'Serena',
  title: 'selftest-video',
  video: true,
}, exec)
console.log('[selftest] RESULT', JSON.stringify(out, null, 2))