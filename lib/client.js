/**
 * dsh-tts - client half.
 *
 * Registers a card for the voiceover tool so finished audio can be listened to
 * right in the chat instead of copy-pasting paths. Everything is defensive:
 * a broken card must never take the UI down, so every render is wrapped.
 *
 * Non-ESM browser script, loaded through window.__ModuleLoader__ (same contract
 * as dsh-qwen-paint).
 */
if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
  window.__ModuleLoader__.load({
    id: 'dsh-tts',
    factory: (require) => {
      var module = { exports: {} }
      var exports = module.exports

      var React = require('react')
      var PLUGIN_ID = 'dsh-tts'
      var SLOT_KEY = 'tool.call.toolview'
      var TOOL_KEY = 'voiceover'
      var STATUS_SLOT = 'conversation.composer.dock'
      var STATUS_ID = 'dsh-tts-status'

      function textOf(block) {
        var parts = []
        var content = block && block.content
        if (Array.isArray(content)) {
          for (var i = 0; i < content.length; i++) {
            var b = content[i]
            if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
          }
        }
        return parts.join('\n').trim()
      }

      function filesOf(block) {
        var meta = block && (block.meta || block.presentationMeta)
        if (meta && Array.isArray(meta.files)) return meta.files.filter(function (f) { return typeof f === 'string' })
        return []
      }

      function fileUrl(path) {
        return 'api/file?path=' + encodeURIComponent(path)
      }

      function baseName(p) {
        var m = /[\\/]([^\\/]+)$/.exec(p)
        return m ? m[1] : p
      }

      function pick(files, re) {
        for (var i = 0; i < files.length; i++) if (re.test(files[i])) return files[i]
        return ''
      }

      function Card(props) {
        try {
          var block = props && props.block
          var phase = props && props.phase
          if (block === undefined || block === null) {
            return React.createElement('div', { style: { opacity: 0.7, fontSize: 12, padding: '6px 0' } },
              phase === 'error' ? '配音失败' : '正在合成配音…')
          }
          if (block.isError) {
            return React.createElement('div', { style: { color: '#c0392b', fontSize: 12, padding: '6px 0' } },
              textOf(block) || '配音失败')
          }
          var files = filesOf(block)
          var mp3 = pick(files, /\.mp3$/i)
          var mp4 = pick(files, /\.mp4$/i)
          var srt = pick(files, /\.srt$/i)
          var msg = textOf(block)

          var children = []
          if (mp4) {
            children.push(React.createElement('video', {
              key: 'v', controls: true, src: fileUrl(mp4),
              style: { width: '100%', maxWidth: 560, borderRadius: 8, display: 'block', marginBottom: 8 },
            }))
          } else if (mp3) {
            children.push(React.createElement('audio', {
              key: 'a', controls: true, preload: 'metadata', src: fileUrl(mp3),
              style: { width: '100%', marginBottom: 6 },
            }))
          }
          var links = []
          if (mp3) links.push(React.createElement('a', { key: 'l1', href: fileUrl(mp3), download: baseName(mp3), style: { marginRight: 12, fontSize: 12 } }, '下载 mp3'))
          if (srt) links.push(React.createElement('a', { key: 'l2', href: fileUrl(srt), download: baseName(srt), style: { marginRight: 12, fontSize: 12 } }, '下载 srt'))
          if (mp4) links.push(React.createElement('a', { key: 'l3', href: fileUrl(mp4), download: baseName(mp4), style: { marginRight: 12, fontSize: 12 } }, '下载 mp4'))
          if (links.length) children.push(React.createElement('div', { key: 'links' }, links))
          if (msg) {
            children.push(React.createElement('div', {
              key: 'msg',
              style: { fontSize: 12, opacity: 0.75, marginTop: 6, whiteSpace: 'pre-wrap' },
            }, msg))
          }
          if (!children.length) {
            children.push(React.createElement('div', { key: 'none', style: { fontSize: 12, opacity: 0.7 } }, msg || '配音完成'))
          }
          return React.createElement('div', { style: { padding: '8px 0' } }, children)
        } catch (error) {
          return React.createElement('div', { style: { fontSize: 12, color: '#c0392b' } },
            '配音卡片渲染出错：' + (error && error.message ? error.message : String(error)))
        }
      }

      /**
       * Composer status pill: green = service up, grey = asleep. Shows the idle
       * countdown so "it stops after 5 minutes" is visible instead of surprising.
       */
      function StatusSeat() {
        var st = React.useState({ loading: true, online: false, idleS: null, limit: 300000, busyS: null, busyReq: null, cancelling: false })
        var s = st[0]
        var set = st[1]
        React.useEffect(function () {
          var alive = true
          function poll() {
            fetch('api/dsh-tts/status.json', { cache: 'no-store' })
              .then(function (r) { return r.json() })
              .then(function (j) {
                if (!alive) return
                // 只在服务在线时才覆盖 busy：离线时旧值会一直挂着，看起来像卡死
                set(function (prev) {
                  var online = !!(j && j.online)
                  return {
                    loading: false,
                    online: online,
                    idleS: j && j.idleS,
                    limit: (j && j.idleShutdownMs) || 300000,
                    busyS: online && typeof (j && j.busyS) === 'number' ? j.busyS : null,
                    busyReq: online ? (j && j.busyReq) || null : null,
                    cancelling: prev && prev.cancelling ? prev.cancelling : false,
                  }
                })
              })
              .catch(function () { if (alive) set({ loading: false, online: false, idleS: null, limit: 300000, busyS: null, busyReq: null, cancelling: false }) })
          }
          poll()
          // 合成中想要看到秒数在动，5 秒一次太粗；没用合成时也没必要频繁打
          var timer = setInterval(poll, 2000)
          return function () { alive = false; clearInterval(timer) }
        }, [])

        function cancel() {
          set(function (prev) { return Object.assign({}, prev, { cancelling: true }) })
          fetch('api/dsh-tts/cancel.json', { method: 'POST', cache: 'no-store' }).catch(function () { /* 忽略：轮询会把状态刷新回来 */ })
        }

        var busy = s.online && (typeof s.busyS === 'number' || s.busyReq)
        if (busy) {
          var secs = typeof s.busyS === 'number' ? Math.round(s.busyS) : null
          var who = s.busyReq === 'say' ? '合成中' : (s.busyReq === 'asr' || s.busyReq === 'asr_subs') ? '转写中'
            : s.busyReq === 'align' ? '对齐中' : '处理中'
          return React.createElement(
            'span',
            { style: { display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, opacity: 0.9 } },
            React.createElement('span', { style: { width: 7, height: 7, borderRadius: '50%', background: '#e67e22', display: 'inline-block' } }),
            React.createElement('span', null, who + (secs === null ? '' : ' ' + secs + ' 秒')),
            React.createElement('button', {
              onClick: cancel,
              disabled: s.cancelling,
              title: '停在当前这句之后，已经合成好的部分保留',
              style: {
                fontSize: 11, padding: '1px 8px', borderRadius: 10, cursor: s.cancelling ? 'default' : 'pointer',
                border: '1px solid currentColor', background: 'transparent', color: 'inherit', opacity: s.cancelling ? 0.5 : 0.85,
              },
            }, s.cancelling ? '取消中…' : '取消'),
          )
        }

        var color = s.online ? '#27ae60' : '#9aa4b2'
        var label = s.online ? '配音就绪' : '配音待机'
        var extra = ''
        if (s.online && typeof s.idleS === 'number' && s.limit > 0) {
          var left = Math.max(0, Math.round((s.limit / 1000) - s.idleS))
          extra = ' · ' + Math.floor(left / 60) + '分' + String(left % 60).padStart(2, '0') + '秒后休眠'
        }
        return React.createElement(
          'span',
          { title: s.online ? ('本地配音服务运行中' + extra) : '本地配音服务未启动，下次配音会自动拉起', style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, opacity: 0.85 } },
          React.createElement('span', { style: { width: 7, height: 7, borderRadius: '50%', background: color, display: 'inline-block' } }),
          React.createElement('span', null, label + extra),
        )
      }


      /* ---------------------------------------------------- 配音工作台 ---- */
      // 挂在右侧边栏：任务（真实进度+取消）/ 历史（产物列表）/ 音色库（试听改删建）。
      // 颜色一律用 currentColor + opacity 继承 DSH 主题，不写死深浅色。

      var STUDIO_KEY = 'dsh-tts-studio'
      var STUDIO_TABS = [['task', '任务'], ['history', '历史'], ['bank', '音色库']]

      function getJson(url, opts) {
        return fetch(url, Object.assign({ cache: 'no-store' }, opts || {})).then(function (r) { return r.json() })
      }
      function postJson(url, body) {
        return getJson(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {}),
        })
      }
      function fmtBytes(n) {
        if (typeof n !== 'number') return ''
        if (n < 1024) return n + ' B'
        if (n < 1048576) return Math.round(n / 1024) + ' KB'
        return (n / 1048576).toFixed(1) + ' MB'
      }
      function fmtAgo(ts) {
        var s = Math.max(0, Math.round(Date.now() / 1000 - ts))
        if (s < 60) return s + ' 秒前'
        if (s < 3600) return Math.round(s / 60) + ' 分钟前'
        if (s < 86400) return Math.round(s / 3600) + ' 小时前'
        return Math.round(s / 86400) + ' 天前'
      }
      function playPath(p) {
        try {
          var a = new Audio(fileUrl(p))
          a.play().catch(function () { /* 用户没交互过就先不播 */ })
        } catch (e) { /* 忽略 */ }
      }

      var S = {
        box: { padding: '10px 12px', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 10, minHeight: '100%', boxSizing: 'border-box' },
        row: { display: 'flex', alignItems: 'center', gap: 8 },
        grow: { flex: 1 },
        muted: { opacity: 0.6 },
        card: { border: '1px solid currentColor', borderRadius: 8, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6, opacity: 0.95 },
        btn: { fontSize: 11, padding: '2px 9px', borderRadius: 10, border: '1px solid currentColor', background: 'transparent', color: 'inherit', opacity: 0.85, cursor: 'pointer' },
        btnDim: { fontSize: 11, padding: '2px 9px', borderRadius: 10, border: '1px solid currentColor', background: 'transparent', color: 'inherit', opacity: 0.4, cursor: 'default' },
        tab: function (active) {
          return { fontSize: 12, padding: '2px 10px', borderRadius: 12, cursor: 'pointer', border: '1px solid currentColor', background: 'transparent', color: 'inherit', opacity: active ? 1 : 0.45 }
        },
        input: { fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid currentColor', background: 'transparent', color: 'inherit', opacity: 0.9, flex: 1, minWidth: 0 },
        item: { display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 0', borderBottom: '1px solid currentColor' },
      }

      function Bar(props) {
        var pct = Math.max(0, Math.min(100, Number(props.pct) || 0))
        return React.createElement('div', { style: { height: 6, borderRadius: 3, background: 'currentColor', opacity: 0.16, overflow: 'hidden' } },
          React.createElement('div', { style: { width: pct + '%', height: '100%', background: '#e67e22' } }))
      }

      function TaskTab(props) {
        var st = props.status || {}
        var busy = !!(st.online && st.busyReq)
        if (busy) {
          var prog = st.progress
          var pct = prog && prog.total ? Math.round((prog.done / prog.total) * 100) : 0
          var who = st.busyReq === 'say' ? '正在合成' : (st.busyReq === 'preview' ? '正在出候选'
            : (st.busyReq === 'asr' || st.busyReq === 'asr_subs') ? '正在转写'
              : st.busyReq === 'align' ? '正在对齐' : '处理中')
          var detail = prog && prog.total
            ? ('第 ' + prog.done + ' / ' + prog.total + ' 句')
            : ('已用 ' + Math.round(Number(st.busyS) || 0) + ' 秒')
          return React.createElement('div', { style: S.card },
            React.createElement('div', { style: S.row },
              React.createElement('span', { style: { width: 7, height: 7, borderRadius: '50%', background: '#e67e22', display: 'inline-block' } }),
              React.createElement('span', null, who),
              React.createElement('span', { style: S.grow }),
              React.createElement('button', { onClick: props.onCancel, disabled: props.cancelling, style: props.cancelling ? S.btnDim : S.btn },
                props.cancelling ? '取消中…' : '取消')),
            Bar({ pct: pct }),
            React.createElement('div', { style: S.row },
              React.createElement('span', { style: S.muted }, detail),
              React.createElement('span', { style: S.grow }),
              React.createElement('span', { style: S.muted }, pct + '%')))
        }
        var idle = ''
        if (st.online && typeof st.idleS === 'number' && st.idleShutdownMs > 0) {
          var left = Math.max(0, Math.round(st.idleShutdownMs / 1000 - st.idleS))
          idle = Math.floor(left / 60) + ' 分 ' + String(left % 60).padStart(2, '0') + ' 秒后休眠'
        }
        return React.createElement('div', { style: S.card },
          React.createElement('div', { style: S.row },
            React.createElement('span', { style: { width: 7, height: 7, borderRadius: '50%', background: st.online ? '#27ae60' : '#9aa4b2', display: 'inline-block' } }),
            React.createElement('span', null, st.online ? '配音服务就绪' : '配音服务待机'),
            React.createElement('span', { style: S.grow }),
            st.online ? React.createElement('span', { style: S.muted }, idle) : null),
          React.createElement('div', { style: S.muted }, st.online ? '没有正在进行的任务。' : '下次调用配音时会自动拉起（约 10–30 秒）。'))
      }

      function HistoryTab(props) {
        var files = props.history || []
        var head = React.createElement('div', { style: S.row },
          React.createElement('span', { style: S.muted }, '共 ' + files.length + ' 个文件（最近 40 个）'),
          React.createElement('span', { style: S.grow }),
          React.createElement('button', { onClick: props.onRefresh, style: S.btn }, '刷新'))
        if (props.loading) return React.createElement('div', null, head, React.createElement('div', { style: S.muted }, '读取中…'))
        if (!files.length) return React.createElement('div', null, head, React.createElement('div', { style: S.muted }, '还没有产物。'))
        var rows = files.map(function (f) {
          var isAudio = /\.(mp3|wav|m4a|flac)$/i.test(f.name)
          return React.createElement('div', { key: f.path, style: S.item },
            React.createElement('div', { style: S.row },
              React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: f.rel }, f.name),
              React.createElement('span', { style: S.grow }),
              isAudio ? React.createElement('button', { onClick: function () { playPath(f.path) }, style: S.btn }, '试听') : null,
              React.createElement('a', { href: fileUrl(f.path), download: f.name, style: { fontSize: 11, opacity: 0.8, color: 'inherit' } }, '下载')),
            React.createElement('div', { style: S.muted },
              (f.dir ? f.dir + ' · ' : '') + fmtBytes(f.bytes) + ' · ' + fmtAgo(f.mtime)))
        })
        return React.createElement('div', null, head, React.createElement('div', null, rows))
      }

      function BankTab(props) {
        var entries = props.bank || {}
        var names = Object.keys(entries)
        var inputState = React.useState('')
        var prompt = inputState[0]
        var setPrompt = inputState[1]
        var head = React.createElement('div', { style: S.row },
          React.createElement('span', { style: S.muted }, '共 ' + names.length + ' 个音色'),
          React.createElement('span', { style: S.grow }),
          React.createElement('button', { onClick: props.onRefresh, style: S.btn }, '刷新'))
        var createRow = React.createElement('div', { style: S.row },
          React.createElement('input', {
            value: prompt, placeholder: '用一句话描述想要的音色，例如：低沉沙哑的中年男声',
            onChange: function (e) { setPrompt(e.target.value) }, style: S.input,
          }),
          React.createElement('button', {
            onClick: function () { if (prompt.trim() && !props.creating) props.onCreate(prompt.trim()) },
            style: props.creating ? S.btnDim : S.btn,
          }, props.creating ? '生成中…' : '新建'))
        if (props.loading) return React.createElement('div', null, head, createRow, React.createElement('div', { style: S.muted }, '读取中…'))
        if (!names.length) {
          return React.createElement('div', null, head, createRow,
            React.createElement('div', { style: S.muted }, '音色库是空的。'))
        }
        var rows = names.map(function (name) {
          var e = entries[name] || {}
          var sample = e.sample_mp3 || ''
          return React.createElement('div', { key: name, style: S.item },
            React.createElement('div', { style: S.row },
              React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: name }, name),
              React.createElement('span', { style: S.grow }),
              sample ? React.createElement('button', { onClick: function () { playPath(sample) }, style: S.btn }, '试听') : null,
              React.createElement('button', { onClick: function () { props.onRename(name) }, style: S.btn }, '改名'),
              React.createElement('button', { onClick: function () { props.onDelete(name) }, style: S.btn }, '删除')),
            React.createElement('div', { style: S.muted }, (e.kind || '?') + (e.note ? ' · ' + e.note : '')))
        })
        return React.createElement('div', null, head, createRow, React.createElement('div', null, rows))
      }

      function StudioBody() {
        var statusState = React.useState(null)
        var status = statusState[0]
        var setStatus = statusState[1]
        var tabState = React.useState('task')
        var tab = tabState[0]
        var setTab = tabState[1]
        var dataState = React.useState({ history: [], bank: null, loading: false })
        var data = dataState[0]
        var setData = dataState[1]
        var miscState = React.useState({ error: '', cancelling: false, creating: false })
        var misc = miscState[0]
        var setMisc = miscState[1]

        React.useEffect(function () {
          var alive = true
          function poll() {
            getJson('api/dsh-tts/status.json')
              .then(function (j) { if (alive) setStatus(j) })
              .catch(function () { if (alive) setStatus({ online: false }) })
          }
          poll()
          var timer = setInterval(poll, 2000)
          return function () { alive = false; clearInterval(timer) }
        }, [])

        function loadHistory() {
          setData(function (p) { return Object.assign({}, p, { loading: true }) })
          getJson('api/dsh-tts/outputs.json')
            .then(function (j) {
              setData(function (p) { return Object.assign({}, p, { history: (j && j.files) || [], loading: false }) })
              if (j && j.ok === false) setMisc(function (p) { return Object.assign({}, p, { error: j.error || '' }) })
            })
            .catch(function (e) {
              setData(function (p) { return Object.assign({}, p, { loading: false }) })
              setMisc(function (p) { return Object.assign({}, p, { error: '读取产物失败：' + (e && e.message ? e.message : e) }) })
            })
        }
        function loadBank() {
          setData(function (p) { return Object.assign({}, p, { loading: true }) })
          getJson('api/dsh-tts/bank.json')
            .then(function (j) {
              setData(function (p) { return Object.assign({}, p, { bank: (j && j.entries) || {}, loading: false }) })
              if (j && j.ok === false) setMisc(function (p) { return Object.assign({}, p, { error: j.error || '' }) })
            })
            .catch(function (e) {
              setData(function (p) { return Object.assign({}, p, { loading: false }) })
              setMisc(function (p) { return Object.assign({}, p, { error: '读取音色库失败：' + (e && e.message ? e.message : e) }) })
            })
        }

        React.useEffect(function () {
          if (tab === 'history') loadHistory()
          if (tab === 'bank') loadBank()
        }, [tab])

        function cancel() {
          setMisc(function (p) { return Object.assign({}, p, { cancelling: true }) })
          postJson('api/dsh-tts/cancel.json').catch(function () {}).then(function () {
            setTimeout(function () { setMisc(function (p) { return Object.assign({}, p, { cancelling: false }) }) }, 3000)
          })
        }

        var rename = function (name) {
          var next = window.prompt('把「' + name + '」改成：', name)
          if (!next || next === name) return
          postJson('api/dsh-tts/bank.json', { op: 'rename', name: name, to: next })
            .then(function (j) {
              if (!j.ok) setMisc(function (p) { return Object.assign({}, p, { error: j.error || '改名失败' }) })
              loadBank()
            })
        }
        var remove = function (name) {
          if (!window.confirm('确定从音色库删除「' + name + '」？（只删记录，参考音频文件不动）')) return
          postJson('api/dsh-tts/bank.json', { op: 'delete', name: name })
            .then(function (j) {
              if (!j.ok) setMisc(function (p) { return Object.assign({}, p, { error: j.error || '删除失败' }) })
              loadBank()
            })
        }
        var create = function (prompt) {
          setMisc(function (p) { return Object.assign({}, p, { creating: true, error: '' }) })
          postJson('api/dsh-tts/bank.json', { op: 'create', prompt: prompt })
            .then(function (j) {
              setMisc(function (p) { return Object.assign({}, p, { creating: false, error: j.ok ? '' : (j.error || '新建失败') }) })
              loadBank()
            })
            .catch(function (e) { setMisc(function (p) { return Object.assign({}, p, { creating: false, error: String(e && e.message ? e.message : e) }) }) })
        }

        var tabs = React.createElement('div', { style: { display: 'flex', gap: 6 } },
          STUDIO_TABS.map(function (t) {
            return React.createElement('button', { key: t[0], onClick: function () { setTab(t[0]) }, style: S.tab(tab === t[0]) }, t[1])
          }))

        var body = null
        if (tab === 'task') body = TaskTab({ status: status, onCancel: cancel, cancelling: misc.cancelling })
        else if (tab === 'history') body = HistoryTab({ history: data.history, loading: data.loading, onRefresh: loadHistory })
        else body = BankTab({ bank: data.bank || {}, onRefresh: loadBank, onRename: rename, onDelete: remove, onCreate: create, creating: misc.creating })

        return React.createElement('div', { style: S.box },
          tabs,
          misc.error ? React.createElement('div', { style: { color: '#c0392b', fontSize: 11 } }, misc.error) : null,
          body)
      }

      function StudioTitle() {
        return React.createElement('span', { style: { fontSize: 12, opacity: 0.9 } }, '配音')
      }

      function apply(ctx) {
        try {
          if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') return
          ctx.slots.inject(SLOT_KEY, function () {
            return ctx.slots.register({ name: SLOT_KEY, key: TOOL_KEY }, Card)
          })
        } catch (error) {
          try { console.warn('[dsh-tts] 注册配音卡片失败：' + (error && error.message ? error.message : error)) } catch (e) { /* noop */ }
        }
        // 右侧边栏工作台。顺序很关键：**先向 sidebarRightTabs 注册一个标签类型**
        // （引导页条目就是它的 guide 数组），再给这个类型提供内容与标题。
        // 少了第一步，pane.tab 这个 slot 根本不会被渲染，引导页也不会出现卡片——
        // 这正是第一版没出现的原因。
        var STUDIO_ID = STUDIO_KEY
        try {
          ctx.inject(['sidebarRightTabs'], function (inner) {
            var svc = inner && inner.sidebarRightTabs
            if (!svc || typeof svc.register !== 'function') return
            inner.effect(function () {
              return svc.register({
                id: STUDIO_ID,
                kind: STUDIO_ID,
                title: function () { return '配音' },
                guide: [{
                  id: 'open-studio',
                  order: 30,
                  title: function () { return '配音工作台' },
                  description: function () { return '实时进度、历史产物、音色库' },
                }],
              })
            }, 'dsh-tts: studio tab type')
          })
        } catch (error) {
          try { console.warn('[dsh-tts] 注册标签类型失败：' + (error && error.message ? error.message : error)) } catch (e2) { /* noop */ }
        }

        // 内容与标题也用同一个 id 作为 key。
        var studioSlots = [
          ['sidebar.right.pane.tab', function () {
            return ctx.slots.register({ name: 'sidebar.right.pane.tab', key: STUDIO_ID }, StudioBody)
          }],
          ['sidebar.right.pane.tab.title', function () {
            return ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: STUDIO_ID }, StudioTitle)
          }],
        ]
        for (var si = 0; si < studioSlots.length; si++) {
          try {
            ctx.slots.inject(studioSlots[si][0], studioSlots[si][1])
          } catch (error) {
            try { console.warn('[dsh-tts] 注册 ' + studioSlots[si][0] + ' 失败：' + (error && error.message ? error.message : error)) } catch (e2) { /* noop */ }
          }
        }

        try {
          if (typeof React.useState === 'function' && typeof React.useEffect === 'function') {
            ctx.slots.inject(STATUS_SLOT, function () {
              return ctx.slots.register({ name: STATUS_SLOT, id: STATUS_ID, order: 40 }, StatusSeat)
            })
          }
        } catch (error) {
          try { console.warn('[dsh-tts] 注册状态指示器失败：' + (error && error.message ? error.message : error)) } catch (e) { /* noop */ }
        }
      }

      exports.inject = ['slots']
      exports.name = PLUGIN_ID
      exports.apply = apply
      return module.exports
    },
  })
}