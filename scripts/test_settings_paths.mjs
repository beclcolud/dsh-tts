/**
 * 覆盖文件能不能把机器路径喂给插件。
 * 跑法：node scripts/test_settings_paths.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..')
let fail = 0
const ok = (c, label, extra) => {
  if (c) console.log('  ok   ' + label)
  else { fail += 1; console.log('  FAIL ' + label + (extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 200) : '')) }
}

async function boot(rawConfig) {
  const mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href + '?t=' + Math.random())
  const routes = {}
  const ctx = {
    tools: { register: () => {} },
    webServer: { register: (r) => { routes[r.path] = r.handler; return () => {} } },
    effect: (f) => { try { return f() } catch { return () => {} } },
    inject: (_deps, fn) => fn(ctx),
  }
  mod.apply({ inject: (_d, fn) => fn(ctx), logger: { info: () => {}, warn: () => {} } }, rawConfig)
  const res = { code: 0, body: '', writeHead(c) { this.code = c }, end(b) { this.body = b } }
  await routes['/api/dsh-tts/config.json']({ method: 'GET' }, res)
  return JSON.parse(res.body)
}

const BLANK = { port: 17321, pythonPath: '', libs: '', models: {}, workDir: '', mtModel: '', logFile: '' }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tts-set-'))
const fakeHome = path.join(tmp, 'home')
fs.mkdirSync(path.join(fakeHome, '.dsh-tts'), { recursive: true })
const settingsFile = path.join(fakeHome, '.dsh-tts', 'settings.json')
fs.writeFileSync(settingsFile, JSON.stringify({
  pythonPath: 'X:/py/python.exe',
  libs: 'X:/libs',
  models: { custom: 'X:/m/custom', base: 'X:/m/base', asr: 'X:/m/asr' },
  mtModel: 'X:/m/mt',
  workDir: 'X:/out',
  logFile: 'X:/out/s.log',
}, null, 2))

console.log('[1] 覆盖文件提供机器路径（配置文件里全空）')
const oldHome = process.env.USERPROFILE
process.env.USERPROFILE = fakeHome
process.env.HOME = fakeHome
const cfg = await boot(BLANK)
const v = cfg.values || {}
ok(v.pythonPath === 'X:/py/python.exe', 'pythonPath 来自覆盖文件', v.pythonPath)
ok(v.libs === 'X:/libs', 'libs 来自覆盖文件', v.libs)
ok(v.models && v.models.custom === 'X:/m/custom', 'models 来自覆盖文件', v.models)
ok(v.workDir === 'X:/out', 'workDir 来自覆盖文件', v.workDir)
ok(v.mtModel === 'X:/m/mt', 'mtModel 来自覆盖文件', v.mtModel)
ok(v.logFile === 'X:/out/s.log', 'logFile 来自覆盖文件', v.logFile)
ok(typeof cfg.settingsFile === 'string' && cfg.settingsFile.length > 0, '面板显示了覆盖文件位置', cfg.settingsFile)

console.log('[2] 没有覆盖文件时不崩、路径为空')
fs.rmSync(settingsFile)
const cfg2 = await boot(BLANK)
const v2 = cfg2.values || {}
ok(v2.pythonPath === '', 'pythonPath 为空', v2.pythonPath)
ok(v2.models && Object.keys(v2.models).length === 0, 'models 为空对象', v2.models)
ok(Array.isArray(cfg2.fields) && cfg2.fields.some((f) => f.key === 'pythonPath'), '参数页里有 pythonPath 这一项', cfg2.fields && cfg2.fields.length)

process.env.USERPROFILE = oldHome
fs.rmSync(tmp, { recursive: true, force: true })
console.log('')
console.log(fail === 0 ? '全部通过' : fail + ' 项失败')
process.exit(fail === 0 ? 0 : 1)
