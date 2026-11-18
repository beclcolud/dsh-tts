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
import { promises as fsp, existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bindAlignedText, buildSrt, concatPcm16, groupAlignedCues, parseSrt, shortHash, synthChunks, splitForRequest, synthTimeline } from './synth.js'

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
}

const SERVICE = { proc: null, startedAt: 0, lastError: '' }

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
    SERVICE.proc.on('exit', (code) => { SERVICE.proc = null; log('info', '配音服务退出 code=' + code) })
    SERVICE.proc.on('error', (err) => { SERVICE.proc = null; SERVICE.lastError = String(err && err.message) })
  }
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    if (await serviceUp(cfg)) { SERVICE.startedAt = Date.now(); return }
    await new Promise((r) => setTimeout(r, 1200))
  }
  throw new Error('配音服务启动超时（90s）。' + (SERVICE.lastError ? ' 原因：' + SERVICE.lastError : '') +
    ' 需要本机有可用的 CUDA 与已安装的 qwen-tts 依赖。')
}

function call(cfg, req, body) {
  return httpJson('http://127.0.0.1:' + cfg.port + '/', { req, ...body }, cfg.timeoutMs)
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
    const body = parts.map((p) => "file '" + p.split(String.fromCharCode(92)).join('/') + "'")
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
        + '省略则用 Serena。',
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
      '按 PR 时间轴配音：读取 PR 导出的 FCP XML，取序列上的范围标记（名称如 01、02），与外侧文案的编号一一对应，逐段配音并生成整片对齐的字幕。'
      + '两阶段：stage=plan 先出预检表（每段预计时长 vs 标记范围，标出超出/偏短并给修改建议），不耗时；确认后 stage=run 才真正合成。'
      + '支持三种交付：both（配音+字幕，默认）、voice（仅配音）、subtitle（仅字幕）；文案里写 02S/ 表示该段只出字幕，03V/ 表示只配音。'
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
      const cwd = exec?.agent?.session?.cwd || process.cwd()
      const timeline = await import('./timeline.js')
      const planMod = await import('./plan.js')
      const abs = (f) => (path.isAbsolute(String(f)) ? String(f) : path.join(cwd, String(f)))
      const xmlPath = abs(args.xmlFile)
      const scriptPath = abs(args.scriptFile)
      const seq = timeline.pickSequence(timeline.readTimeline(await fsp.readFile(xmlPath, 'utf8')), args.sequence)
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
          + '（配音 ' + s.voice + ' / 仅字幕 ' + s.subtitleOnly + '）· 预计配音总长 ' + s.estimatedVoiceSeconds + 's'
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
              ...(Number.isFinite(Number(args?.toneTameDb)) ? { tone_tame_db: Number(args.toneTameDb) } : {}),
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
            await fsp.writeFile(listFile, partWavs.map((x) => "file '" + x.split(String.fromCharCode(92)).join('/') + "'").join(String.fromCharCode(10)), 'utf8')
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
        const picksPath = path.join(outDir, 'picks.json')
        let picks = {}
        try { picks = JSON.parse(await fsp.readFile(picksPath, 'utf8')) } catch { picks = {} }
        picks[segNo] = { take: k, file: path.basename(chosen), at: new Date().toISOString(), text: segText }
        await fsp.writeFile(picksPath, JSON.stringify(picks, null, 2), 'utf8')
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
          + '\n\n按停顿看推荐第 ' + best.take + ' 遍，但**停顿测不出咬字和语气**——那两个只有你听。'
          + '听完传 use=' + best.take + '（或你选的那版）记录采用。',
      }
    },
  }
}

/* ------------------------------------------------------------------ plugin */

export function apply(root, rawConfig) {
  const cfg = { ...DEFAULTS, ...(rawConfig ?? {}) }
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
        log('info', '已注册状态端点 /api/dsh-tts/status.json')
      })
    } catch (error) {
      log('warn', '注册状态端点失败（不影响配音）：' + (error && error.message ? error.message : error))
    }
    log('info', 'dsh-tts 已注册工具 voiceover（service port=' + cfg.port + '，workDir=' + (cfg.workDir || '<session>/配音') + '）')
  })
}