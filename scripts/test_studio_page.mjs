/**
 * 工作台页面自检：把服务端返回的 HTML 里的脚本抽出来
 *   ① 语法检查（new Function 只解析不执行）
 *   ② 用假 DOM 跑一遍：初始文案要被替换掉（对应"卡在正在连接服务…"）
 *   ③ 旧插件（status 没有 apiVersion）要提示重启，而不是让人看到 HTTP 404
 *   ④ 接口 404 时要给人话
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

console.log('[1] 脚本语法')
let syntaxError = ''
try { new Function(src) } catch (e) { syntaxError = String(e && e.message ? e.message : e) }
ok(syntaxError === '', '脚本能通过解析', syntaxError)

function makeEl(id) {
  return {
    id, textContent: '', innerHTML: '', style: {}, checked: false, value: '', disabled: false,
    classList: { add() {}, remove() {} },
    setAttribute() {}, getAttribute() { return '' }, addEventListener() {},
    appendChild() {}, onclick: null, oninput: null, closest() { return null },
  }
}
async function runPage(opts) {
  const els = {}
  for (const id of ['sub', 'err', 'compat', 'view', 'savecfg', 'cancel', 'refresh', 'newvoice', 'create', 'back']) els[id] = makeEl(id)
  const document = {
    getElementById: (id) => els[id] || (els[id] = makeEl(id)),
    querySelectorAll: () => [],
    addEventListener: () => {},
    activeElement: null,
    body: { style: {} },
  }
  const fetchStub = (url) => {
    const u = String(url)
    if (u.indexOf('status.json') >= 0) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(opts.status) })
    }
    if (u.indexOf('queue.json') >= 0 && opts.queue404) {
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) })
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(opts.other || { ok: true }) })
  }
  const windowStub = { location: { origin: 'http://x', href: '' }, open: () => null, alert: () => {}, close() {}, opener: null, self: {}, top: {} }
  const run = new Function('window', 'document', 'fetch', 'setInterval', 'setTimeout', 'Audio', 'navigator', src)
  run(windowStub, document, fetchStub, () => 0, (fn) => { try { fn() } catch { /* ignore */ } },
    function () { return { play: () => Promise.resolve() } }, { clipboard: { writeText: () => Promise.resolve() } })
  await new Promise((r) => setTimeout(r, 80))
  return els
}

console.log('[2] 正常运行（新插件）')
const a = await runPage({ status: { ok: true, online: false, loaded: null, idleS: 1, idleShutdownMs: 300000, apiVersion: 2, busyReq: null, busyS: null, progress: null } })
ok(a.sub.textContent !== '' && a.sub.textContent.indexOf('正在连接服务') < 0, '初始文案被替换', a.sub.textContent)
ok(a.view.innerHTML.length > 0, '视图区有内容')
ok((a.compat.innerHTML || '') === '', '新版插件不显示兼容提示', a.compat.innerHTML)

console.log('[3] 旧插件（没有 apiVersion）')
const b = await runPage({ status: { ok: true, online: false, idleS: 1, idleShutdownMs: 300000 } })
ok((b.compat.innerHTML || '').indexOf('重启 DSH') > 0, '提示需要重启 DSH', b.compat.innerHTML)

console.log('[4] 接口 404 要说人话')
const c = await runPage({ status: { ok: true, online: false, apiVersion: 2, idleShutdownMs: 300000 }, queue404: true })
const shown = String(c.compat.innerHTML || '') + String(c.err.innerHTML || '')
ok(shown.indexOf('重启 DSH') > 0, '404 提示里点明要重启', shown)

console.log('')
console.log(fail === 0 ? '全部通过' : fail + ' 项失败')
process.exit(fail === 0 ? 0 : 1)
