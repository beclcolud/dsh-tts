/**
 * FCP7 XML (xmeml) timeline reader.
 *
 * Only what this feature needs: sequences, their frame rate, and the RANGE
 * markers sitting on the sequence. Point markers (in/out = -1) are reported but
 * flagged, because a point marker cannot tell us how long a segment should be.
 */
import { parseXml, find, findAll, textOf, numberOf } from './xml.js'

export function readTimeline(xmlText) {
  const doc = parseXml(xmlText)
  // xmeml puts one <sequence> directly under <xmeml>; some exporters wrap them in
  // <sequences>. Accept both instead of insisting on one layout.
  const seqNodes = findAll(doc, 'sequence')
  if (seqNodes.length === 0) throw new Error('这不是 FCP XML：找不到 <sequence>')

  const sequences = seqNodes
    .map((seq, index) => {
      const timebase = numberOf(seq, 'timebase', 25) || 25
      const durationFrames = numberOf(seq, 'duration', 0)
      const markers = findAll(seq, 'marker').map((m) => {
        const inF = numberOf(m, 'in', -1)
        const outF = numberOf(m, 'out', -1)
        const range = inF >= 0 && outF > inF
        return {
          name: textOf(m, 'name', ''),
          comment: textOf(m, 'comment', ''),
          inFrame: inF,
          outFrame: outF,
          isRange: range,
          startSec: inF >= 0 ? inF / timebase : null,
          endSec: range ? outF / timebase : null,
        }
      })
      return {
        index,
        name: textOf(seq, 'name', 'sequence-' + (index + 1)),
        timebase,
        durationSec: durationFrames > 0 ? durationFrames / timebase : null,
        markers,
      }
    })

  if (sequences.length === 0) throw new Error('XML 里没有任何序列')
  return { sequences }
}

/** Pick a sequence by 1-based index; throws with the full list when ambiguous. */
export function pickSequence(timeline, wanted) {
  const { sequences } = timeline
  if (sequences.length === 1) return sequences[0]
  const n = Number.parseInt(String(wanted ?? ''), 10)
  if (Number.isInteger(n) && n >= 1 && n <= sequences.length) return sequences[n - 1]
  const list = sequences.map((s, i) => i + 1 + '. ' + s.name + '（' + (s.durationSec ?? '?') + 's，' + s.markers.length + ' 个标记）').join('\n')
  throw new Error('这个 XML 有 ' + sequences.length + ' 个序列，请指定用哪个：\n' + list)
}
