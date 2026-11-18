/**
 * Staged synthesis for long scripts.
 *
 * The local service sits behind a gateway that drops the connection around five
 * minutes (undici HeadersTimeoutError), so one 900-character paragraph can never
 * be a single request. Text is cut at sentence boundaries, each piece is
 * requested on its own, and the audio is stitched back with every subtitle cue
 * shifted by the running total.
 *
 * Parts are cached next to the output: a run that dies half way reuses whatever
 * already finished instead of paying for that GPU work twice.
 *
 * No HTTP, config or logging framework lives here — the caller injects the two
 * request helpers, which keeps this module testable without a GPU or ffmpeg.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import path from 'node:path'

export const MAX_CHARS = 300

/**
 * Cut a script into request-sized pieces. Sentence boundaries first, then a
 * character-level hard cut for any single sentence longer than the budget —
 * without it a 600-character run with no 。 is unstoppable.
 */
export function splitForRequest(text, maxChars = MAX_CHARS, language = 'zh') {
  // 英文句子以「标点 + 空白」结束，中文/日文以标点直接结束。
  // 英文这里**不能**把空白当分隔符吃掉：这些片段会被拼回一个请求，
  // 吞掉空格会得到 "Good morning.This is..."，服务端就再也切不开句子了。
  // 用零宽切分（切在空白之前），片段自带尾随空格。
  const re = language === 'en' ? /(?<=[.!?])\s+/u : /(?<=[。！？!?；;])/u
  let sents = String(text).split(re).filter((x) => x.trim() !== '')
  if (language === 'en') {
    // 把被 split 吃掉的空格补回来（英文句子之间必须有空格）
    sents = sents.map((x, i) => (i === sents.length - 1 ? x : (x.endsWith(' ') ? x : x + ' ')))
  }
  const out = []
  let cur = ''
  for (const sen of sents) {
    if (cur !== '' && cur.length + sen.length > maxChars) { out.push(cur); cur = sen }
    else cur += sen
  }
  if (cur !== '') out.push(cur)

  const hard = []
  for (const piece of out) {
    if (piece.length <= maxChars) { hard.push(piece); continue }
    let rest = piece
    while (rest.length > maxChars) {
      const win = rest.slice(0, maxChars)
      const cut = Math.max(win.lastIndexOf('，'), win.lastIndexOf('、'), win.lastIndexOf('：'), win.lastIndexOf(' '))
      const at = cut > maxChars * 0.5 ? cut + 1 : maxChars
      hard.push(rest.slice(0, at))
      rest = rest.slice(at)
    }
    if (rest !== '') hard.push(rest)
  }
  return hard.length > 0 ? hard : [String(text)]
}

/** Stable short hash, used to notice that a part was synthesized from other text. */
export function shortHash(s) {
  let h = 0x811c9dc5
  const str = String(s)
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/* ------------------------------------------------------------------- srt ---- */

export function srtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000))
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const r = ms % 1000
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + ',' + String(r).padStart(3, '0')
}

export function buildSrt(cues) {
  return cues.map((c, i) => (i + 1) + '\n' + srtTime(c.start) + ' --> ' + srtTime(c.end) + '\n' + c.text + '\n').join('\n')
}

export function parseSrt(text) {
  const out = []
  const toSec = (t) => {
    const m = /(\d+):(\d+):(\d+)[,.](\d+)/u.exec(t)
    if (!m) return 0
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000
  }
  for (const block of String(text).replace(/\r\n?/gu, '\n').split('\n\n')) {
    const lines = block.split('\n')
    if (lines.length < 3) continue
    const times = /([\d:,.]+\s*-->\s*[\d:,.]+)/u.exec(lines[1])
    if (!times) continue
    const [a, b] = times[1].split('-->').map((s) => s.trim())
    out.push({ start: toSec(a), end: toSec(b), text: lines.slice(2).join('\n').trim() })
  }
  return out
}

const PUNCT = /^[\s，。！？；：、,.!?;:…—－\-_（）()《》【】「」『』“”‘’"']$/u

/**
 * 把对齐结果和原文重新绑到一起。
 *
 * 强制对齐只吐**念出来的字**，标点不在里面（实测 30 字原文只回 27 项）。
 * 但断行要靠标点，所以这里按顺序把原文走一遍：遇到标点就补一个零时长的项目，
 * 遇到发音字就取下一条对齐结果。补出来的标点时间贴在前一个字结尾，
 * 这样后面按标点断行、按时间排布都成立。
 */
export function bindAlignedText(items, text) {
  const list = (items || []).filter((it) => it && String(it.text == null ? '' : it.text) !== '')
  const out = []
  let k = 0
  let cursor = 0
  let left = 0            // 当前对齐项还剩几个字要覆盖（英文词一项可能覆盖多个字）
  let spanStart = 0
  let spanEnd = 0
  for (const ch of String(text)) {
    if (PUNCT.test(ch)) {
      out.push({ text: ch, start: cursor, end: cursor })
      continue
    }
    if (left === 0) {
      const it = list[k]
      if (!it) break
      // 约定：本函数输入输出都用**毫秒**，由 groupAlignedCues 统一换算成秒。
      const start = Number(it.start)
      const end = Number(it.end)
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
        k += 1
        continue
      }
      spanStart = start
      spanEnd = end
      left = Math.max(1, Array.from(String(it.text)).length)
      k += 1
    }
    // 每个原文字符都产出一项，**索引与原文严格对应**——
    // 服务端给的 breaks（token 结束位置）是原文字符偏移，靠这个对齐。
    out.push({ text: ch, start: spanStart, end: spanEnd })
    cursor = spanEnd
    left -= 1
  }
  return out
}

/**
 * 把强制对齐给出的字级时间重排成字幕条。
 *
 * 断行规则按优先级：遇到句末/句中标点就断（语义完整），否则攒够 maxChars 断，
 * 或者下一字与当前结尾隔了超过 maxGapMs（那里本来就有停顿）。
 * items 的 start/end 是毫秒，返回值是秒。
 */
export function groupAlignedCues(items, opts = {}) {
  const maxChars = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : 16
  const maxGapMs = Number(opts.maxGapMs) > 0 ? Number(opts.maxGapMs) : 350
  const hardSlack = Number(opts.hardSlack) > 0 ? Number(opts.hardSlack) : 6
  // 按停顿断行时要求当前这条已经有足够内容，否则会切出"国"这种一个字的字幕
  const minChars = Number(opts.minChars) > 0 ? Number(opts.minChars) : 2
  const breakable = opts.breakable instanceof Set ? opts.breakable
    : (Array.isArray(opts.breakable) ? new Set(opts.breakable) : null)
  const canBreak = (i) => breakable === null || breakable.has(i)
  const list = items || []
  const cues = []
  let cur = null
  for (let idx = 0; idx < list.length; idx += 1) {
    const it = list[idx]
    const t = String(it && it.text != null ? it.text : '')
    if (t === '') continue
    const start = Number(it.start) / 1000
    const end = Number(it.end) / 1000
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue
    if (cur === null) {
      cur = { start, end, text: t }
      continue
    }
    // 标点永远跟在前一句后面，绝不单独起一条。
    // （不然断点正好落在标点前时，会出现一条只有"，"、时长为 0 的字幕。）
    if (PUNCT.test(t)) {
      cur.text += t
      cur.end = Math.max(cur.end, end)
      continue
    }
    const gapMs = (start - cur.end) * 1000
    const atPunct = /[。！？；，、：]$/u.test(cur.text)
    const meaningful = cur.text.replace(/[。！？；，、：\s]/gu, '').length >= minChars
    const wouldExceed = (cur.text + t).length > maxChars
    // 按长度断行时只落在"允许断点"上（模型 tokenizer 的 token 边界），
    // 避免把"地方""市场"这种词切成两半；实在找不到合适断点才硬切。
    const tooLong = wouldExceed && (canBreak(idx) || (cur.text + t).length > maxChars + hardSlack)
    if ((gapMs > maxGapMs && meaningful) || tooLong || atPunct) {
      cues.push(cur)
      cur = { start, end, text: t }
    } else {
      cur.text += t
      cur.end = Math.max(cur.end, end)
    }
  }
  if (cur !== null) cues.push(cur)
  return cues.map((c) => ({ start: Number(c.start.toFixed(3)), end: Number(c.end.toFixed(3)), text: c.text }))
}

/* ------------------------------------------------------------------ wav ---- */

/** Split a RIFF/WAVE file into its format block and raw data bytes. */
function readRiff(file) {
  const buf = readFileSync(file)
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 WAV 文件：' + file)
  }
  let pos = 12
  let fmt = null
  let data = null
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    const body = pos + 8
    if (id === 'fmt ') {
      fmt = {
        codec: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(body + size, buf.length))
    }
    pos = body + size + (size % 2)
  }
  if (!fmt || !data) throw new Error('WAV 缺少 fmt/data 块：' + file)
  return { fmt, data }
}

/**
 * Join parts at the byte level. Every part comes from our own service, which
 * writes 16-bit mono PCM, so this is exact (no resampling, no 1-LSB drift) and
 * avoids handing Windows paths to an ffmpeg concat list.
 * Throws when the parts disagree, so the caller can fall back to ffmpeg.
 */
export function concatPcm16(files, out) {
  const parts = files.map((f) => readRiff(f))
  const first = parts[0].fmt
  for (const p of parts) {
    const f = p.fmt
    if (f.codec !== 1 || f.bits !== 16 || f.channels !== first.channels || f.sampleRate !== first.sampleRate) {
      throw new Error('分片格式不一致，需要交给 ffmpeg：' + JSON.stringify(f))
    }
  }
  const block = first.channels * 2
  const frames = Math.floor(parts.reduce((n, p) => n + p.data.length, 0) / block)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + frames * block, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(first.channels, 22)
  header.writeUInt32LE(first.sampleRate, 24)
  header.writeUInt32LE(first.sampleRate * block, 28)
  header.writeUInt16LE(block, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(frames * block, 40)
  writeFileSync(out, Buffer.concat([header, ...parts.map((p) => p.data)]))
  return { seconds: frames / first.sampleRate, sampleRate: first.sampleRate }
}

/* --------------------------------------------------------------- staging ---- */

/**
 * A sidecar is written only *after* a part came back, so its presence proves the
 * wav+srt pair is complete and was made from this exact text.
 */
async function partReusable(metaPath, textHash) {
  try {
    const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'))
    if (meta.textHash !== textHash) return null
    if (!existsSync(meta.wav) || !existsSync(meta.srt)) return null
    return meta
  } catch { return null }
}

async function safeRemove(file) {
  try { await fsp.rm(file, { force: true }) } catch { /* ignore */ }
}

/**
 * Request every part (or reuse the cached one), then stitch audio + cues.
 * opts: { parts, stem, outDir, log?, send, concat? }
 *   parts  [{ key, ...payload }]  key identifies the text, payload is the caller's
 *   send   (part, partStem) => { wav, srt, dur }
 *   concat (files, out) => void   defaults to concatPcm16
 */
export async function synthStaged(opts) {
  const { parts, stem, outDir, log, send, concat = concatPcm16 } = opts
  const collected = []
  const cues = []
  // 分片各自的句子边界（采样点）要合并成一份，否则长文案无法做句子级重录拼回
  const mergedSentences = []
  let boundsSr = 0
  let offset = 0
  let reused = 0
  for (let i = 0; i < parts.length; i += 1) {
    const partStem = stem + '-p' + (i + 1)
    const metaPath = path.join(outDir, partStem + '.json')
    let rec = await partReusable(metaPath, shortHash(parts[i].key))
    if (rec) {
      reused += 1
      if (log) log('info', '复用已完成批次 ' + partStem + '（' + rec.dur + 's）')
    } else {
      await safeRemove(metaPath)
      const r = await send(parts[i], partStem)
      rec = { textHash: shortHash(parts[i].key), wav: r.wav, srt: r.srt, dur: Number(r.dur) || 0 }
      await fsp.writeFile(metaPath, JSON.stringify(rec, null, 2), 'utf8')
    }
    collected.push(rec.wav)
    // 读这一片的 bounds，把句子的采样点平移到整段音频的时间轴上
    try {
      const partBoundsPath = path.join(outDir, partStem + '.bounds.json')
      if (existsSync(partBoundsPath)) {
        const pb = JSON.parse(await fsp.readFile(partBoundsPath, 'utf8'))
        const sr = Number(pb.sr) || 0
        const partOffsetSamples = Math.round(offset * (sr || 1))
        if (sr) boundsSr = sr
        for (const s of (pb.sentences || [])) {
          mergedSentences.push({
            i: mergedSentences.length + 1,
            text: String(s.text || ''),
            start: partOffsetSamples + Number(s.start || 0),
            end: partOffsetSamples + Number(s.end || 0),
          })
        }
      }
    } catch { /* 某片没有边界文件就少这一段，不影响音频 */ }
    if (rec.srt && existsSync(rec.srt)) {
      for (const cue of parseSrt(await fsp.readFile(rec.srt, 'utf8'))) {
        cues.push({ start: offset + cue.start, end: offset + cue.end, text: cue.text })
      }
    }
    offset += rec.dur
  }
  const wav = path.join(outDir, stem + '.wav')
  await concat(collected, wav)
  const srt = path.join(outDir, stem + '.srt')
  await fsp.writeFile(srt, buildSrt(cues), 'utf8')
  if (mergedSentences.length > 0 && boundsSr > 0) {
    const boundsPath = path.join(outDir, stem + '.bounds.json')
    const totalSamples = mergedSentences[mergedSentences.length - 1].end
    await fsp.writeFile(boundsPath, JSON.stringify({
      sr: boundsSr, total: totalSamples, sentences: mergedSentences,
    }, null, 2), 'utf8')
  }
  // 注意：分片（<stem>-pN.*）**不能**在成功后删掉。
  // 它们连同 -pN.json 是"续跑"的依据——同一标题重跑时能复用已完成的批次。
  // 界面上不该看到它们，所以过滤放在产物扫描那边（scanOutputs），而不是这里删文件。
  return { wav, srt, dur: Number(offset.toFixed(2)), chunks: parts.length, reused }
}

/**
 * One text -> one or more requests.
 * opts: { text, stem, outDir, log?, maxChars?, say, concat? }
 */
export async function synthChunks(opts) {
  const { text, stem, outDir, log, maxChars = MAX_CHARS, say, concat, language = 'zh' } = opts
  const chunks = splitForRequest(text, maxChars, language)
  if (chunks.length === 1) {
    const r = await say(chunks[0], stem)
    return { wav: r.wav, srt: r.srt, dur: r.dur, chunks: 1, reused: 0 }
  }
  if (log) log('info', '长文案分 ' + chunks.length + ' 批合成（每批 ≤' + maxChars + ' 字）')
  return await synthStaged({
    parts: chunks.map((t) => ({ key: t, text: t })),
    stem, outDir, log, concat,
    send: (part, partStem) => say(part.text, partStem),
  })
}

/**
 * Same idea for the multi-voice timeline array, batched by cumulative characters.
 * opts: { items, stem, outDir, log?, maxChars?, timeline, concat? }
 */
export async function synthTimeline(opts) {
  const { items, stem, outDir, log, maxChars = MAX_CHARS, timeline, concat } = opts
  const batches = []
  let cur = []
  let chars = 0
  for (const it of items) {
    const n = String(it.text || '').length
    if (cur.length > 0 && chars + n > maxChars) { batches.push(cur); cur = []; chars = 0 }
    cur.push(it)
    chars += n
  }
  if (cur.length > 0) batches.push(cur)
  if (batches.length === 1) {
    const r = await timeline(items, stem)
    return { wav: r.wav, srt: r.srt, dur: r.dur, chunks: 1, reused: 0 }
  }
  if (log) log('info', '多角色时间轴分 ' + batches.length + ' 批合成')
  return await synthStaged({
    parts: batches.map((b) => ({ key: JSON.stringify(b), items: b })),
    stem, outDir, log, concat,
    send: (part, partStem) => timeline(part.items, partStem),
  })
}
