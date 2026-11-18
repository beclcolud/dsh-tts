/**
 * FCP7 XML (xmeml) timeline reader.
 *
 * Only what this feature needs: sequences, their frame rate, and the RANGE
 * markers sitting on the sequence. Point markers (in/out = -1) are reported but
 * flagged, because a point marker cannot tell us how long a segment should be.
 */
import { parseXml, find, findAll, textOf, numberOf } from './xml.js'

/** 常见非目标格式的特征，用来给一句能直接照做的报错。 */
function describeForeignFormat(xmlText) {
  const head = String(xmlText || '').slice(0, 4000)
  if (/<fcpxml[\s>]/iu.test(head)) {
    return '这是 FCPXML（Final Cut Pro X / 达芬奇的现代格式），本工具只认 PR 导出的 FCP 7 XML。'
      + '在 PR 里用「文件 → 导出 → Final Cut Pro XML」；达芬奇用「文件 → 导出 → 时间线 → FCP 7 XML」。'
  }
  if (/^\s*TITLE:/imu.test(head) || /^FCM:/imu.test(head)) {
    return '这是 EDL，本工具不支持。请导出 FCP 7 XML（xmeml）。'
  }
  if (!/<[A-Za-z]/u.test(head)) {
    return '这个文件看起来不是 XML（没有标签）。请确认路径没选错。'
  }
  return ''
}

export function readTimeline(xmlText) {
  const doc = parseXml(xmlText)
  // xmeml puts one <sequence> directly under <xmeml>; some exporters wrap them in
  // <sequences>. Accept both instead of insisting on one layout.
  const seqNodes = findAll(doc, 'sequence')
  if (seqNodes.length === 0) {
    const hint = describeForeignFormat(xmlText)
    throw new Error(hint || '这不是 PR 的 FCP XML（xmeml）：找不到 <sequence> 节点。')
  }

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
      // 序列起始时码。xmeml 里标记的 in/out 是序列相对帧，但有些工具导出的
      // 数值按时码起点写；读出来至少能提示"如果你按时码填的，结果会整体偏移"。
      const tcNode = find(seq, 'timecode')
      const startFrame = tcNode ? numberOf(tcNode, 'frame', 0) : 0
      const startTcString = tcNode ? textOf(tcNode, 'string', '') : ''
      return {
        index,
        name: textOf(seq, 'name', 'sequence-' + (index + 1)),
        timebase,
        durationSec: durationFrames > 0 ? durationFrames / timebase : null,
        startFrame,
        startTcString,
        startSec: startFrame > 0 ? startFrame / timebase : 0,
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
