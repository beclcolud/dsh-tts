/**
 * 工具级互斥。
 *
 * 服务是单进程单卡：一次只能合成一件事，模型切换还要 5~8 秒。原来两个工具同时
 * 调用时，第二个会静默排队——用户看到的是"没反应"，可能要等好几分钟。
 *
 * 这里改成：默认**立即失败并说清楚谁在跑、跑了多久**；想要排队就把 waitMs 调大。
 * 注意这是进程内互斥，覆盖的是同一个 DSH 会话里的并发；跨进程（另一个会话、
 * 手工 curl）仍然由服务端的 LOCK 串行。
 */

export function createBusyGuard() {
  let current = null

  function describe() {
    if (!current) return null
    return { label: current.label, ms: Date.now() - current.since }
  }

  /**
   * 拿到执行权才继续。waitMs 之内等不到就抛错（默认 0 = 不等，直接失败）。
   * 返回的 release 必须调用，否则后面所有调用都会被挡住。
   */
  async function acquire(label, waitMs = 0) {
    const deadline = Date.now() + Math.max(0, Number(waitMs) || 0)
    while (current) {
      if (Date.now() >= deadline) {
        const held = Date.now() - current.since
        throw new Error(
          '配音服务正忙：「' + current.label + '」已运行 ' + Math.round(held / 1000) + ' 秒。'
          + '同一个服务只能串行处理，等它结束再试；'
          + '想让它排队就把 busyWaitMs 调大（当前等待上限 ' + (Number(waitMs) || 0) + ' ms）。')
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    current = { label: String(label || 'task'), since: Date.now() }
    let released = false
    return () => {
      if (released) return
      released = true
      current = null
    }
  }

  /** 包一层：拿锁 → 执行 → 一定释放（异常也释放）。 */
  async function run(label, waitMs, fn) {
    const release = await acquire(label, waitMs)
    try {
      return await fn()
    } finally {
      release()
    }
  }

  return { acquire, run, describe }
}
