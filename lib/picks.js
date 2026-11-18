/**
 * 逐句选版记录（picks.json）。
 *
 * 旧格式只拿句子序号当键：改了文案，旧选择会落到别的句子上；换音色重录，
 * 同一句的不同音色互相覆盖；没有任何历史，选错了只能靠记。
 *
 * 新格式（version 2）：
 *   { version: 2, entries: { "<句序>@<文本hash>@<音色标签>": {
 *       seg, text, textHash, voiceTag, picks: [ {take, file, at} ], current } } }
 * 同一句、同一音色再次选版只是往 picks 里追一条，不覆盖历史。
 *
 * 读旧文件时自动迁移，旧条目 textHash 按当时的文本重算、voiceTag 标成 unknown。
 */
import { createHash } from 'node:crypto'

export const PICKS_VERSION = 2
export const MAX_HISTORY = 10

export function textHash(text) {
  return createHash('sha1').update(String(text || '').replace(/\s+/gu, '')).digest('hex').slice(0, 8)
}

/**
 * 音色的稳定标签：只取决定"声音是谁"的那个字段，不掺显示名。
 * 预设看 speaker，克隆看参考音频文件名，描述造音色看 instruct。
 */
export function voiceTag(spec) {
  const kind = String((spec && spec.kind) || 'custom')
  const v = (spec && spec.voice) || {}
  let id = ''
  if (v.speaker) id = 'speaker:' + v.speaker
  else if (v.ref_audio) id = 'ref:' + String(v.ref_audio).split(/[\\/]/u).pop()
  else if (v.instruct) id = 'instruct:' + String(v.instruct).slice(0, 40)
  else id = 'unknown'
  return kind + '|' + id
}

export function pickKey(segNo, text, tag) {
  return Number(segNo) + '@' + textHash(text) + '@' + String(tag || 'unknown')
}

export function emptyPicks() {
  return { version: PICKS_VERSION, entries: {} }
}

/** 读任意版本的 picks 文件，统一成 version 2 结构。 */
export function loadPicks(raw) {
  if (!raw || typeof raw !== 'object') return emptyPicks()
  if (raw.version === PICKS_VERSION && raw.entries && typeof raw.entries === 'object') {
    return { version: PICKS_VERSION, entries: { ...raw.entries } }
  }
  // 旧格式：{ "3": { take, file, at, text } } —— 尽力迁移，并标出来源
  const store = emptyPicks()
  for (const [k, val] of Object.entries(raw)) {
    if (!val || typeof val !== 'object') continue
    const seg = Number.parseInt(k, 10)
    if (!Number.isInteger(seg)) continue
    const text = String(val.text || '')
    const key = pickKey(seg, text, 'unknown')
    store.entries[key] = {
      seg,
      text,
      textHash: textHash(text),
      voiceTag: 'unknown',
      migratedFrom: 'v1',
      picks: [{ take: Number(val.take) || 0, file: String(val.file || ''), at: String(val.at || '') }],
      current: 0,
    }
  }
  return store
}

/** 记一次选版。同一句同一音色追加历史，并把 current 指到最新一条。 */
export function recordPick(store, opts) {
  const seg = Number(opts.segNo)
  const text = String(opts.text || '')
  const tag = String(opts.voiceTag || 'unknown')
  const key = pickKey(seg, text, tag)
  const next = { version: PICKS_VERSION, entries: { ...(store && store.entries ? store.entries : {}) } }
  const prev = next.entries[key]
  const history = prev && Array.isArray(prev.picks) ? prev.picks.slice() : []
  history.push({
    take: Number(opts.take) || 0,
    file: String(opts.file || ''),
    at: String(opts.at || new Date().toISOString()),
  })
  while (history.length > MAX_HISTORY) history.shift()
  next.entries[key] = {
    seg,
    text,
    textHash: textHash(text),
    voiceTag: tag,
    picks: history,
    current: history.length - 1,
  }
  return { store: next, key, entry: next.entries[key] }
}

/** 查这一句在这个音色下选的最后一版（没有就 null）。 */
export function findPick(store, opts) {
  if (!store || !store.entries) return null
  const key = pickKey(opts.segNo, opts.text, opts.voiceTag)
  const e = store.entries[key]
  if (!e || !Array.isArray(e.picks) || e.picks.length === 0) return null
  const idx = Number.isInteger(e.current) && e.current >= 0 && e.current < e.picks.length ? e.current : e.picks.length - 1
  return { ...e.picks[idx], key, index: idx, total: e.picks.length }
}
