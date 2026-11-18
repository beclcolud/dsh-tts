/**
 * 客户端注册逻辑的自动化检查（不需要浏览器）。
 * 运行：node scripts/test_client_wiring.mjs
 *
 * 只验证"注册了什么、用什么 key"，不渲染组件——界面观感仍需人眼验收。
 * 上次引导页卡片没出现，就是因为漏了 sidebarRightTabs.register；
 * 这个测试就是为了让那种错误能自动被发现。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..', 'lib', 'client.js')

let fail = 0
const ok = (c, label, extra) => {
  if (c) console.log('  ok   ' + label)
  else { fail += 1; console.log('  FAIL ' + label + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra))) }
}

// --- 假的浏览器环境 ---
const React = {
  createElement: (tag) => ({ tag }),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
}
let loaded = null
const window = {
  __ModuleLoader__: {
    load: (def) => { loaded = def },
    },
}
const realRequire = (name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
}

const code = fs.readFileSync(SRC, 'utf8')
const fn = new Function('window', 'console', code + '\nreturn window.__ModuleLoader__ && true')
fn(window, { warn: () => {}, log: () => {}, info: () => {} })
ok(!!loaded, '模块通过 __ModuleLoader__ 注册了自己')
const mod = loaded.factory(realRequire)
ok(typeof mod.apply === 'function' && typeof mod.name === 'string', '导出了 name/apply')

// --- 假的宿主 ctx ---
const tabTypes = []
const slotRegs = []
const slots = {
  register: (def, comp) => { slotRegs.push({ def, comp }); return () => {} },
  inject: (name, cb) => { cb(); return () => {} },
}
const services = {
  sidebarRightTabs: { register: (def) => { tabTypes.push(def); return () => {} } },
}
let warned = []
const ctx = {
  slots,
  effect: (f) => { try { return f() } catch (e) { return () => {} } },
  inject: (deps, cb) => {
    for (const d of deps) if (!services[d]) return
    cb(ctx)
  },
}
// 把服务挂到 ctx 上（cordis 的 inject 回调拿到的是同一个 ctx）
Object.assign(ctx, services)

mod.apply(ctx)

console.log('[1] 标签类型')
ok(tabTypes.length === 1, '注册了 1 个标签类型', tabTypes.length)
const def = tabTypes[0] || {}
ok(typeof def.id === 'string' && def.id, '有 id', def.id)
ok(typeof def.kind === 'string' && def.kind, '有 kind', def.kind)
ok(typeof def.title === 'function' && def.title() === '配音', 'title() 返回标题', typeof def.title === 'function' ? def.title() : def.title)
ok(Array.isArray(def.guide) && def.guide.length >= 1, 'guide 至少一条', def.guide)
const g = (def.guide || [])[0] || {}
ok(typeof g.title === 'function' && g.title().includes('配音工作台'), '引导页条目标题', g.title && g.title())
ok(typeof g.description === 'function' && g.description().length > 0, '引导页条目描述')
ok(typeof g.order === 'number', '有待排序 order', g.order)

console.log('[2] slot 注册与 key 一致')
const paneTab = slotRegs.find((r) => r.def.name === 'sidebar.right.pane.tab')
const paneTitle = slotRegs.find((r) => r.def.name === 'sidebar.right.pane.tab.title')
ok(!!paneTab, '注册了 pane.tab')
ok(!!paneTitle, '注册了 pane.tab.title')
ok(paneTab && paneTab.def.key === def.id, 'pane.tab 的 key 等于标签 id', paneTab && paneTab.def.key)
ok(paneTitle && paneTitle.def.key === def.id, 'title 的 key 等于标签 id', paneTitle && paneTitle.def.key)
ok(paneTab && typeof paneTab.comp === 'function', 'pane.tab 带组件')

console.log('[3] 服务缺失时不炸')
let threw = false
try {
  mod.apply({
    slots: { register: () => () => {}, inject: (n, cb) => cb() },
    effect: (f) => f(),
    inject: () => {},   // 没有 sidebarRightTabs
  })
} catch (e) { threw = true }
ok(!threw, '没有 sidebarRightTabs 时安静跳过')

console.log('')
console.log(fail === 0 ? '全部通过' : fail + ' 项失败')
process.exit(fail === 0 ? 0 : 1)
