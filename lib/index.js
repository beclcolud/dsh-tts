/**
 * dsh-tts - local text-to-speech for DeepSeek Harness.
 *
 * Adds one tool, voiceover, that turns a script into audio (and optionally a
 * subtitled video) using Qwen3-TTS running locally. All heavy work happens in a
 * resident Python service (server/tts_server.py) that this plugin starts on
 * first use and lets die after an idle period, so VRAM is not held forever.
 *
 * Voice options:
 *   - preset name  : "Serena" / "Uncle_Fu" / "Vivian" ... (9 built-ins)
 *   - description  : any Chinese sentence describing a voice -> VoiceDesign
 *   - media path   : a local audio/video file -> UVR separation -> clone
 *   - bank name    : a voice saved earlier by this plugin
 */
import { spawn } from 'node:child_process'
import { promises as fsp, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bindAlignedText, buildSrt, concatPcm16, groupAlignedCues, parseSrt, shortHash, synthChunks, splitForRequest, synthTimeline } from './synth.js'
import { createBusyGuard } from './guard.js'
import { ffconcatPath } from './platform.js'

// 同一个服务串行处理；这里给三个工具加一层互斥，忙的时候说清楚谁在跑，
// 而不是让第二个请求静默排队（GPU 上排队也没有并行收益）。
const BUSY = createBusyGuard()

export const name = 'dsh-tts'

const PRESETS = ['Vivian', 'Serena', 'Uncle_Fu', 'Dylan', 'Eric', 'Ryan', 'Aiden', 'Ono_Anna', 'Sohee']
const AUDIO_EXT = /\.(wav|mp3|m4a|flac|aac|ogg)$/iu
const VIDEO_EXT = /\.(mp4|mov|mkv|avi|webm|flv)$/iu

const DEFAULTS = {
  port: 17321,
  pythonPath: '',
  libs: '',
  models: {},
  workDir: '',
  idleShutdownMs: 300000,
  timeoutMs: 1200000,
  ffmpeg: 'ffmpeg',
  defaultVoice: 'Dylan',
  logFile: '',
  // 忙的时候最多等多久（毫秒）。0 = 立即失败并提示，想要排队就调大。
  busyWaitMs: 0,
  // 接缝策略：target = 按句末标点把停顿规整到设定值（默认）；
  // current = 只保留 25ms 边距，停顿完全看模型给多少。
  seamPolicy: 'target',
  // 按标点覆盖停顿时长（毫秒），键是句末标点，如 { '。': 260, '；': 160 }
  seamPauses: {},
  // 归一化的峰值上限。0.95 = 只留 0.45dB 余量，模型自带的硬瞬态会被顶到贴顶；
  // 降到 0.70 相当于多留 3dB，瞬态不再"爆"，代价是整体音量低 3dB。
  peakCeiling: 0.95,
  // 峰值软限幅：只把超过阈值的尖峰磨圆，整体响度不动。
  // 模型自带的硬瞬态靠"降天花板"治不好——那只是等比变小，刺的比例没变。
  softLimit: false,
  // 高频层降（dB，负数=压）。模型自带的硬瞬态能量集中在中高频，
  // 实测 -4dB 能把最大跳变压下 21%，而 RMS 只掉 0.2dB——比降天花板/限幅划算得多。
  toneTameDb: 0,
  // —— 发音微调（对应 cordis.patch.yml 里的同名项）——
  diction: undefined,
  blurMode: undefined,
  blurSep: undefined,
  blurWords: undefined,
  blurGapMs: undefined,
}

// starting: 并发拉起保护。两个调用同时发现服务没起时，只会有一个真的去 spawn，
// 否则第二个进程会因为抢不到端口而退出，它的 exit 回调还会把正在用的引用清掉。
const SERVICE = { proc: null, startedAt: 0, lastError: '', starting: null, lastExit: null }

/**
 * 面板上可改的参数。
 * live=true 表示改完下一次调用就生效（插件每次调用时现读 cfg）；
 * live=false 表示要重启（这些值在服务启动时写进服务端配置，运行时改不动）。
 */
const SETTING_FIELDS = [
  { key: 'defaultVoice', kind: 'string', label: '默认音色', live: true, hint: '不传 voice 时用它' },
  { key: 'busyWaitMs', kind: 'int', min: 0, max: 600000, label: '忙时最多等待（毫秒）', live: true, hint: '0 = 立即失败并提示' },
  { key: 'seamPolicy', kind: 'enum', options: ['target', 'current'], label: '接缝策略', live: true },
  { key: 'seamPauses', kind: 'json', label: '句间停顿（按标点，毫秒）', live: true, hint: '如 {"。":180,"；":140}' },
  { key: 'peakCeiling', kind: 'number', min: 0.1, max: 1, label: '峰值上限', live: true, hint: '觉得爆就降到 0.7' },
  { key: 'toneTameDb', kind: 'number', min: -12, max: 0, label: '高频层降（dB）', live: true, hint: '觉得刺就给 -4' },
  { key: 'softLimit', kind: 'bool', label: '峰值软限幅', live: false },
  { key: 'idleShutdownMs', kind: 'int', min: 60000, max: 3600000, label: '空闲休眠（毫秒）', live: false },
  { key: 'diction', kind: 'bool', label: '咬字清晰指令', live: false },
  { key: 'blurMode', kind: 'enum', options: ['punct', 'split'], label: '粘连处理方式', live: false },
  { key: 'blurSep', kind: 'string', label: '粘连插入的标点', live: false },
  { key: 'blurWords', kind: 'json', label: '易粘连词表', live: false, hint: '如 ["答案","牛奶"]' },
  { key: 'blurGapMs', kind: 'int', min: 0, max: 500, label: '拆字断点（毫秒）', live: false },
]

/** 覆盖文件放在 workDir 下，不污染插件目录，也不会进版本库。 */
function settingsPath(cfg) {
  const root = cfg.workDir || path.join(process.cwd(), '配音')
  return path.join(root, '.dsh-tts', 'settings.json')
}

function readSettings(cfg) {
  try { return JSON.parse(readFileSync(settingsPath(cfg), 'utf8')) || {} } catch { return {} }
}

/** 校验并规范化单个值；不合法就返回原因，绝不静默写入。 */
function coerceSetting(field, value) {
  const bad = (reason) => ({ ok: false, reason })
  try {
    if (field.kind === 'bool') {
      if (typeof value === 'boolean') return { ok: true, value }
      return bad('要 true/false')
    }
    if (field.kind === 'string') {
      const s = String(value == null ? '' : value).trim()
      if (s.length > 60) return bad('最多 60 个字')
      return { ok: true, value: s }
    }
    if (field.kind === 'enum') {
      const s = String(value)
      if (!field.options.includes(s)) return bad('只能是 ' + field.options.join(' / '))
      return { ok: true, value: s }
    }
    if (field.kind === 'int' || field.kind === 'number') {
      const n = Number(value)
      if (!Number.isFinite(n)) return bad('要一个数字')
      if (field.kind === 'int' && !Number.isInteger(n)) return bad('要整数')
      if (field.min != null && n < field.min) return bad('不能小于 ' + field.min)
      if (field.max != null && n > field.max) return bad('不能大于 ' + field.max)
      return { ok: true, value: n }
    }
    if (field.kind === 'json') {
      const parsed = typeof value === 'string' ? JSON.parse(value) : value
      if (Array.isArray(parsed)) {
        if (parsed.some((x) => typeof x !== 'string')) return bad('数组里只能放字符串')
        return { ok: true, value: parsed }
      }
      if (parsed && typeof parsed === 'object') {
        const clean = {}
        for (const [k, v] of Object.entries(parsed)) {
          const n = Number(v)
          if (!Number.isFinite(n) || n < 0 || n > 2000) return bad('每个停顿要是 0~2000 的数字')
          clean[k] = Math.round(n)
        }
        return { ok: true, value: clean }
      }
      return bad('要对象或数组')
    }
    return bad('未知类型')
  } catch (e) {
    return bad('格式不对：' + (e && e.message ? e.message : e))
  }
}

/** 把覆盖文件里的值合并进 cfg（启动时调用一次）。 */
function applySavedSettings(cfg) {
  const saved = readSettings(cfg)
  for (const f of SETTING_FIELDS) {
    if (!(f.key in saved)) continue
    const r = coerceSetting(f, saved[f.key])
    if (r.ok) cfg[f.key] = r.value
  }
  return cfg
}

/* ------------------------------------------------------------------ service */

function cfgFor(cfg, cwd) {
  return {
    libs: cfg.libs,
    work_dir: cfg.workDir || path.join(cwd, '配音'),
    models: cfg.models,
    uvr_models: path.join(cfg.libs, '..', 'uvr_models'),
    uvr_model: 'UVR-MDX-NET-Voc_FT.onnx',
    port: cfg.port,
    idle_shutdown_ms: cfg.idleShutdownMs,
    seam_policy: cfg.seamPolicy || 'target',
    seam_target_ms: (cfg.seamPauses && Object.keys(cfg.seamPauses).length) ? cfg.seamPauses : undefined,
    peak_ceiling: cfg.peakCeiling,
    soft_limit: cfg.softLimit,
    tone_tame_db: cfg.toneTameDb,
    // 发音微调：这几项以前只在 cordis.patch.yml 里写着，从没传给服务端——
    // 服务端读不到就用自己的默认值，而默认值恰好和配置相同，所以一直没暴露。
    // 一旦有人在配置里改，改了也不生效。现在显式转发。
    diction: cfg.diction,
    blur_mode: cfg.blurMode,
    blur_sep: cfg.blurSep,
    blur_words: cfg.blurWords,
    blur_gap_ms: cfg.blurGapMs,
  }
}

/**
 * 接缝相关的请求参数。三层覆盖关系：工具参数 > 插件配置 > 服务端默认值。
 * 之所以按请求传，是为了让同一次会话里针对不同段落用不同语速/语气时不用重启服务。
 */
function seamPayload(cfg, seamArg, pausesArg) {
  const seam = (typeof seamArg === 'string' && seamArg.trim()) || cfg.seamPolicy || 'target'
  const merged = { ...(cfg.seamPauses || {}) }
  if (pausesArg && typeof pausesArg === 'object') {
    for (const [k, v] of Object.entries(pausesArg)) {
      const n = Number(v)
      if (Number.isFinite(n) && n >= 0) merged[k] = Math.round(n)
    }
  }
  const out = { seam }
  if (Object.keys(merged).length > 0) out.seam_target_ms = merged
  return out
}

/** 峰值上限：工具参数 > 插件配置 > 服务端默认。 */
function peakPayload(cfg, peakArg) {
  const v = Number(peakArg)
  if (Number.isFinite(v) && v > 0 && v <= 1) return { peak_ceiling: v }
  return {}
}

async function httpJson(url, body, timeoutMs = 15000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    })
    const text = await res.text()
    let json
    try { json = JSON.parse(text) } catch { throw new Error('service returned non-JSON: ' + text.slice(0, 200)) }
    if (!res.ok || json.ok === false) throw new Error(json.error || ('service HTTP ' + res.status))
    return json
  } finally {
    clearTimeout(timer)
  }
}

async function serviceUp(cfg) {
  try {
    await httpJson('http://127.0.0.1:' + cfg.port + '/health', undefined, 1200)
    return true
  } catch { return false }
}

async function ensureService(cfg, cwd, log) {
  if (await serviceUp(cfg)) return
  if (SERVICE.starting) { await SERVICE.starting; return }
  SERVICE.starting = startService(cfg, cwd, log)
  try { await SERVICE.starting } finally { SERVICE.starting = null }
}

async function startService(cfg, cwd, log) {
  if (SERVICE.proc === null) {
    const confPath = path.join(os.tmpdir(), 'dsh-tts-' + cfg.port + '.json')
    writeFileSync(confPath, JSON.stringify(cfgFor(cfg, cwd), null, 2), 'utf8')
    const script = path.join(pluginRoot, 'server', 'tts_server.py')
    if (!existsSync(script)) throw new Error('找不到服务端脚本：' + script)
    if (!existsSync(cfg.pythonPath)) throw new Error('找不到 Python：' + cfg.pythonPath + '（请在插件配置里填 pythonPath）')
    let out = 'ignore'
    if (cfg.logFile) {
      mkdirSync(path.dirname(cfg.logFile), { recursive: true })
      out = openSync(cfg.logFile, 'a')
    }
    log('info', '启动配音服务 ' + cfg.pythonPath + ' ' + script)
    SERVICE.proc = spawn(cfg.pythonPath, [script, confPath], {
      detached: false, windowsHide: true, stdio: ['ignore', out, out],
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    })
    const child = SERVICE.proc
    child.on('exit', (code) => {
      // 只清自己那次的引用：并发或重启时别的进程可能已经接管
      if (SERVICE.proc === child) SERVICE.proc = null
      SERVICE.lastExit = { code, at: Date.now() }
      log('info', '配音服务退出 code=' + code)
    })
    child.on('error', (err) => {
      if (SERVICE.proc === child) SERVICE.proc = null
      SERVICE.lastError = String(err && err.message)
    })
  }
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    if (await serviceUp(cfg)) { SERVICE.startedAt = Date.now(); return }
    // 刚 spawn 就退出：端口被占、Python 路径错、依赖缺失都会这样。
    // 原来这里会白等满 90 秒，现在立刻报出来。
    if (SERVICE.proc === null && SERVICE.lastExit) {
      throw new Error('配音服务启动即退出（code=' + SERVICE.lastExit.code + '）。'
        + '常见原因：端口 ' + cfg.port + ' 被别的程序占用、pythonPath 不对、或依赖没装全。'
        + (cfg.logFile ? ' 详见日志 ' + cfg.logFile : ''))
    }
    await new Promise((r) => setTimeout(r, 1200))
  }
  throw new Error('配音服务启动超时（90s）。' + (SERVICE.lastError ? ' 原因：' + SERVICE.lastError : '') +
    ' 需要本机有可用的 CUDA 与已安装的 qwen-tts 依赖。')
}

function call(cfg, req, body) {
  return httpJson('http://127.0.0.1:' + cfg.port + '/', { req, ...body }, cfg.timeoutMs)
}

/** 产物扫描：纯文件系统，**不需要**启动配音服务。 */
async function scanOutputs(cfg, limit = 40) {
  const root = cfg.workDir || path.join(process.cwd(), '配音')
  const exts = new Set(['.mp3', '.wav', '.m4a', '.flac', '.mp4', '.srt'])
  const flat = []
  let top = []
  try { top = await fsp.readdir(root, { withFileTypes: true }) } catch { return { files: [], total: 0, root } }
  for (const e of top) {
    const p = path.join(root, e.name)
    if (e.isFile()) flat.push(p)
    else if (e.isDirectory() && e.name !== '.tmp') {
      try {
        for (const f of await fsp.readdir(p, { withFileTypes: true })) if (f.isFile()) flat.push(path.join(p, f.name))
      } catch { /* 目录读不到就跳过 */ }
    }
  }
  const items = []
  for (const p of flat) {
    const ext = path.extname(p).toLowerCase()
    if (!exts.has(ext)) continue
    try {
      const st = await fsp.stat(p)
      const dir = path.basename(path.dirname(p)) === path.basename(root) ? '' : path.basename(path.dirname(p))
      items.push({
        name: path.basename(p), path: p, dir, ext,
        rel: path.relative(root, p).split(path.sep).join('/'),
        bytes: st.size, mtime: Math.floor(st.mtimeMs / 1000),
      })
    } catch { /* 单个文件读不到就跳过 */ }
  }
  items.sort((a, b) => b.mtime - a.mtime)
  return { files: items.slice(0, limit), total: items.length, root }
}

/** 音色库读取：同样只读文件，不启动服务。 */
async function readBankIndex(cfg) {
  const dir = path.join(cfg.workDir || path.join(process.cwd(), '配音'), 'voicebank')
  try {
    const raw = await fsp.readFile(path.join(dir, 'index.json'), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}

/* ------------------------------------------------------------------ voices */

function isMediaFile(v) {
  return AUDIO_EXT.test(v) || VIDEO_EXT.test(v)
}

function slug(s) {
  // Bank names are spoken back by the user, so keep them short: first clause only.
  const head = String(s || '').split(/[，。；：,.;:（(]/u)[0].trim()
  const cleaned = head.replace(/[\\/:*?"<>|\s]+/gu, '-').replace(/-+/gu, '-')
  return (cleaned.length > 12 ? cleaned.slice(0, 12) : cleaned) || 'voice'
}

/** Turn the tool's voice argument into a concrete spec the service understands. */
async function resolveVoice(cfg, cwd, log, voice) {
  const raw = String(voice || '').trim()
  if (raw === '') {
    const d = cfg.defaultVoice || 'Dylan'
    return { kind: 'custom', voice: { speaker: d }, label: d + '（默认）' }
  }

  if (PRESETS.includes(raw)) {
    return { kind: 'custom', voice: { speaker: raw }, label: raw }
  }
  // bank hit?
  try {
    const bank = await call(cfg, 'bank_list', {})
    if (bank.entries && bank.entries[raw]) {
      const e = bank.entries[raw]
      return { kind: e.kind, voice: e.voice, label: raw + '（音色库）', fromBank: true }
    }
  } catch { /* service may be cold; ignore */ }

  const abs = path.isAbsolute(raw) ? raw : path.join(cwd, raw)
  if (existsSync(abs) && isMediaFile(abs)) {
    log('info', '参考素材：' + abs)
    const sep = await call(cfg, 'separate', { media: abs, target: 9 })
    return {
      kind: 'base',
      voice: { ref_audio: sep.ref_clip, ref_text: sep.ref_text || null },
      label: '克隆自 ' + path.basename(abs),
      ref: sep,
    }
  }
  return { kind: 'design', voice: { instruct: raw }, label: raw }
}

/* ------------------------------------------------------------------ helpers */

async function runFfmpeg(cfg, args, opts) {
  return await new Promise((resolve, reject) => {
    const child = spawn(cfg.ffmpeg, args, { windowsHide: true, cwd: opts && opts.cwd ? opts.cwd : undefined })
    let err = ''
    child.stderr.on('data', (d) => { err += String(d) })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error('ffmpeg 失败(' + code + ')：' + err.slice(-400))))
  })
}

async function toMp3(cfg, wav, mp3) {
  await runFfmpeg(cfg, ['-y', '-v', 'error', '-i', wav, '-c:a', 'libmp3lame', '-b:a', '192k', mp3])
}

/**
 * Stitch long-text parts. The service writes 16-bit mono PCM, so joining at the
 * byte level is exact and avoids feeding Windows paths to an ffmpeg concat list;
 * anything unexpected (or corrupt) falls back to the demuxer.
 */
async function concatParts(cfg, log, parts, out) {
  try {
    return concatPcm16(parts, out)
  } catch (error) {
    log('warn', '直接拼接失败，回退 ffmpeg：' + (error && error.message ? error.message : error))
    const listFile = out + '.concat.txt'
    const body = parts.map((p) => "file '" + ffconcatPath(p) + "'")
      .join(String.fromCharCode(10))
    await fsp.writeFile(listFile, body, 'utf8')
    try {
      await runFfmpeg(cfg, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', out])
    } finally {
      try { await fsp.rm(listFile, { force: true }) } catch { /* ignore */ }
    }
  }
}

async function renderVideo(cfg, opts) {
  const { wav, srt, out, background, width, height, cwd, duration } = opts
  const vf = "subtitles=" + path.basename(srt) +
    ":force_style='FontName=Microsoft YaHei,FontSize=26,PrimaryColour=&H00FFFFFF,OutlineColour=&H90000000,BorderStyle=1,Outline=2,MarginV=64'"
  const args = ['-y', '-v', 'error']
  if (background && existsSync(background)) {
    args.push('-loop', '1', '-i', background)
  } else {
    args.push('-f', 'lavfi', '-i', 'gradients=s=' + width + 'x' + height + ':c0=0x081426:c1=0x1d3b5c:d=30:speed=0.04')
  }
  args.push('-i', wav, '-vf', 'scale=' + width + ':' + height + ',' + vf,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k')
  // -shortest alone lets the filter chain overshoot by ~1-2 s of silent video.
  if (Number.isFinite(duration) && duration > 0) args.push('-t', String(duration))
  args.push(out)
  await runFfmpeg(cfg, args, { cwd })
}

function similarity(a, b) {
  const strip = (s) => String(s || '').replace(/[\s，。！？、；：,.!?;:]/gu, '')
  const x = strip(a), y = strip(b)
  if (x === y) return 1
  const m = x.length, n = y.length
  if (m === 0 || n === 0) return 0
  let prev = new Array(n + 1).fill(0)
  for (let i = 1; i <= m; i++) {
    const cur = new Array(n + 1).fill(0)
    for (let j = 1; j <= n; j++) {
      cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    }
    prev = cur
  }
  return (2 * prev[n]) / (m + n)
}

async function qualityCheck(cfg, wav, text) {
  const res = await call(cfg, 'asr', { audio: wav, language: 'Chinese' })
  const score = similarity(text, res.text)
  return { heard: res.text, score: Number(score.toFixed(3)), ok: score >= 0.95 }
}

/* ------------------------------------------------------------------ tool */

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', description: '要配音的文案。可以多段，插件按句切分并自动生成逐句字幕时间轴。' },
    textFile: { type: 'string', description: '也可以给一个 txt/md 文件路径，插件读文件当文案。' },
    voice: {
      type: 'string',
      description: '音色，四种写法任选：① 预设名 Serena/Uncle_Fu/Vivian/Dylan/Eric；② 中文描述如"低沉沙哑的中年男声，像深夜电台"；'
        + '③ 参考音频或视频的本地路径（会自动分离人声并挑最干净的 9 秒克隆）；④ 音色库里的名字（之前候选生成时自动入库）。'
        + '省略则用插件配置里的 defaultVoice（本机配的是「新闻联播音色」）。',
    },
    candidates: { type: 'integer', description: '候选数量，默认 3，范围 1-5。voice 传数组时会按数组逐条生成。' },
    mode: {
      type: 'string',
      description: "preview = 只出候选短样（各念文案首句，约 10 秒）；render = 用已确定的音色合全长。默认 auto：voice 是预设/音色库名就 render，是描述或参考素材就 preview。",
    },
    timeline: {
      type: 'array',
      description: '多角色对白的时间轴模式：[{start:0.0,end:3.2,voice:"Serena",text:"开场白"}]。给了它就忽略 text，按段合成后拼接。',
      items: { type: 'object' },
    },
    video: { type: 'boolean', description: '是否额外输出带字幕的 mp4 成片（默认 false）。' },
    background: { type: 'string', description: '成片背景图或视频路径；不给就用内置深蓝渐变。' },
    width: { type: 'integer', description: '成片宽度，默认 1920。' },
    height: { type: 'integer', description: '成片高度，默认 1080。' },
    qualityCheck: { type: 'boolean', description: '是否用 ASR 回读校验（默认 true）。发现漏字/多音字错误会标记出来。' },
    title: { type: 'string', description: '输出文件名前缀，默认按时间生成。' },
    bank: { type: 'boolean', description: '是否把这个音色存进音色库（默认 false）。整套流程里只有"以后还要用这个音色"才需要开。' },
    seam: { type: 'string', description: '接缝策略：target（默认，按句末标点把停顿规整到设定值）/ current（沿用旧行为，只保留 25ms 边距）。' },
    seamPauses: {
      type: 'object',
      description: '句间停顿毫秒数，按键覆盖默认值，如 {"。": 260, "；": 160}。用来适配不同语气与场合：新闻播报给大一点，口语化给小一点。',
      additionalProperties: { type: 'integer' },
    },
    peakCeiling: {
      type: 'number',
      description: '归一化的峰值上限（0~1，默认 0.95）。模型自带的硬瞬态会贴着这个上限，觉得"爆麦"就调到 0.70 左右，代价是整体音量低 3dB。',
    },
    align: {
      type: 'boolean',
      description: '是否用强制对齐重排字幕（默认 false）。开启后会把每个字对到音频上的真实时间，长句自动拆成多条短字幕；'
        + '需要先配好 models.aligner，且会多加载一个模型（自动先释放 TTS）。',
    },
    alignMaxChars: { type: 'integer', description: '强制对齐后每条字幕最多几个字，默认 16。' },
    toneTameDb: {
      type: 'number',
      description: '高频层降（dB，负数=压 6kHz 以上）。声音"刺"、齿音重时给 -3~-5；实测 -4 能把瞬态陡度压 21% 而几乎不损失响度。默认 0 = 不处理。',
    },
  },
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    mode: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    message: { type: 'string' },
  },
  required: ['mode', 'files', 'message'],
}

let pluginRoot = ''

function makeTool(ctx, cfg, log, onProduced) {
  return {
    name: 'voiceover',
    description:
      '本地文案配音：把一段文案合成为中文语音，产出 mp3 + 逐句 SRT 字幕，可选直出带字幕的 mp4 成片。'
      + '音色四种给法：预设名（Serena/Uncle_Fu/Vivian…）、中文描述（会自动造音色）、参考音视频路径（自动分离人声并克隆）、音色库名。'
      + '第一次调用会拉起本地配音服务（约 10-30 秒），之后常驻、空闲 5 分钟自动关闭释放显存。全程离线、不出网、不需要 API Key。'
      + '出候选时每个样音都会自动入库，之后用库名即可复用同一音色；全长渲染默认不入库，要保存就传 bank=true。'
      + '长文案会自动按 300 字分批合成再拼回，中途失败重跑会跳过已完成的分片。'
      + '声音觉得"刺"可传 toneTameDb=-4（压 6kHz 以上），觉得"爆"可传 peakCeiling=0.7。',
    parameters: PARAMETERS,
    timeoutMs: cfg.timeoutMs,
    isConcurrencySafe: () => false,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.message }],
      presentationMeta: (_args, value) => ({ files: value.files }),
    },
    async execute(args, exec) {
      return BUSY.run('voiceover', Number(cfg.busyWaitMs) || 0, () => this.executeInner(args, exec))
    },
    async executeInner(args, exec) {
      const concat = (parts, out) => concatParts(cfg, log, parts, out)
      const runOnce = async () => {
      const cwd = exec?.agent?.session?.cwd || process.cwd()
      log('info', 'voiceover 开始：voice=' + String(args?.voice ?? '') + ' mode=' + String(args?.mode ?? 'auto'))
      await ensureService(cfg, cwd, log)
      const workDir = cfg.workDir || path.join(cwd, '配音')
      await fsp.mkdir(workDir, { recursive: true })

      let text = String(args?.text || '').trim()
      if (text === '' && args?.textFile) {
        text = (await fsp.readFile(path.resolve(cwd, String(args.textFile)), 'utf8')).trim()
      }
      // Content-derived stem: running the same script again resumes the parts
      // that already finished instead of redoing every chunk on the GPU.
      const seed = Array.isArray(args?.timeline) && args.timeline.length > 0
        ? JSON.stringify(args.timeline)
        : (text || String(Date.now()))
      const stem = slug(args?.title || ('vo-' + shortHash(seed)))

      const voiceArg = args?.voice
      const multi = Array.isArray(voiceArg) ? voiceArg : null
      const requested = typeof args?.mode === 'string' ? args.mode : 'auto'
      const specs = []
      if (multi) {
        for (const v of multi) specs.push(await resolveVoice(cfg, cwd, log, v))
      } else {
        specs.push(await resolveVoice(cfg, cwd, log, voiceArg))
      }

      // A bank entry is already a chosen voice: render it, never re-preview it.
      const needPreview = requested === 'preview' ||
        (requested === 'auto' && specs.some((s) => !s.fromBank && (s.kind === 'design' || s.kind === 'base')))

      /* ---------- candidates ---------- */
      if (needPreview) {
        if (text === '') throw new Error('preview 模式需要 text（用文案首句生成试听样音）')
        const firstSentence = String(text).split(/(?<=[。！？!?])/u)[0].slice(0, 40)
        const n = Math.max(1, Math.min(5, Number.isFinite(args?.candidates) ? Number(args.candidates) : (multi ? multi.length : 3)))
        const items = []
        for (let i = 0; i < n; i++) {
          const spec = specs[i % specs.length]
          items.push({
            kind: spec.kind,
            voice: spec.voice,
            label: multi ? spec.label : (spec.label + (n > 1 ? ' #' + (i + 1) : '')),
          })
        }
        const res = await call(cfg, 'preview', { text: firstSentence, stem, items })
        const files = []
        const listed = []
        for (const c of res.candidates) {
          const mp3 = c.wav.replace(/\.wav$/u, '.mp3')
          await toMp3(cfg, c.wav, mp3)
          const entry = await call(cfg, 'bank_add', {
            entry: {
              name: slug(specs[(c.index - 1) % specs.length].label) + '-' + new Date().toISOString().slice(5, 10).replace('-', ''),
              kind: c.kind,
              voice: c.voice,
              sample_mp3: mp3,
              note: c.label,
            },
          })
          files.push(mp3)
          listed.push({ index: c.index, mp3, dur: c.dur, label: c.label, bank: entry.entry.name })
        }
        onProduced(exec, files)
        const lines = listed.map((c) => '  候选' + c.index + '：' + c.bank + '（' + c.dur + 's）' + c.label)
        return {
          mode: 'preview',
          files,
          candidates: listed,
          message: '已生成 ' + listed.length + ' 个候选样音，全部入库：\n' + lines.join('\n') +
            '\n选定后把音色库名当 voice 传回来即可合全长。',
        }
      }

      /* ---------- full render ---------- */
      const spec = specs[0]
      let wav, srt, dur, chunks = 1, reused = 0
      if (Array.isArray(args?.timeline) && args.timeline.length > 0) {
        const items = []
        for (const seg of args.timeline) {
          const segSpec = await resolveVoice(cfg, cwd, log, seg.voice)
          items.push({ text: String(seg.text || ''), kind: segSpec.kind, voice: segSpec.voice })
        }
        // Batching by cumulative characters: a long dialogue is otherwise one
        // request that the gateway kills at the five-minute mark.
        const r = await synthTimeline({
          items, stem, outDir: workDir, log, concat,
          timeline: (batch, partStem) => call(cfg, 'timeline', { items: batch, stem: partStem }),
        })
        wav = r.wav; srt = r.srt; dur = r.dur; chunks = r.chunks; reused = r.reused
      } else {
        if (text === '') throw new Error('缺少 text：请给要配音的文案，或用 textFile 指定文件')
        // Long scripts go out in <=300-character requests; parts are cached so a
        // failure half way resumes instead of re-synthesizing everything.
        const r = await synthChunks({
          text, stem, outDir: workDir, log, concat,
          say: (piece, partStem) => call(cfg, 'say', {
            text: piece, voice: spec.voice, kind: spec.kind, stem: partStem, out_dir: workDir, takes: 1,
            ...seamPayload(cfg, args?.seam, args?.seamPauses),
            ...peakPayload(cfg, args?.peakCeiling),
            ...(Number.isFinite(Number(args?.toneTameDb)) ? { tone_tame_db: Number(args.toneTameDb) } : {}),
          }),
        })
        wav = r.wav; srt = r.srt; dur = r.dur; chunks = r.chunks; reused = r.reused
      }

      // 强制对齐：把字级真实时间取回来，重排成更细的字幕。
      // 放在这里而不是 say 里，是因为长文案会分多批合成——对齐要对着**拼好的整段**做一次。
      let alignedCues = 0
      if (args?.align === true && text !== '') {
        try {
          const al = await call(cfg, 'align', { audio: wav, text, language: 'Chinese' })
          if (Array.isArray(al.items) && al.items.length > 0) {
            // 对齐结果里没有标点，先和原文绑回去再断行
            const merged = bindAlignedText(al.items, text)
            const cues = groupAlignedCues(merged, {
              maxChars: Number(args?.alignMaxChars) || 16,
              // 服务端用模型 tokenizer 算出的 token 结束位置，当作允许断行的位置
              breakable: Array.isArray(al.breaks) ? al.breaks : null,
            })
            if (cues.length > 0) {
              await fsp.writeFile(srt, buildSrt(cues), 'utf8')
              alignedCues = cues.length
            }
          }
        } catch (error) {
          log('warn', '强制对齐失败，保留原字幕：' + (error && error.message ? error.message : error))
        }
      }

      const mp3 = wav.replace(/\.wav$/u, '.mp3')
      await toMp3(cfg, wav, mp3)
      const files = [mp3, srt, wav]

      let mp4 = ''
      if (args?.video) {
        mp4 = path.join(workDir, stem + '.mp4')
        await renderVideo(cfg, {
          wav, srt, out: mp4, background: args?.background,
          width: Number(args?.width) || 1920, height: Number(args?.height) || 1080,
          cwd: path.dirname(srt),
          duration: dur,
        })
        files.unshift(mp4)
      }

      let qa = null
      if (args?.qualityCheck !== false && text !== '') {
        qa = await qualityCheck(cfg, wav, text)
        if (!qa.ok) log('warn', 'ASR 质检未通过：相似度 ' + qa.score)
      }

      // 全长渲染默认不入库：以前每渲染一次就往库里塞一条，同一音色反复出现
      // -2/-3/-4，把库撑成一堆等价副本。要保存音色就显式传 bank=true。
      let bankName = ''
      if (args?.bank === true) {
        const added = await call(cfg, 'bank_add', {
          entry: {
            name: slug(spec.label) + '-' + new Date().toISOString().slice(5, 10).replace('-', ''),
            kind: spec.kind, voice: spec.voice, sample_mp3: mp3, note: '全长合成', dedupe: true,
          },
        })
        bankName = added.entry.name
      }
      onProduced(exec, files)
      const bits = ['已合成 ' + dur + ' 秒音频，音色：' + spec.label
        + (bankName ? '（已入库：' + bankName + '）' : '（未入库，要保存音色请传 bank=true）')]
      if (chunks > 1) bits.push('长文案分 ' + chunks + ' 批合成（复用已完成 ' + reused + ' 批）；中途失败重跑请带 title=' + stem + ' 续跑')
      if (mp4) bits.push('成片：' + mp4)
      if (qa) bits.push('ASR 质检：相似度 ' + qa.score + (qa.ok ? '（通过）' : '（有差异，请检查）'))
      if (alignedCues > 0) bits.push('字幕已按强制对齐重排：' + alignedCues + ' 条（字级时间，长句自动拆行）')
      return { mode: 'render', files, mp3, srt, wav, mp4, duration: dur, qa, bank: bankName, message: bits.join('\n') }
      }
      try {
        return await runOnce()
      } catch (error) {
        const msg = String(error && error.message ? error.message : error)
        // A service that half-imported torch/transformers stays poisoned for its
        // whole lifetime; only a fresh process recovers. Retry once on that class
        // of failure instead of making the user restart DSH.
        if (!/already registered|temporary directory|stdio|ECONNREFUSED|ECONNRESET|EPIPE|fetch failed|socket hang up|headers ?timeout|UND_ERR_HEADERS_TIMEOUT|服务启动超时/iu.test(msg)) throw error
        log('warn', '配音服务异常，重启后重试一次：' + msg)
        try { await httpJson('http://127.0.0.1:' + cfg.port + '/', { req: 'shutdown' }, 3000) } catch { /* already gone */ }
        await new Promise((r) => setTimeout(r, 1500))
        SERVICE.proc = null
        return await runOnce()
      }
    },
  }
}


/* ------------------------------------------------------- timeline tool ---- */

const TIMELINE_PARAMS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    xmlFile: { type: 'string', description: 'PR 导出的 FCP XML 路径（文件→导出→Final Cut Pro XML）。' },
    scriptFile: { type: 'string', description: '外侧文案路径。格式：01/正文；02S/只出字幕；03V/只配音。' },
    sequence: { type: 'integer', description: 'XML 里有多个序列时选第几个（1 起）。只有一个时不用填。' },
    stage: {
      type: 'string',
      description: 'plan = 只做预检（解析时间轴+文案，给出每段预计时长与差异，不花 GPU 时间）；run = 确认后真正合成。默认 plan。',
    },
    mode: {
      type: 'string',
      description: 'both = 配音+字幕（默认）；voice = 仅配音；subtitle = 仅字幕。文案里的 02S/ 03V/ 会覆盖这个全局设置。',
    },
    outDir: { type: 'string', description: '产物目录，默认「<工作区>/配音/<序列名>-<MMDD>/」。' },
    charsPerSecond: { type: 'number', description: '预估语速，默认 4.5 字/秒。偏差大时调这个。' },
    voice: { type: 'string', description: '音色，默认用插件 defaultVoice；支持预设名/描述/参考素材/音色库名。' },
    seam: { type: 'string', description: '接缝策略：target（默认）/ current。' },
    seamPauses: {
      type: 'object',
      description: '句间停顿毫秒数，按键覆盖默认值，如 {"。": 260, "；": 160}。同一片里不同段落语气不同时，可以只调这一次调用。',
      additionalProperties: { type: 'integer' },
    },
    peakCeiling: { type: 'number', description: '归一化峰值上限（0~1，默认 0.95）；觉得爆麦就调到 0.70 左右。' },
    toneTameDb: { type: 'number', description: '高频层降（dB，负数=压）；声音刺时给 -3~-5，默认 0。' },
    alignMaxChars: {
      type: 'integer',
      description: '反听段（02S/ 正文留空）重排字幕时每条最多几个字，默认 16。普通字幕段不受影响（那段是按字数分配的）。',
    },
  },
  required: ['xmlFile', 'scriptFile'],
}

const TIMELINE_OUTPUT = {
  type: 'object',
  additionalProperties: true,
  properties: {
    stage: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    message: { type: 'string' },
  },
  required: ['stage', 'files', 'message'],
}

function makeTimelineTool(ctx, cfg, log, onProduced) {
  return {
    name: 'voiceover_timeline',
    description:
      '按 PR 时间轴配音：读取 PR 导出的 FCP XML（只认 xmeml；达芬奇/FCP X 请导出 FCP 7 XML），'
      + '取序列上的范围标记（名称如 01、02），与外侧文案的编号一一对应，逐段配音并生成整片对齐的字幕。'
      + '非目标格式（FCPXML / EDL / 非 XML）会直接说明该导出什么。'
      + '两阶段：stage=plan 先出预检表（每段预计时长 vs 标记范围，标出超出/偏短并给修改建议），不耗时；确认后 stage=run 才真正合成。'
      + '支持三种交付：both（配音+字幕，默认）、voice（仅配音）、subtitle（仅字幕）；文案里写 02S/ 表示该段只出字幕，03V/ 表示只配音。'
      + '02S/ 后面正文留空则该段走"反听"：自动从原片切出这段音频，ASR 转写 + 强制对齐，出真实时间戳字幕。'
      + '产物：每段一个 <编号>.wav + 一条全片 SRT + 对账表 CSV。',
    parameters: TIMELINE_PARAMS,
    timeoutMs: cfg.timeoutMs,
    isConcurrencySafe: () => false,
    output: {
      schema: TIMELINE_OUTPUT,
      render: (_a, v) => [{ type: 'text', text: v.message }],
      presentationMeta: (_a, v) => ({ files: v.files }),
    },
    async execute(args, exec) {
      return BUSY.run('voiceover_timeline', Number(cfg.busyWaitMs) || 0, () => this.executeInner(args, exec))
    },
    async executeInner(args, exec) {
      const cwd = exec?.agent?.session?.cwd || process.cwd()
      const timeline = await import('./timeline.js')
      const planMod = await import('./plan.js')
      const abs = (f) => (path.isAbsolute(String(f)) ? String(f) : path.join(cwd, String(f)))
      const xmlPath = abs(args.xmlFile)
      const scriptPath = abs(args.scriptFile)
      const xmlText = await fsp.readFile(xmlPath, 'utf8')
      const seq = timeline.pickSequence(timeline.readTimeline(xmlText), args.sequence)
      const scriptText = await fsp.readFile(scriptPath, 'utf8')
      const stage = String(args.stage || 'plan').toLowerCase()
      const mode = ['voice', 'subtitle', 'both'].includes(args.mode) ? args.mode : 'both'
      const plan = planMod.buildPlan(seq, scriptText, { mode, charsPerSecond: args.charsPerSecond })

      if (plan.errors.length) {
        return { stage: 'blocked', files: [], message: '无法开始，时间轴和文案对不上：\n- ' + plan.errors.join('\n- ') }
      }

      if (stage !== 'run') {
        const table = planMod.renderPlanTable(plan)
        const s = plan.summary
        const head = '序列「' + seq.name + '」· ' + seq.markers.length + ' 个标记 · 文案 ' + s.total + ' 段'
          + '（配音 ' + s.voice + ' / 仅字幕 ' + s.subtitleOnly + (s.asr > 0 ? '，其中反听 ' + s.asr : '') + '）· 预计配音总长 ' + s.estimatedVoiceSeconds + 's'
        const tail = plan.issues.length ? '\n\n注意：\n- ' + plan.issues.join('\n- ') : ''
        return {
          stage: 'plan',
          files: [],
          plan: { rows: plan.rows, summary: s, sequence: { name: seq.name, timebase: seq.timebase } },
          message: head + '\n\n' + table + tail
            + '\n\n确认后我按 mode=' + mode + ' 开跑（可用 voice / subtitle / both）。',
        }
      }

      const outDir = abs(args.outDir || path.join('配音', seq.name + '-' + new Date().toISOString().slice(5, 10).replace('-', '')))
      await fsp.mkdir(outDir, { recursive: true })
      await ensureService(cfg, cwd, log)
      const spec = await resolveVoice(cfg, cwd, log, args.voice || cfg.defaultVoice || 'Dylan')
      const files = []
      const cues = []
      const audit = []
      let voiceDone = 0
      // 反听字幕要按标记区间从原片切音频，先把 clips 准备好（只在真的用到时才解析）
      const xmlMod = await import('./xml.js')
      const clipsMod = await import('./clips.js')
      const xmlClips = clipsMod.readClips(xmlMod.parseXml(xmlText))
      for (const row of plan.rows) {
        if (row.mode !== 'subtitle') {
          const chunks = splitForRequest(row.text, 300)
          const partWavs = []
          let offset = 0
          let totalDur = 0
          for (let i = 0; i < chunks.length; i += 1) {
            const stem = chunks.length > 1 ? row.id + '-p' + (i + 1) : row.id
            const r = await call(cfg, 'say', {
              text: chunks[i], voice: spec.voice, kind: spec.kind, stem, out_dir: outDir, takes: 1,
              ...seamPayload(cfg, args?.seam, args?.seamPauses),
              ...peakPayload(cfg, args?.peakCeiling),
              ...(Number.isFinite(Number(args?.toneTameDb))
                ? { tone_tame_db: Number(args.toneTameDb) }
                : (Number.isFinite(Number(cfg.toneTameDb)) ? { tone_tame_db: Number(cfg.toneTameDb) } : {})),
            })
            partWavs.push(path.join(outDir, stem + '.wav'))
            // mode=voice means the picture already carries its own subtitles.
            if (row.mode !== 'voice') {
              for (const cue of parseSrt(await fsp.readFile(r.srt, 'utf8'))) {
                cues.push({ start: row.startSec + offset + cue.start, end: row.startSec + offset + cue.end, text: cue.text })
              }
            }
            offset += r.dur
            totalDur += r.dur
          }
          const wavPath = path.join(outDir, row.id + '.wav')
          if (partWavs.length > 1) {
            const listFile = path.join(outDir, row.id + '-concat.txt')
            await fsp.writeFile(listFile, partWavs.map((x) => "file '" + ffconcatPath(x) + "'").join(String.fromCharCode(10)), 'utf8')
            await runFfmpeg(cfg, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', wavPath])
            for (const x of partWavs) { try { await fsp.unlink(x) } catch { /* keep */ } }
          } else {
            await fsp.copyFile(partWavs[0], wavPath)
          }
          const mp3Path = path.join(outDir, row.id + '.mp3')
          await toMp3(cfg, wavPath, mp3Path)
          files.push(mp3Path)
          voiceDone += 1
          audit.push({ id: row.id, mode: row.mode, estimate: row.estimate, actual: Number(totalDur.toFixed(2)), range: row.range, over: Number((totalDur - row.range).toFixed(2)) })
        } else if (row.asr) {
          // 反听字幕：把这段原片音频切出来 → ASR 转写 → 强制对齐 → 真实时间戳。
          // 以前要手工 build_seg_audio.mjs + curl + merge_srt.py 才能做，现在在工具里。
          const slices = clipsMod.slicesForRange(xmlClips, row.startSec, row.endSec)
          if (slices.length === 0) {
            audit.push({ id: row.id, mode: 'subtitle(反听)', estimate: '', actual: '', range: row.range, over: '切不出音频' })
            log('warn', row.id + ' 反听字幕：标记区间里没有可用媒体片段')
          } else {
            const segParts = []
            for (let i = 0; i < slices.length; i += 1) {
              const s = slices[i]
              const part = path.join(outDir, row.id + '-asr-' + (i + 1) + '.wav')
              await runFfmpeg(cfg, ['-y', '-v', 'error',
                '-ss', Number(s.srcStartSec).toFixed(3), '-t', Number(s.durSec).toFixed(3), '-i', s.path,
                '-vn', '-ac', '1', '-ar', '16000', part])
              segParts.push(part)
            }
            const segWav = path.join(outDir, row.id + '-asr.wav')
            if (segParts.length === 1) await fsp.copyFile(segParts[0], segWav)
            else await concatParts(cfg, log, segParts, segWav)
            for (const p of segParts) { try { await fsp.unlink(p) } catch { /* keep */ } }

            const asr = await call(cfg, 'asr_subs', { audio: segWav, timestamps: true, stem: row.id + '-asr' })
            const segCues = []
            if (asr.timestamps && Array.isArray(asr.items) && asr.items.length > 0) {
              const merged = bindAlignedText(asr.items, asr.text)
              for (const c of groupAlignedCues(merged, {
                maxChars: Number(args?.alignMaxChars) || 16,
                breakable: Array.isArray(asr.breaks) ? asr.breaks : null,
              })) {
                segCues.push({ start: row.startSec + c.start, end: row.startSec + c.end, text: c.text })
              }
            } else if (Array.isArray(asr.cues)) {
              // 对齐器不可用时的退路：按字数分配（原来手工流程用的就是这个）
              log('warn', row.id + ' 反听字幕没拿到字级时间（对齐器不可用），退回按字数分配')
              for (const c of asr.cues) segCues.push({ start: row.startSec + c.start, end: row.startSec + c.end, text: c.text })
            }
            for (const c of segCues) cues.push(c)
            const segSrt = path.join(outDir, row.id + '-asr.srt')
            await fsp.writeFile(segSrt, buildSrt(segCues.map((c) => ({
              start: c.start - row.startSec, end: c.end - row.startSec, text: c.text,
            }))), 'utf8')
            files.push(segSrt)
            audit.push({ id: row.id, mode: 'subtitle(反听)', estimate: '', actual: '', range: row.range, over: segCues.length + ' 条' })
          }
        } else {
          // subtitle only: lay the sentences across the marker range
          const parts = String(row.text).split(/(?<=[。！？!?])/u).filter((s) => s.trim() !== '')
          const weights = parts.map((s) => Math.max(1, s.length))
          const total = weights.reduce((a, b) => a + b, 0)
          let cur = row.startSec
          for (let i = 0; i < parts.length; i++) {
            const dur = (row.range * weights[i]) / total
            cues.push({ start: cur, end: i === parts.length - 1 ? row.endSec : cur + dur, text: parts[i] })
            cur += dur
          }
          audit.push({ id: row.id, mode: 'subtitle', estimate: row.estimate, actual: '', range: row.range, over: '' })
        }
      }

      cues.sort((a, b) => a.start - b.start)
      const srtPath = path.join(outDir, 'voiceover.srt')
      await fsp.writeFile(srtPath, buildSrt(cues), 'utf8')
      files.push(srtPath)

      const csvPath = path.join(outDir, 'reconcile.csv')
      const csv = ['编号,模式,预计时长,实际时长,标记范围,超出']
        .concat(audit.map((a) => [a.id, a.mode, a.estimate, a.actual, a.range, a.over].join(',')))
        .join('\n')
      await fsp.writeFile(csvPath, csv, 'utf8')
      files.push(csvPath)

      onProduced(exec, files)
      const bad = audit.filter((a) => a.actual !== '' && Math.abs(Number(a.over)) > 0.3)
      return {
        stage: 'done',
        files,
        outDir,
        message: '完成：' + voiceDone + ' 段音频 + 全片字幕 + 对账表，输出在 ' + outDir
          + (bad.length ? '\n有 ' + bad.length + ' 段实际时长与标记范围差 >0.3s，见 reconcile.csv' : '\n每段时长都在范围内'),
      }
    },
  }
}

/* ---------------------------------------------------- retake tool ---- */

const RETAKE_PARAMS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', description: '完整文案（和实际要配的那份一致），我会按句切分后定位到 segment。' },
    textFile: { type: 'string', description: '也可以给文案文件路径。' },
    segment: { type: 'integer', description: '要重录第几句（1 起，按句号/问号/叹号切分）。不填会列出全部句子让你选。' },
    takes: { type: 'integer', description: '出几遍，默认 3，最多 6。' },
    voice: { type: 'string', description: '音色，默认用插件的 defaultVoice。' },
    use: { type: 'integer', description: '把第 N 遍定为该句采用版：复制成 chosen-N.wav 并记进 picks.json；同时传 full 就把它拼回整段音频。' },
    full: {
      type: 'string',
      description: '整段音频的文件名或路径（如 长文案回归）。配合 use 使用：按合成时记录的采样点边界，把选中的那版替换回原位置，'
        + '其余句子时间轴自动顺延。只能用于新版本渲染的音频（产物目录里要有 <名字>.bounds.json）。',
    },
  },
}

function splitSentences(text) {
  return String(text).split(/(?<=[。！？!?；;\n])/u).map((s) => s.trim()).filter((s) => s !== '')
}

function makeRetakeTool(ctx, cfg, log, onProduced) {
  return {
    name: 'voiceover_retakes',
    description:
      '句子级重录：把文案按句切分，指定第几句，出 N 个版本供挑选。每版会测内部停顿并标出异常（停顿数超过标点数的版本通常是断气/卡顿）。'
      + '选定后传 use=N 记录采用版（复制成 chosen-N.wav 并写 picks.json）；再加 full=<整段文件名> 就直接拼回整段——'
      + '按合成时记录的采样点边界替换，不靠字幕时间猜（字幕是显示用的，含偏移且只有毫秒精度）。'
      + '拼回后其余句子的字幕时间轴自动顺延，产物是 <名字>-patched.wav/.mp3/.srt。',
    parameters: RETAKE_PARAMS,
    timeoutMs: cfg.timeoutMs,
    isConcurrencySafe: () => false,
    output: {
      schema: {
        type: 'object', additionalProperties: true,
        properties: { stage: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, message: { type: 'string' } },
        required: ['stage', 'files', 'message'],
      },
      render: (_a, v) => [{ type: 'text', text: v.message }],
      presentationMeta: (_a, v) => ({ files: v.files }),
    },
    async execute(args, exec) {
      return BUSY.run('voiceover_retakes', Number(cfg.busyWaitMs) || 0, () => this.executeInner(args, exec))
    },
    async executeInner(args, exec) {
      const cwd = exec?.agent?.session?.cwd || process.cwd()
      const audio = await import('./audio.js')
      let text = String(args?.text || '').trim()
      if (text === '' && args?.textFile) text = (await fsp.readFile(path.resolve(cwd, String(args.textFile)), 'utf8')).trim()
      if (text === '') throw new Error('缺少 text / textFile')
      const sentences = splitSentences(text)
      const segNo = Number(args?.segment)
      if (!Number.isInteger(segNo) || segNo < 1 || segNo > sentences.length) {
        const list = sentences.map((s, i) => (i + 1) + '. ' + (s.length > 28 ? s.slice(0, 28) + '…' : s) + '（' + s.length + '字）').join('\n')
        return { stage: 'need-segment', files: [], message: '文案共 ' + sentences.length + ' 句，请指定 segment：\n' + list }
      }
      const segText = sentences[segNo - 1]
      const outDir = path.join(cfg.workDir || path.join(cwd, '配音'), 'takes')
      await fsp.mkdir(outDir, { recursive: true })
      await ensureService(cfg, cwd, log)
      const spec = await resolveVoice(cfg, cwd, log, args?.voice || cfg.defaultVoice || 'Dylan')

      if (Number.isInteger(Number(args?.use))) {
        const k = Number(args.use)
        const srcWav = path.join(outDir, 'take-' + segNo + '-' + k + '.wav')
        if (!existsSync(srcWav)) throw new Error('找不到第 ' + segNo + ' 句的第 ' + k + ' 遍：' + srcWav)
        const chosen = path.join(outDir, 'chosen-' + segNo + '.wav')
        await fsp.copyFile(srcWav, chosen)
        // picks 的键从"句子序号"改成"句序 + 文本 hash + 音色"：
        // 改文案后旧选择不会落到别的句子上，同一句换音色重录也不会互相覆盖。
        const picksMod = await import('./picks.js')
        const picksPath = path.join(outDir, 'picks.json')
        let store = picksMod.emptyPicks()
        try { store = picksMod.loadPicks(JSON.parse(await fsp.readFile(picksPath, 'utf8'))) } catch { /* 第一次记录 */ }
        const tag = picksMod.voiceTag(spec)
        const rec = picksMod.recordPick(store, {
          segNo, text: segText, voiceTag: tag, take: k,
          file: path.basename(chosen), at: new Date().toISOString(),
        })
        await fsp.writeFile(picksPath, JSON.stringify(rec.store, null, 2), 'utf8')
        const mp3 = chosen.replace(/\.wav$/u, '.mp3')
        await toMp3(cfg, chosen, mp3)

        // 没给 full 就到此为止：只把选中的那版单独存好。
        const fullArg = String(args?.full || '').trim()
        if (fullArg === '') {
          onProduced(exec, [chosen, mp3])
          return {
            stage: 'chosen',
            files: [chosen, mp3],
            message: '第 ' + segNo + ' 句采用第 ' + k + ' 遍，已记入 picks.json。\n'
              + '记录键：' + rec.key + '（含文本 hash 与音色，改文案或换音色都不会串）。\n'
              + '这句在这个音色下已累计选过 ' + rec.entry.picks.length + ' 次。\n'
              + '要把这一版拼回整段音频，再传 full=<整段文件名或 stem> 即可（旧版本渲染的音频没有句子边界，需要整段重跑一次）。',
          }
        }

        /* ---- 拼回整段：按采样点边界替换，不靠字幕时间 ---- */
        const workRoot = path.resolve(outDir, '..')
        const fullWav = path.isAbsolute(fullArg)
          ? fullArg
          : path.join(workRoot, /\.wav$/iu.test(fullArg) ? fullArg : fullArg + '.wav')
        if (!existsSync(fullWav)) throw new Error('找不到整段音频：' + fullWav)
        const boundsPath = fullWav.replace(/\.wav$/iu, '.bounds.json')
        if (!existsSync(boundsPath)) {
          throw new Error('这份整段音频没有句子边界文件（' + path.basename(boundsPath) + '）。'
            + '它是旧版本渲染出来的，边界无法反推，只能整段重跑一次。')
        }
        const meta = JSON.parse(await fsp.readFile(boundsPath, 'utf8'))
        const span = (meta.sentences || []).find((s) => Number(s.i) === segNo)
        if (!span) throw new Error('边界文件里只有 ' + (meta.sentences || []).length + ' 句，没有第 ' + segNo + ' 句')
        if (String(span.text || '').trim() !== String(segText).trim()) {
          throw new Error('第 ' + segNo + ' 句对不上：边界文件里是「' + String(span.text).slice(0, 26)
            + '」，当前文案是「' + String(segText).slice(0, 26) + '」。文案改过就要重新渲染整段。')
        }
        const fullStem = path.basename(fullWav).replace(/\.wav$/iu, '')
        let outStem = fullStem + '-patched'
        for (let n2 = 2; existsSync(path.join(workRoot, outStem + '.wav')); n2 += 1) outStem = fullStem + '-patched' + n2
        const res = await call(cfg, 'splice', {
          wav: fullWav, take: chosen, index: segNo, out_dir: workRoot, stem: outStem,
        })
        const patchedMp3 = res.wav.replace(/\.wav$/iu, '.mp3')
        await toMp3(cfg, res.wav, patchedMp3)
        const produced = [patchedMp3, res.wav, res.srt]
        onProduced(exec, produced)
        return {
          stage: 'spliced',
          files: produced,
          duration: res.dur,
          delta: res.delta,
          message: '第 ' + segNo + ' 句已用第 ' + k + ' 遍替换进整段音频（按采样点精确拼接，不是按字幕时间猜）。\n'
            + '总长 ' + res.dur + ' 秒，' + (res.delta >= 0 ? '增加 ' : '减少 ') + Math.abs(res.delta) + ' 秒。\n'
            + '产物：' + patchedMp3 + '\n'
            + '继续替换别的句子时，把 full 指到 ' + outStem + '.wav 上。',
        }
      }

      // 先看看这句在这个音色下以前选过什么，出多版时好知道"上次选的是第几版"
      const picksMod2 = await import('./picks.js')
      const picksPath2 = path.join(outDir, 'picks.json')
      let store2 = picksMod2.emptyPicks()
      try { store2 = picksMod2.loadPicks(JSON.parse(await fsp.readFile(picksPath2, 'utf8'))) } catch { /* 还没有记录 */ }
      const prevPick = picksMod2.findPick(store2, {
        segNo, text: segText, voiceTag: picksMod2.voiceTag(spec),
      })

      const n = Math.min(6, Math.max(1, Number(args?.takes) || 3))
      const expect = audio.expectedPauses(segText)
      const rows = []
      const files = []
      for (let i = 1; i <= n; i++) {
        const stem = 'take-' + segNo + '-' + i
        const r = await call(cfg, 'say', { text: segText, voice: spec.voice, kind: spec.kind, stem, takes: 1, out_dir: outDir })
        const wavPath = path.join(outDir, stem + '.wav')
        const mp3Path = path.join(outDir, stem + '.mp3')
        await toMp3(cfg, wavPath, mp3Path)
        files.push(mp3Path)
        let pauses = []
        try { pauses = audio.findPauses(audio.readWav(wavPath)) } catch { pauses = [] }
        rows.push({ take: i, wav: wavPath, mp3: mp3Path, dur: r.dur, pauses: pauses.length, extra: Math.max(0, pauses.length - expect), detail: pauses })
      }
      const best = rows.slice().sort((a, b) => (a.extra - b.extra) || (a.pauses - b.pauses))[0]
      const table = rows.map((r) => '| ' + r.take + ' | ' + r.dur + 's | ' + r.pauses + '（预期 ' + expect + '） | ' + (r.extra ? '异常 +' + r.extra : '✓') + ' | ' + r.detail.join(' / ') + ' |').join('\n')
      onProduced(exec, files)
      return {
        stage: 'takes',
        files,
        rows,
        message: '第 ' + segNo + ' 句「' + (segText.length > 24 ? segText.slice(0, 24) + '…' : segText) + '」出了 ' + n + ' 遍：\n\n'
          + '| 版本 | 时长 | 内部停顿 | 判定 | 明细(秒) |\n|---|---|---|---|---|\n' + table
          + (prevPick ? '\n\n（这句在这个音色下上次选的是第 ' + prevPick.take + ' 遍，累计 ' + prevPick.total + ' 次）' : '')
          + '\n\n按停顿看推荐第 ' + best.take + ' 遍，但**停顿测不出咬字和语气**——那两个只有你听。'
          + '听完传 use=' + best.take + '（或你选的那版）记录采用。',
      }
    },
  }
}

/* ------------------------------------------------------------------ plugin */

export function apply(root, rawConfig) {
  const cfg = applySavedSettings({ ...DEFAULTS, ...(rawConfig ?? {}) })
  const log = (level, msg) => {
    const l = root.logger ?? root.root?.logger
    if (l && typeof l[level] === 'function') l[level](msg)
    else if (l && typeof l.info === 'function') l.info(msg)
  }
  const here = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname)
  pluginRoot = path.resolve(here, '..')

  root.inject(['tools'], (ctx) => {
    const produced = new WeakMap()
    const onProduced = (exec, files) => { produced.set(exec, files) }
    const tool = makeTool(ctx, cfg, log, onProduced)
    ctx.tools.register(tool)
    ctx.tools.register(makeTimelineTool(ctx, cfg, log, onProduced))
    ctx.tools.register(makeRetakeTool(ctx, cfg, log, onProduced))

    // Read-only status endpoint for the composer indicator. Facts only, localhost
    // is enforced by the web server itself; no paths or model locations leak out.
    try {
      ctx.inject(['webServer'], (webCtx) => {
        const handler = async (_req, res) => {
          try {
            const online = await serviceUp(cfg)
            let health = null
            if (online) {
              try { health = await httpJson('http://127.0.0.1:' + cfg.port + '/health', undefined, 800) } catch { health = null }
            }
            const body = {
              ok: true,
              online,
              loaded: health ? health.loaded : null,
              idleS: health ? health.idle_s : null,
              idleShutdownMs: cfg.idleShutdownMs,
              managed: SERVICE.proc !== null,
              busy: BUSY.describe(),
              serviceBusy: health ? !!health.busy : null,
              busyReq: health ? health.busy_req : null,
              busyS: health ? health.busy_s : null,
              progress: health ? health.progress : null,
              defaultVoice: cfg.defaultVoice || '',
            }
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
            res.end(JSON.stringify(body))
          } catch (error) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, reason: String(error && error.message ? error.message : error) }))
          }
        }
        webCtx.effect(() => {
          const disposers = ['/api/dsh-tts/status.json', '/dsh-tts/status.json']
            .map((routePath) => webCtx.webServer.register({ kind: 'exact', path: routePath, handler }))
          return () => { for (const d of disposers) d() }
        }, 'dsh-tts:status-route')
        // 取消接口：浏览器点"取消"时打到这里，再转给本机服务。
        // 服务端在取 LOCK 之前处理 cancel，所以能立刻生效，不用排队等长任务结束。
        const cancelHandler = async (req, res) => {
          const reply = (code, obj) => {
            res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
            res.end(JSON.stringify(obj))
          }
          if (req && req.method && req.method !== 'POST') return reply(405, { ok: false, error: '只接受 POST' })
          try {
            const r = await httpJson('http://127.0.0.1:' + cfg.port + '/', { req: 'cancel' }, 5000)
            reply(200, { ok: true, serviceBusy: !!r.busy, busyReq: r.busy_req || null })
          } catch (error) {
            reply(200, { ok: false, error: String(error && error.message ? error.message : error) })
          }
        }
        webCtx.effect(() => {
          const disposers = ['/api/dsh-tts/cancel.json', '/dsh-tts/cancel.json']
            .map((routePath) => webCtx.webServer.register({ kind: 'exact', path: routePath, handler: cancelHandler }))
          return () => { for (const d of disposers) d() }
        }, 'dsh-tts:cancel-route')
        // —— 工作台数据接口：产物列表 + 音色库 ——
        // 都是薄转发：真正的扫描/校验在服务端做，这里只负责把浏览器和后端接起来。
        const json = (res, code, obj) => {
          res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(JSON.stringify(obj))
        }
        const readBody = (req) => new Promise((resolve) => {
          let raw = ''
          req.on('data', (c) => { raw += c; if (raw.length > 20000) req.destroy() })
          req.on('end', () => {
            try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) }
          })
        })
        // 面板是"打开就能用"：这两个接口自己负责把服务拉起来。
        // 少了这一步，服务没跑时会直接报 fetch failed——界面看起来像是坏了。
        const withService = async (fn) => {
          try {
            await ensureService(cfg, process.cwd(), log)
            return await fn()
          } catch (error) {
            const msg = String(error && error.message ? error.message : error)
            return { ok: false, error: /fetch failed|ECONNREFUSED|ECONNRESET/iu.test(msg) ? ('配音服务没起来：' + msg) : msg }
          }
        }
        // 独立页面兜底：不依赖 slot 机制，浏览器直接打开就能用。
        // 侧边栏那条路还没经过视觉验收，这个页面至少保证功能可达。
        const STUDIO_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>配音工作台</title>
<style>
  :root { color-scheme: light dark; --fg: #1b1d21; --dim: #6b7280; --line: #d8dbe0; --bg: #fff; --accent: #e67e22; --ok: #27ae60; --err: #c0392b; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e6e7ea; --dim: #9aa4b2; --line: #3a3f47; --bg: #1b1d21; } }
  * { box-sizing: border-box; }
  /* 顶部留白：桌面端是无边框窗口，右上角有最小化/最大化/关闭，别让内容压在下面 */
  body { margin: 0; padding: 44px 16px 16px; font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; background: var(--bg); color: var(--fg); }
  h1 { font-size: 15px; margin: 0 0 4px; font-weight: 600; }
  .sub { color: var(--dim); font-size: 12px; margin-bottom: 12px; }
  .tabs { display: flex; gap: 6px; margin-bottom: 12px; }
  .tab { font: inherit; font-size: 12px; padding: 3px 12px; border-radius: 12px; border: 1px solid var(--line); background: transparent; color: inherit; cursor: pointer; opacity: .55; }
  .tab.on { opacity: 1; border-color: currentColor; }
  .card { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; }
  .row { display: flex; align-items: center; gap: 8px; }
  .grow { flex: 1; }
  .dim { color: var(--dim); font-size: 12px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; background: var(--dim); }
  .dot.on { background: var(--ok); } .dot.busy { background: var(--accent); }
  .bar { height: 6px; border-radius: 3px; background: var(--line); overflow: hidden; margin: 8px 0 4px; }
  .bar > i { display: block; height: 100%; background: var(--accent); width: 0; transition: width .3s; }
  button.act { font: inherit; font-size: 11px; padding: 2px 9px; border-radius: 10px; border: 1px solid var(--line); background: transparent; color: inherit; cursor: pointer; opacity: .85; text-decoration: none; }
  button.act:disabled { opacity: .4; cursor: default; }
  .item { display: flex; flex-direction: column; gap: 3px; padding: 7px 0; border-bottom: 1px solid var(--line); }
  .item:last-child { border-bottom: 0; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .err { color: var(--err); font-size: 12px; white-space: pre-wrap; margin-bottom: 10px; }
  input[type=text] { flex: 1; min-width: 0; font: inherit; font-size: 12px; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: inherit; }
  .empty { color: var(--dim); font-size: 12px; padding: 8px 0; }
</style>
</head>
<body>
<div class="row" style="margin-bottom:8px">
  <h1 style="margin:0">配音工作台</h1>
  <span class="grow"></span>
</div>
<div class="sub" id="sub">正在连接服务…</div>
<div class="tabs">
  <button class="tab on" data-tab="task">任务</button>
  <button class="tab" data-tab="history">历史</button>
  <button class="tab" data-tab="bank">音色库</button>
  <button class="tab" data-tab="config">参数</button>
</div>
<div id="err"></div>
<div id="view"></div>
<script>
(function () {
  var BASE = '/api/dsh-tts/'
  var state = { tab: 'task', status: null, files: [], bank: {}, config: null, saving: false, saveMsg: '', loading: false, error: '', creating: false }
  function el(id) { return document.getElementById(id) }
  function api(name, opt) {
    return fetch(BASE + name, Object.assign({ cache: 'no-store' }, opt || {})).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json()
    })
  }
  function post(name, body) {
    return api(name, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] }) }
  function bytes(n) { return n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB' }
  function ago(ts) {
    var s = Math.max(0, Math.round(Date.now() / 1000 - ts))
    return s < 60 ? s + ' 秒前' : s < 3600 ? Math.round(s / 60) + ' 分钟前' : s < 86400 ? Math.round(s / 3600) + ' 小时前' : Math.round(s / 86400) + ' 天前'
  }
  function fileUrl(p) { return '/api/file?path=' + encodeURIComponent(p) }

  // 页面是嵌在侧边栏 iframe 里的，没有"返回"这回事；
  // 嵌进来时把顶部为桌面窗口预留的留白收窄。
  var EMBEDDED = (function () { try { return window.self !== window.top } catch (e) { return true } })()
  if (EMBEDDED) {
    document.addEventListener('DOMContentLoaded', function () {
      document.body.style.paddingTop = '12px'
    })
  }

  function render() {
    var st = state.status || {}
    el('sub').textContent = st.online ? ('服务就绪' + (st.loaded ? ' · 已载入 ' + st.loaded : ' · 未载入模型')) : '服务待机（不影响浏览历史与音色库）'
    el('err').innerHTML = state.error ? '<div class="err">' + esc(state.error) + '</div>' : ''
    var h = ''
    if (state.tab === 'task') {
      var busy = st.online && st.busyReq
      if (busy) {
        var p = st.progress || {}
        var pct = p.total ? Math.round(p.done / p.total * 100) : 0
        var who = st.busyReq === 'say' ? '正在合成' : st.busyReq === 'preview' ? '正在出候选' : (st.busyReq === 'asr' || st.busyReq === 'asr_subs') ? '正在转写' : st.busyReq === 'align' ? '正在对齐' : '处理中'
        var detail = p.total ? ('第 ' + p.done + ' / ' + p.total + ' 句') : ('已用 ' + Math.round(st.busyS || 0) + ' 秒')
        h += '<div class="card"><div class="row"><i class="dot busy"></i><span>' + esc(who) + '</span><span class="grow"></span><button class="act" id="cancel">取消</button></div>'
          + '<div class="bar"><i style="width:' + pct + '%"></i></div>'
          + '<div class="row"><span class="dim">' + esc(detail) + '</span><span class="grow"></span><span class="dim">' + pct + '%</span></div></div>'
      } else {
        h += '<div class="card"><div class="row"><i class="dot' + (st.online ? ' on' : '') + '"></i><span>' + (st.online ? '空闲' : '服务未启动') + '</span></div>'
          + '<div class="dim" style="margin-top:6px">' + (st.online ? '没有正在进行的任务。' : '查看历史与音色库只读文件，不会启动服务；改名/删除/新建音色时才需要。') + '</div></div>'
      }
      h += '<div class="card"><div class="dim">配音请在对话里让助手调用 voiceover；这里看进度、取消、翻产物和音色库。</div></div>'
    } else if (state.tab === 'config') {
      h += renderConfig()
    } else if (state.tab === 'history') {
      h += '<div class="row" style="margin-bottom:8px"><span class="dim">共 ' + state.files.length + ' 个文件（最近 40 个）</span><span class="grow"></span><button class="act" id="refresh">刷新</button></div>'
      if (state.loading) h += '<div class="empty">读取中…</div>'
      else if (!state.files.length) h += '<div class="empty">还没有产物。</div>'
      else {
        h += '<div class="card">'
        state.files.forEach(function (f) {
          var audio = /\\.(mp3|wav|m4a|flac)$/i.test(f.name)
          h += '<div class="item"><div class="row"><span class="name" title="' + esc(f.rel) + '">' + esc(f.name) + '</span><span class="grow"></span>'
            + (audio ? '<button class="act play" data-p="' + esc(f.path) + '">试听</button>' : '')
            + '<a class="act" href="' + fileUrl(f.path) + '" download="' + esc(f.name) + '">下载</a></div>'
            + '<div class="dim">' + esc((f.dir ? f.dir + ' · ' : '') + bytes(f.bytes) + ' · ' + ago(f.mtime)) + '</div></div>'
        })
        h += '</div>'
      }
    } else if (state.tab === 'bank') {
      var names = Object.keys(state.bank)
      h += '<div class="row" style="margin-bottom:8px"><span class="dim">共 ' + names.length + ' 个音色</span><span class="grow"></span><button class="act" id="refresh">刷新</button></div>'
      h += '<div class="card"><div class="row"><input type="text" id="newvoice" placeholder="一句话描述想要的音色，例如：低沉沙哑的中年男声">'
        + '<button class="act" id="create"' + (state.creating ? ' disabled' : '') + '>' + (state.creating ? '生成中…' : '新建') + '</button></div></div>'
      if (state.loading) h += '<div class="empty">读取中…</div>'
      else if (!names.length) h += '<div class="empty">音色库是空的。</div>'
      else {
        h += '<div class="card">'
        names.forEach(function (n) {
          var e = state.bank[n] || {}
          h += '<div class="item"><div class="row"><span class="name" title="' + esc(n) + '">' + esc(n) + '</span><span class="grow"></span>'
            + (e.sample_mp3 ? '<button class="act play" data-p="' + esc(e.sample_mp3) + '">试听</button>' : '')
            + '<button class="act ren" data-n="' + esc(n) + '">改名</button><button class="act del" data-n="' + esc(n) + '">删除</button></div>'
            + '<div class="dim">' + esc((e.kind || '?') + (e.note ? ' · ' + e.note : '')) + '</div></div>'
        })
        h += '</div>'
      }
    }
    el('view').innerHTML = h
    bind()
  }

  function renderConfig() {
    var cfg = state.config
    if (!cfg) return '<div class="empty">读取中…</div>'
    var h = '<div class="row" style="margin-bottom:8px"><span class="dim">改完点保存；标「需重启」的要重启 DSH 才生效</span><span class="grow"></span><button class="act" id="savecfg"' + (state.saving ? ' disabled' : '') + '>' + (state.saving ? '保存中…' : '保存') + '</button></div>'
    if (state.saveMsg) h += '<div class="err" style="color:var(--ok)">' + esc(state.saveMsg) + '</div>'
    h += '<div class="card">'
    ;(cfg.fields || []).forEach(function (f) {
      var v = cfg.values ? cfg.values[f.key] : ''
      var badge = f.live ? '' : ' <span class="dim" style="border:1px solid var(--line);border-radius:8px;padding:0 5px">需重启</span>'
      h += '<div class="item"><div class="row"><span>' + esc(f.label) + badge + '</span><span class="grow"></span>'
      if (f.kind === 'bool') {
        h += '<input type="checkbox" data-k="' + f.key + '" data-kind="bool"' + (v ? ' checked' : '') + '>'
      } else if (f.kind === 'enum') {
        h += '<select class="act" data-k="' + f.key + '" data-kind="enum">' + f.options.map(function (o) {
          return '<option value="' + esc(o) + '"' + (String(v) === o ? ' selected' : '') + '>' + esc(o) + '</option>'
        }).join('') + '</select>'
      } else if (f.kind === 'json') {
        h += '<input type="text" data-k="' + f.key + '" data-kind="json" value="' + esc(JSON.stringify(v === undefined ? (f.key === 'blurWords' ? [] : {}) : v)) + '" style="max-width:46%">'
      } else if (f.kind === 'int' || f.kind === 'number') {
        h += '<input type="number" class="act" data-k="' + f.key + '" data-kind="' + f.kind + '" value="' + esc(v) + '" step="' + (f.kind === 'number' ? '0.05' : '1') + '" style="max-width:110px">'
      } else {
        h += '<input type="text" data-k="' + f.key + '" data-kind="string" value="' + esc(v == null ? '' : v) + '" style="max-width:46%">'
      }
      h += '</div>' + (f.hint ? '<div class="dim">' + esc(f.hint) + '</div>' : '') + '</div>'
    })
    h += '</div>'
    var ro = cfg.readonly || {}
    h += '<div class="card"><div class="dim" style="margin-bottom:4px">只读（改这些要动 cordis.patch.yml 并重启）</div>'
    ;[['端口', ro.port], ['工作目录', ro.workDir], ['日志', ro.logFile], ['ffmpeg', ro.ffmpeg], ['超时(ms)', ro.timeoutMs]].forEach(function (pair) {
      if (pair[1] === undefined || pair[1] === '') return
      h += '<div class="item"><div class="row"><span class="dim">' + pair[0] + '</span><span class="grow"></span><span class="name" style="max-width:70%" title="' + esc(pair[1]) + '">' + esc(pair[1]) + '</span></div></div>'
    })
    h += '<div class="dim" style="margin-top:6px">模型：' + esc(Object.keys(ro.models || {}).join(', ') || '（未配置）') + '</div>'
    if (cfg.settingsFile) h += '<div class="dim" style="margin-top:4px">覆盖文件：' + esc(cfg.settingsFile) + '</div>'
    h += '</div>'
    return h
  }

  function saveConfig() {
    var values = {}
    var nodes = document.querySelectorAll('[data-k]')
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i]
      var k = n.getAttribute('data-k')
      var kind = n.getAttribute('data-kind')
      if (kind === 'bool') values[k] = !!n.checked
      else if (kind === 'json') {
        try { values[k] = JSON.parse(n.value) } catch (e) { state.error = '「' + k + '」不是合法 JSON'; render(); return }
      } else if (kind === 'int' || kind === 'number') values[k] = Number(n.value)
      else values[k] = n.value
    }
    state.saving = true; state.error = ''; state.saveMsg = ''
    render()
    post('config.json', { values: values }).then(function (j) {
      state.saving = false
      if (!j.ok) { state.error = j.error || '保存失败'; render(); return }
      var parts = []
      if (j.applied && Object.keys(j.applied).length) parts.push('已保存 ' + Object.keys(j.applied).length + ' 项')
      if (j.needRestart && j.needRestart.length) parts.push('需重启：' + j.needRestart.join('、'))
      if (j.rejected && j.rejected.length) parts.push('被拒：' + j.rejected.map(function (r) { return r.key + '（' + r.reason + '）' }).join('；'))
      state.saveMsg = parts.join(' · ') || '没有改动'
      state.config = j
      render()
    }).catch(function (e) {
      state.saving = false; state.error = '保存失败：' + (e && e.message ? e.message : e); render()
    })
  }

  function bind() {
    var sv = el('savecfg')
    if (sv) sv.onclick = saveConfig
    var c = el('cancel')
    if (c) c.onclick = function () { c.disabled = true; c.textContent = '取消中…'; post('cancel.json').catch(function () {}) }
    var r = el('refresh')
    if (r) r.onclick = function () { load() }
    Array.prototype.forEach.call(document.querySelectorAll('.play'), function (b) {
      b.onclick = function () { try { new Audio(fileUrl(b.getAttribute('data-p'))).play() } catch (e) { state.error = '播放失败：' + e.message; render() } }
    })
    Array.prototype.forEach.call(document.querySelectorAll('.ren'), function (b) {
      b.onclick = function () {
        var name = b.getAttribute('data-n')
        var next = window.prompt('把「' + name + '」改成：', name)
        if (!next || next === name) return
        post('bank.json', { op: 'rename', name: name, to: next }).then(function (j) { if (!j.ok) state.error = j.error || '改名失败'; load() })
      }
    })
    Array.prototype.forEach.call(document.querySelectorAll('.del'), function (b) {
      b.onclick = function () {
        var name = b.getAttribute('data-n')
        if (!window.confirm('确定删除「' + name + '」？（只删记录，参考音频不动）')) return
        post('bank.json', { op: 'delete', name: name }).then(function (j) { if (!j.ok) state.error = j.error || '删除失败'; load() })
      }
    })
    var cr = el('create')
    if (cr) cr.onclick = function () {
      var input = el('newvoice')
      var prompt = input && input.value.trim()
      if (!prompt) { state.error = '请先写一句音色描述'; render(); return }
      state.creating = true; state.error = ''; render()
      post('bank.json', { op: 'create', prompt: prompt }).then(function (j) {
        state.creating = false
        if (!j.ok) state.error = j.error || '新建失败'
        load()
      }).catch(function (e) { state.creating = false; state.error = String(e.message || e); render() })
    }
  }

  function load() {
    state.loading = true; state.error = ''; render()
    var job = state.tab === 'history'
      ? api('outputs.json').then(function (j) { if (j.ok === false) state.error = j.error || '读取失败'; else state.files = j.files || [] })
      : state.tab === 'bank'
        ? api('bank.json').then(function (j) { if (j.ok === false) state.error = j.error || '读取失败'; else state.bank = j.entries || {} })
        : state.tab === 'config'
          ? api('config.json').then(function (j) { if (j.ok === false) state.error = j.error || '读取失败'; else state.config = j })
          : Promise.resolve()
    job.catch(function (e) { state.error = '请求失败：' + (e && e.message ? e.message : e) })
      .then(function () { state.loading = false; render() })
  }

  function poll() {
    api('status.json').then(function (j) { state.status = j })
      .catch(function () { state.status = { online: false } })
      .then(function () { render() })
  }

  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
    b.onclick = function () {
      Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (x) { x.classList.remove('on') })
      b.classList.add('on')
      state.tab = b.getAttribute('data-tab')
      state.error = ''
      if (state.tab === 'task') { render() } else { load() }
    }
  })

  // 注意：不要绑 Esc。它在本应用里是全局快捷键，会直接退出 DSH，
  // 而不是触发这里的返回——用顶部左上角那个按钮就行。
  poll()
  setInterval(poll, 2000)
})()
</script>
</body>
</html>`
        const studioPageHandler = async (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(STUDIO_HTML)
        }
        const configHandler = async (req, res) => {
          const snapshot = () => {
            const values = {}
            for (const f of SETTING_FIELDS) values[f.key] = cfg[f.key]
            return {
              ok: true,
              fields: SETTING_FIELDS,
              values,
              readonly: {
                port: cfg.port,
                pythonPath: cfg.pythonPath,
                libs: cfg.libs,
                workDir: cfg.workDir || path.join(process.cwd(), '配音'),
                logFile: cfg.logFile || '',
                ffmpeg: cfg.ffmpeg,
                timeoutMs: cfg.timeoutMs,
                models: cfg.models || {},
              },
              settingsFile: settingsPath(cfg),
            }
          }
          try {
            if (!req || req.method !== 'POST') return json(res, 200, snapshot())
            const body = await readBody(req)
            const incoming = body && body.values && typeof body.values === 'object' ? body.values : {}
            const applied = {}
            const rejected = []
            for (const [key, value] of Object.entries(incoming)) {
              const field = SETTING_FIELDS.find((f) => f.key === key)
              if (!field) { rejected.push({ key, reason: '不认识的参数' }); continue }
              const r = coerceSetting(field, value)
              if (!r.ok) { rejected.push({ key, reason: r.reason }); continue }
              cfg[key] = r.value
              applied[key] = r.value
            }
            if (Object.keys(applied).length) {
              const store = readSettings(cfg)
              Object.assign(store, applied)
              const file = settingsPath(cfg)
              try {
                mkdirSync(path.dirname(file), { recursive: true })
                writeFileSync(file, JSON.stringify(store, null, 2), 'utf8')
              } catch (error) {
                return json(res, 200, { ok: false, error: '写配置文件失败：' + (error && error.message ? error.message : error) })
              }
            }
            const needRestart = Object.keys(applied).filter((key) => {
              const field = SETTING_FIELDS.find((f) => f.key === key)
              return field && !field.live
            })
            return json(res, 200, Object.assign(snapshot(), { applied, rejected, needRestart }))
          } catch (error) {
            json(res, 200, { ok: false, error: String(error && error.message ? error.message : error) })
          }
        }
        const outputsHandler = async (_req, res) => {
          // 只读文件系统：打开面板不应该把 Python 服务拉起来
          try {
            const r = await scanOutputs(cfg, 40)
            json(res, 200, { ok: true, files: r.files, total: r.total, root: r.root })
          } catch (error) {
            json(res, 200, { ok: false, error: String(error && error.message ? error.message : error) })
          }
        }
        const bankHandler = async (req, res) => {
          try {
            if (!req || req.method !== 'POST') {
              // 读取同样只读文件，不拉起服务
              return json(res, 200, { ok: true, entries: await readBankIndex(cfg) })
            }
            // 以下都是写操作/需要模型，才去确保服务在跑
            await ensureService(cfg, process.cwd(), log)
            const body = await readBody(req)
            const op = String(body.op || '')
            if (op === 'rename') {
              const r = await call(cfg, 'bank_rename', { name: body.name, to: body.to })
              return json(res, 200, { ok: true, entry: r.entry })
            }
            if (op === 'delete') {
              const r = await call(cfg, 'bank_delete', { name: body.name })
              return json(res, 200, { ok: true, deleted: r.deleted })
            }
            if (op === 'create') {
              // 界面上"新建音色"= 用一段描述造一个：跟工具里的 preview 走同一条路，
              // 生成的样音直接入库，界面上立刻能试听。
              const prompt = String(body.prompt || '').trim()
              if (!prompt) return json(res, 400, { ok: false, error: '请先写一句音色描述' })
              const stem = 'voice-' + Date.now()
              const res2 = await call(cfg, 'preview', {
                text: '这是一段用来试听的样音，听听这个声音合不合用。',
                stem,
                items: [{ kind: 'design', voice: { instruct: prompt }, label: prompt.slice(0, 14) }],
              })
              const cand = (res2.candidates || [])[0]
              if (!cand) return json(res, 200, { ok: false, error: '没有生成出候选（检查 models.design 是否配置）' })
              const mp3 = String(cand.wav).replace(/\.wav$/u, '.mp3')
              try { await toMp3(cfg, cand.wav, mp3) } catch { /* 转码失败就不挂样音 */ }
              const added = await call(cfg, 'bank_add', {
                entry: {
                  name: slug(prompt) + '-' + new Date().toISOString().slice(11, 16).replace(':', ''),
                  kind: cand.kind || 'design',
                  voice: cand.voice,
                  sample_mp3: mp3,
                  note: 'UI 新建',
                },
              })
              return json(res, 200, { ok: true, entry: added.entry })
            }
            return json(res, 400, { ok: false, error: '不支持的操作：' + op })
          } catch (error) { json(res, 200, { ok: false, error: String(error && error.message ? error.message : error) }) }
        }
        webCtx.effect(() => {
          const disposers = [
            ...['/api/dsh-tts/studio', '/dsh-tts/studio'].map((p) => webCtx.webServer.register({ kind: 'exact', path: p, handler: studioPageHandler })),
            ...['/api/dsh-tts/config.json', '/dsh-tts/config.json'].map((p) => webCtx.webServer.register({ kind: 'exact', path: p, handler: configHandler })),
            ...[].concat(['/api/dsh-tts/outputs.json', '/dsh-tts/outputs.json'].map((p) => webCtx.webServer.register({ kind: 'exact', path: p, handler: outputsHandler }))),
            ...[].concat(['/api/dsh-tts/bank.json', '/dsh-tts/bank.json'].map((p) => webCtx.webServer.register({ kind: 'exact', path: p, handler: bankHandler }))),
          ]
          return () => { for (const d of disposers) d() }
        }, 'dsh-tts:studio-routes')
        log('info', '已注册状态端点 /api/dsh-tts/status.json 与取消端点 /api/dsh-tts/cancel.json')
      })
    } catch (error) {
      log('warn', '注册状态端点失败（不影响配音）：' + (error && error.message ? error.message : error))
    }
    log('info', 'dsh-tts 已注册工具 voiceover（service port=' + cfg.port + '，workDir=' + (cfg.workDir || '<session>/配音') + '）')
  })
}