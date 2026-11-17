import { pathToFileURL } from 'node:url'
const mod = await import(pathToFileURL('E:/<工作区>/dsh-tts/lib/index.js').href)
let tools = {}
const ctx = { tools: { register: (t) => { tools[t.name] = t } } }
const root = { inject: (_d, fn) => fn(ctx), logger: { info() {}, warn() {} } }
mod.apply(root, { port: 17322, pythonPath: 'x', libs: 'y', models: {}, workDir: 'E:/<工作区>/配音', idleShutdownMs: 300000 })
const tool = tools['voiceover_timeline']
if (!tool) throw new Error('工具没注册')
console.log('已注册工具:', Object.keys(tools).join(', '))
const out = await tool.execute({ xmlFile: 'E:/<工作区>/dsh-tts/scripts/fixtures/sample.fcpxml', scriptFile: 'E:/<工作区>/dsh-tts/scripts/fixtures/sample.txt', stage: 'plan' }, { agent: { session: { cwd: 'E:/<工作区>' } } })
console.log('stage=' + out.stage)
console.log(out.message)