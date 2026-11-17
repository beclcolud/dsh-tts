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
        var st = React.useState({ loading: true, online: false, idleS: null, limit: 300000 })
        var s = st[0]
        var set = st[1]
        React.useEffect(function () {
          var alive = true
          function poll() {
            fetch('api/dsh-tts/status.json', { cache: 'no-store' })
              .then(function (r) { return r.json() })
              .then(function (j) {
                if (!alive) return
                set({ loading: false, online: !!(j && j.online), idleS: j && j.idleS, limit: (j && j.idleShutdownMs) || 300000 })
              })
              .catch(function () { if (alive) set({ loading: false, online: false, idleS: null, limit: 300000 }) })
          }
          poll()
          var timer = setInterval(poll, 5000)
          return function () { alive = false; clearInterval(timer) }
        }, [])

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

      function apply(ctx) {
        try {
          if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') return
          ctx.slots.inject(SLOT_KEY, function () {
            return ctx.slots.register({ name: SLOT_KEY, key: TOOL_KEY }, Card)
          })
        } catch (error) {
          try { console.warn('[dsh-tts] 注册配音卡片失败：' + (error && error.message ? error.message : error)) } catch (e) { /* noop */ }
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