/**
 * 配音队列的单元测试（纯逻辑，不需要模型）。
 * 运行：node scripts/test_queue.mjs
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const Q = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'queue.js')).href)

let fail = 0
const ok = (c, label, extra) => {
  if (c) console.log('  ok   ' + label)
  else { fail += 1; console.log('  FAIL ' + label + (extra === undefined ? '' : ' -> ' + String(JSON.stringify(extra)).slice(0, 200))) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitIdle = async (queue, ms = 500) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (!queue.snapshot().running) return
    await sleep(10)
  }
}

const main = async () => {
  console.log('[1] 串行执行')
  const order = []
  const q1 = Q.createQueue({ run: async (job) => { order.push(job.text); return { files: ['/x/' + job.id + '.mp3'] } } })
  q1.add({ text: '第一句' })
  q1.add({ text: '第二句' })
  q1.add({ text: '第三句' })
  await sleep(50)
  ok(order.length === 3, '三条都跑了', order)
  ok(order[0] === '第一句' && order[2] === '第三句', '按加入顺序跑', order)
  const s1 = q1.snapshot()
  ok(s1.counts.done === 3 && s1.running === '', '全部 done 且没有在跑', s1.counts)

  console.log('[2] 一次只跑一个')
  let concurrent = 0
  let maxConcurrent = 0
  const q2 = Q.createQueue({
    run: async () => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await sleep(20)
      concurrent -= 1
      return { files: [] }
    },
  })
  q2.add({ text: 'a' }); q2.add({ text: 'b' }); q2.add({ text: 'c' })
  await sleep(150)
  ok(maxConcurrent === 1, '最大并发是 1', maxConcurrent)

  console.log('[3] 失败不影响后续')
  const q3 = Q.createQueue({
    run: async (job) => {
      if (job.text === '坏') throw new Error('合成失败')
      return { files: ['ok.mp3'] }
    },
  })
  q3.add({ text: '坏' })
  q3.add({ text: '好' })
  await sleep(80)
  const s3 = q3.snapshot()
  ok(s3.counts.failed === 1 && s3.counts.done === 1, '一败一成', s3.counts)
  const bad = s3.jobs.find((j) => j.text === '坏')
  ok(bad && /合成失败/.test(bad.error), '失败原因记下来了', bad && bad.error)

  console.log('[4] 暂停与恢复')
  const q4 = Q.createQueue({ run: async () => { await sleep(30); return { files: [] } } })
  q4.pause()
  q4.add({ text: '暂停中' })
  await sleep(60)
  ok(q4.snapshot().jobs[0].status === 'queued', '暂停时不会开跑', q4.snapshot().jobs[0].status)
  q4.resume()
  await sleep(80)
  ok(q4.snapshot().jobs[0].status === 'done', '恢复后跑完', q4.snapshot().jobs[0].status)

  console.log('[5] 重试')
  let attempt = 0
  const q5 = Q.createQueue({ run: async () => { attempt += 1; if (attempt === 1) throw new Error('第一次失败'); return { files: [] } } })
  const job5 = q5.add({ text: '要重试' })
  await sleep(50)
  ok(q5.find(job5.id).status === 'failed', '第一次失败')
  q5.retry(job5.id)
  await sleep(50)
  ok(q5.find(job5.id).status === 'done', '重试后成功')
  ok(q5.find(job5.id).files.length === 0, 'files 是数组（空也算）')

  console.log('[6] 删除与清空')
  const q6 = Q.createQueue({ run: async () => { await sleep(100); return { files: [] } } })
  const a = q6.add({ text: '跑着的' })
  const b = q6.add({ text: '排队的' })
  await sleep(20)
  let errMsg = ''
  try { q6.remove(a.id) } catch (e) { errMsg = String(e.message) }
  ok(/正在跑/.test(errMsg), '不能删正在跑的', errMsg)
  ok(q6.remove(b.id) === true, '可以删排队的')
  const removed = q6.clear()
  ok(removed === 0, '清空时只剩在跑的那条，没的删', removed)

  console.log('[7] 停止会调用 cancel 并标记')
  let cancelled = 0
  const q7 = Q.createQueue({
    run: async () => { await sleep(200); return { files: [] } },
    cancel: async () => { cancelled += 1 },
  })
  const j7 = q7.add({ text: '要停的' })
  await sleep(20)
  await q7.stop()
  ok(cancelled === 1, '调用了 cancel', cancelled)
  ok(q7.find(j7.id).status === 'failed' && /取消/.test(q7.find(j7.id).error), '标记为已取消', q7.find(j7.id))
  await q7.stop()
  ok(cancelled === 1, '没有在跑时 stop 不重复调用', cancelled)

  console.log('[8] 空文案被拒')
  const q8 = Q.createQueue({ run: async () => ({}) })
  let e2 = ''
  try { q8.add({ text: '   ' }) } catch (e) { e2 = String(e.message) }
  ok(/不能为空/.test(e2), '空文案报错', e2)

  console.log('')
  console.log(fail === 0 ? '全部通过' : fail + ' 项失败')
  process.exit(fail === 0 ? 0 : 1)
}
main()
