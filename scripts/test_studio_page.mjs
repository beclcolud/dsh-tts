/**
 * 工作台页面自检：把服务端返回的 HTML 里的脚本抽出来
 *   ① 语法检查（new Function 只解析不执行）
 *   ② 用假 DOM 跑一遍，断言 "正在连接服务…" 会被渲染函数替换掉
 *
 * 这两条对应用户真实遇到的问题：脚本里一个被模板字符串吃掉的反斜杠，
 * 让整个脚本语法错误，页面就永远停在初始文案上。
 *
 * 运行：node scripts/test_studio_page.mjs
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

let fail = 0
const ok = (c, label, extra) => {
  if (c) console.log('  ok   ' + label)
  else { fail += 1; console.log('  FAIL ' + label + (extra === undefined ? '' : ' -> ' + String(JSON.stringify(extra)).slice(0, 220))) }
}

// ---- 从插件取页面 ----
const mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
const routes = {}
const ctx = {
  tools: { register: () => {} },
  webServer: { register: (r) => { routes[r.path] = r.handler; return () => {} } },
  effect: (fn) => { try { return fn() } catch { return () => {} } },
  inject: (_deps, fn) => fn(ctx),
}
mod.apply({ inject: (_d, fn) => fn(ctx), logger: { info: () => {}, warn: () => {} } }, {
  port: 17321, pythonPath: 'x', libs: 'y', models: {},
  workDir: path.join(ROOT, '..', '配音'), idleShutdownMs: 0, timeoutMs: 60000,
})

const res = { code: 0, headers: {}, body: '', writeHead(c, h) { this.code = c; this.headers = h }, end(b) { this.body = b } }
await routes['/api/dsh-tts/studio']({ method: 'GET' }, res)
const html = String(res.body)
ok(res.code === 200, '页面返回 200')
ok(html.indexOf('</html>') > 0, 'HTML 完整')

const m = html.match(/<script>([\s\S]*?)<\/script>/)
ok(!!m, '找到内联脚本')
const src = m ? m[1] : ''

// ---- ① 语法 ----
console.log('[1] 脚本语法')
let syntaxError = ''
try { new Function(src) } catch (e) { syntaxError = String(e && e.message ? e.message : e) }
ok(syntaxError === '', '脚本能通过解析', syntaxError)

// ---- ② 假 DOM 跑一遍 ----
console.log('[2] 冒烟运行')
function makeEl(id) {
  return {
    id, textContent: '', innerHTML: '', style: {}, checked: false, value: '',
    classList: { add() {}, remove() {} },
    setAttribute() {}, getAttribute() { return '' }, addEventListener() {},
    appendChild() {}, onclick: null,
  }
}
const els = {}
for (const id of ['sub', 'err', 'view', 'savecfg', 'cancel', 'refresh', 'newvoice', 'create', 'back']) els[id] = makeEl(id)

const document = {
  getElementById: (id) => els[id] || (els[id] = makeEl(id)),
  querySelectorAll: () => [],
  addEventListener: () => {},
  body: { style: {} },
  createElement: () => makeEl('x'),
}
const calls = []
const fetchStub = (url) => {
  calls.push(String(url))
  const body = String(url).indexOf('status.json') >= 0
    ? { ok: true, online: false, loaded: null, idleS: 1, idleShutdownMs: 300000, busyReq: null, busyS: null, progress: null }
    : { ok: true, files: [], entries: {}, fields: [], values: {}, readonly: [] }
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
}
const windowStub = { location: { origin: 'http://127.0.0.1:1', href: '' }, open: () => null, alert: () => {}, close() {}, opener: null, self: {}, top: {} }
const navigatorStub = { clipboard: { writeText: () => Promise.resolve() } }
const AudioStub = function () { return { play: () => Promise.resolve() } }

let runtimeError = ''
try {
  const run = new Function('window', 'document', 'fetch', 'setInterval', 'setTimeout', 'Audio', 'navigator', src)
  run(windowStub, document, fetchStub, () => 0, (fn) => { try { fn() } catch { /* ignore */ } }, AudioStub, navigatorStub)
  await new Promise((r) => setTimeout(r, 80))
} catch (e) {
  runtimeError = String(e && e.message ? e.message : e)
}
ok(runtimeError === '', '脚本启动不报错', runtimeError)
ok(calls.some((u) => /status\.json/.test(u)), '启动时请求了状态接口', calls.slice(0, 3))

const subText = els.sub.textContent
console.log('   #sub 最终文案: ' + JSON.stringify(subText))
ok(subText !== '' && subText.indexOf('正在连接服务') < 0, '「正在连接服务…」被替换掉了（不再卡死）', subText)
ok(els.view.innerHTML.length > 0, '视图区渲染出了内容', els.view.innerHTML.length)

console.log('')
console.log(fail === 0 ? '全部通过' : fail + ' 项失败')
process.exit(fail === 0 ? 0 : 1)
