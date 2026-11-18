/**
 * 工具互斥的单元测试（纯逻辑）。
 * 运行：node scripts/test_guard.mjs
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const G = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'guard.js')).href)

let fail = 0
const ok = (c, label, extra) => {
  if (c) console.log('  ok   ' + label)
  else { fail += 1; console.log('  FAIL ' + label + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra))) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const main = async () => {
  console.log('[1] 忙时会立即失败并说明是谁在跑')
  const g1 = G.createBusyGuard()
  const release = await g1.acquire('长文案渲染', 0)
  const t0 = Date.now()
  let err = ''
  try { await g1.acquire('第二个人', 0) } catch (e) { err = String(e.message) }
  ok(err.includes('正忙'), '抛出了"正忙"', err)
  ok(err.includes('长文案渲染'), '错误里带上了占用者的名字', err)
  ok(Date.now() - t0 < 500, '没有傻等（<500ms）', Date.now() - t0)
  release()

  console.log('[2] 释放后可以继续')
  const again = await g1.acquire('后来的', 0)
  ok(true, '拿到执行权没有抛错')
  again()

  console.log('[3] 异常也会释放（不会把服务永久锁死）')
  const g2 = G.createBusyGuard()
  try {
    await g2.run('会失败的任务', 0, async () => { throw new Error('boom') })
  } catch { /* 预期 */ }
  ok(g2.describe() === null, '失败后没有残留占用', g2.describe())
  const after = await g2.acquire('之后的任务', 0)
  ok(true, '之后还能拿到')
  after()

  console.log('[4] 允许排队时按 waitMs 等待')
  const g3 = G.createBusyGuard()
  const hold = await g3.acquire('占用中', 0)
  setTimeout(() => hold(), 300)
  const t1 = Date.now()
  const rel2 = await g3.acquire('排队者', 2000)
  ok(Date.now() - t1 >= 250, '确实等了对方释放', Date.now() - t1)
  rel2()

  console.log('[5] 排队超时仍然失败')
  const g4 = G.createBusyGuard()
  const hold2 = await g4.acquire('一直占着', 0)
  let err2 = ''
  const t2 = Date.now()
  try { await g4.acquire('等不及的', 400) } catch (e) { err2 = String(e.message) }
  ok(err2.includes('正忙'), '超时后报错', err2)
  ok(Date.now() - t2 >= 350, '等够了才失败', Date.now() - t2)
  hold2()

  console.log('[6] describe 报告占用者与时长')
  const g5 = G.createBusyGuard()
  const rel5 = await g5.acquire('可观测的任务', 0)
  await sleep(120)
  const d = g5.describe()
  ok(d && d.label === '可观测的任务' && d.ms >= 100, 'describe 有名字和时长', d)
  rel5()
  ok(g5.describe() === null, '释放后为空')

  console.log('')
  console.log(fail === 0 ? '全部通过' : fail + ' 项失败')
  process.exit(fail === 0 ? 0 : 1)
}
main()
