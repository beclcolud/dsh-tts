import path from 'node:path'
import { pathToFileURL } from 'node:url'

const HOME = process.env.DSH_TTS_HOME || path.resolve(import.meta.dirname, '..', '..')
const mod = await import(pathToFileURL(`${HOME}/dsh-tts/lib/index.js`).href)
let tools = {}
const ctx = { tools: { register: (t) => { tools[t.name] = t } } }
const root = { inject: (_d, fn) => fn(ctx), logger: { info() {}, warn() {} } }
mod.apply(root, { port: 17322, pythonPath: 'x', libs: 'y', models: {}, workDir: `${HOME}/配音`, idleShutdownMs: 300000 })
const tool = tools['voiceover_timeline']
if (!tool) throw new Error('工具没注册')
console.log('已注册工具:', Object.keys(tools).join(', '))
const out = await tool.execute({ xmlFile: `${HOME}/dsh-tts/scripts/fixtures/sample.fcpxml`, scriptFile: `${HOME}/dsh-tts/scripts/fixtures/sample.txt`, stage: 'plan' }, { agent: { session: { cwd: `${HOME}` } } })
console.log('stage=' + out.stage)
console.log(out.message)