/**
 * 配音队列：串行跑，一次一个。
 *
 * 为什么串行：服务是单进程单卡，并行只会互相等，还会让"取消"和进度失去意义。
 *
 * 这个模块只做状态与调度，真正的合成由外部注入的 run() 完成，
 * 所以不依赖模型、不依赖插件宿主，可以直接单测。
 */

export function createQueue(options = {}) {
  const run = typeof options.run === 'function' ? options.run : async () => ({})
  const cancel = typeof options.cancel === 'function' ? options.cancel : async () => {}
  const now = options.now || (() => Date.now())

  let seq = 0
  let jobs = []
  let runningId = ''
  let paused = false
  let pumping = false
  // 已经请求过停止的任务：避免重复调 cancel；跑完/失败后清掉
  const stoppedIds = new Set()

  function makeId() {
    seq += 1
    return 'job' + seq
  }

  function snapshot() {
    return {
      jobs: jobs.map((j) => ({ ...j })),
      running: runningId,
      paused,
      counts: {
        total: jobs.length,
        queued: jobs.filter((j) => j.status === 'queued').length,
        done: jobs.filter((j) => j.status === 'done').length,
        failed: jobs.filter((j) => j.status === 'failed').length,
      },
    }
  }

  function find(id) {
    return jobs.find((j) => j.id === id) || null
  }

  async function pump() {
    if (pumping) return
    if (paused) return
    if (runningId) return
    const next = jobs.find((j) => j.status === 'queued')
    if (!next) return
    pumping = true
    runningId = next.id
    next.status = 'running'
    next.startedAt = now()
    try {
      const result = await run({ ...next })
      const target = find(next.id)
      if (target && target.status === 'running') {
        target.status = 'done'
        target.finishedAt = now()
        target.files = (result && result.files) || []
        target.message = (result && result.message) || ''
        delete target.error
      }
    } catch (error) {
      const target = find(next.id)
      if (target && target.status === 'running') {
        target.status = 'failed'
        target.finishedAt = now()
        target.error = String(error && error.message ? error.message : error)
      }
    } finally {
      stoppedIds.delete(next.id)
      runningId = ''
      pumping = false
    }
    // 接着跑下一个（递归但一次只跑一个；await 完之后再进）
    if (!paused && jobs.some((j) => j.status === 'queued')) return pump()
  }

  function add(input = {}) {
    const type = String(input.type || 'text')
    const text = String(input.text || '').trim()
    const xmlFile = String(input.xmlFile || '').trim()
    const scriptFile = String(input.scriptFile || '').trim()
    if (type === 'timeline') {
      if (!xmlFile) throw new Error('PR 任务需要 XML 路径')
      if (!scriptFile) throw new Error('PR 任务需要文案路径')
    } else if (!text) {
      throw new Error('文案不能为空')
    }
    const job = {
      id: makeId(),
      type: type === 'timeline' ? 'timeline' : 'text',
      text,
      xmlFile,
      scriptFile,
      sequence: (input.sequence === undefined || input.sequence === null || input.sequence === '') ? null : Number(input.sequence),
      detail: '',
      voice: String(input.voice || '').trim(),
      title: String(input.title || '').trim(),
      status: 'queued',
      createdAt: now(),
      startedAt: 0,
      finishedAt: 0,
      files: [],
      error: '',
      message: '',
    }
    jobs.push(job)
    Promise.resolve().then(pump)
    return job
  }

  /** 运行中更新一条任务的展示字段（比如「第 3/10 段」）。 */
  function patch(id, fields) {
    const job = find(id)
    if (!job) return null
    Object.assign(job, fields || {})
    return job
  }

  function remove(id) {
    if (id === runningId) throw new Error('正在跑的任务不能删除，先停止')
    const before = jobs.length
    jobs = jobs.filter((j) => j.id !== id)
    return jobs.length !== before
  }

  function clear() {
    const keep = runningId ? jobs.filter((j) => j.id === runningId) : []
    const removed = jobs.length - keep.length
    jobs = keep
    return removed
  }

  function pause() {
    paused = true
    return snapshot()
  }

  function resume() {
    paused = false
    Promise.resolve().then(pump)
    return snapshot()
  }

  function retry(id) {
    const job = find(id)
    if (!job) throw new Error('没有这个任务')
    if (job.status === 'running') throw new Error('正在跑，不能重试')
    job.status = 'queued'
    job.error = ''
    job.startedAt = 0
    job.finishedAt = 0
    Promise.resolve().then(pump)
    return job
  }

  /** 停止当前任务：调用外部 cancel，并把这条标成失败（可重试）。 */
  async function stop() {
    if (!runningId) return { stopped: false }
    if (stoppedIds.has(runningId)) return { stopped: true, id: runningId, already: true }
    stoppedIds.add(runningId)
    const job = find(runningId)
    try { await cancel() } catch { /* 取消失败也继续标记 */ }
    if (job && job.status === 'running') {
      job.status = 'failed'
      job.finishedAt = now()
      job.error = '已取消'
    }
    return { stopped: true, id: runningId }
  }

  return { add, remove, clear, pause, resume, retry, stop, snapshot, find, patch, pump }
}
