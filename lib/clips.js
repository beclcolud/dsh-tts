/** Read clip media paths + time mapping from an xmeml sequence. */
import { findAll, find, textOf } from './xml.js'

export function decodeFileUrl(url) {
  const raw = String(url).replace(/^file:\/\/(localhost)?\//iu, '')
  const bytes = []
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '%' && /^[0-9A-Fa-f]{2}$/u.test(raw.slice(i + 1, i + 3))) { bytes.push(parseInt(raw.slice(i + 1, i + 3), 16)); i += 2 }
    else bytes.push(raw.charCodeAt(i))
  }
  return Buffer.from(bytes).toString('utf8')
}

export function readClips(xmlDoc) {
  const seq = findAll(xmlDoc, 'sequence')[0]
  const fps = Number(textOf(seq, 'timebase', '25')) || 25
  const fileMap = new Map()
  for (const f of findAll(xmlDoc, 'file')) {
    const id = f.attrs && f.attrs.id
    const pu = find(f, 'pathurl')
    if (id && pu) fileMap.set(id, decodeFileUrl(pu.text.trim()))
  }
  const items = []
  for (const track of findAll(seq, 'track')) {
    for (const c of findAll(track, 'clipitem')) {
      const pu = find(c, 'pathurl')
      let file = pu ? decodeFileUrl(pu.text.trim()) : ''
      if (!file) {
        const ref = find(c, 'file')
        if (ref && ref.attrs && ref.attrs.id && fileMap.has(ref.attrs.id)) file = fileMap.get(ref.attrs.id)
      }
      if (!file) continue
      items.push({
        name: textOf(c, 'name', ''),
        path: file,
        startF: Number(textOf(c, 'start', '0')),
        endF: Number(textOf(c, 'end', '0')),
        inF: Number(textOf(c, 'in', '0')),
      })
    }
  }
  return { fps, items }
}

/** Unique media slices needed to cover [startSec, endSec), in timeline order. */
export function slicesForRange(clips, startSec, endSec) {
  const { fps, items } = clips
  const s0 = Math.round(startSec * fps); const e0 = Math.round(endSec * fps)
  const candidates = items
    .filter((it) => it.endF > s0 && it.startF < e0)
    .map((it) => ({ it, from: Math.max(it.startF, s0), to: Math.min(it.endF, e0) }))
    .sort((a, b) => a.from - b.from)

  // The same media sits on several tracks, so ranges overlap. Walk the timeline
  // and only keep the part of each clip that is not covered yet - otherwise the
  // audio gets duplicated and the transcript repeats itself.
  const out = []
  let covered = s0
  for (const { it, from, to } of candidates) {
    if (to <= covered) continue
    const start = Math.max(from, covered)
    if (start >= e0) break
    out.push({
      path: it.path,
      srcStartSec: (it.inF + (start - it.startF)) / fps,
      durSec: (to - start) / fps,
      atSec: (start - s0) / fps,
    })
    covered = to
  }
  return out
}