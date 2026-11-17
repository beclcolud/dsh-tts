/**
 * External script parser.
 *
 * Format per paragraph:  <number>[S|V]/<text>
 *   01/大家好            normal segment
 *   02S/这段只出字幕       subtitle only (no audio)
 *   03V/这段只配音         voice only (no subtitle)
 * Lines that do not start with a number continue the previous paragraph, so a
 * long paragraph can be wrapped however the writer likes.
 */

const HEAD = /^\s*(\d+)\s*([SVsv]?)\s*[\/／|｜:：]\s*(.*)$/u

export function parseScript(text) {
  const segments = []
  let current = null
  const blank = []
  for (const rawLine of String(text).replace(/\r\n?/gu, '\n').split('\n')) {
    const line = rawLine.trimEnd()
    const m = HEAD.exec(line)
    if (m) {
      if (current) segments.push(current)
      current = {
        key: m[1],
        id: String(Number.parseInt(m[1], 10)).padStart(2, '0'),
        mode: (m[2] || '').toUpperCase(), // '' | 'S' | 'V'
        lines: m[3].trim() === '' ? [] : [m[3].trim()],
      }
      continue
    }
    if (line.trim() === '') { blank.push(true); continue }
    if (current) current.lines.push(line.trim())
    else segments.push({ preamble: line.trim() })
  }
  if (current) segments.push(current)

  const warns = []
  const cleaned = segments.filter((s) => {
    if (s.preamble !== undefined) { warns.push('文案开头有未编号内容，已忽略：' + s.preamble.slice(0, 30)); return false }
    return true
  })
  const seen = new Map()
  for (const s of cleaned) {
    s.text = s.lines.join('').replace(/\s+/gu, '')
    if (seen.has(s.id)) warns.push('编号重复：' + s.id + '（后出现的会被单独处理，请确认）')
    seen.set(s.id, true)
  }
  return { segments: cleaned, warnings: warns }
}

export function estimateSeconds(text, charsPerSecond) {
  const chars = String(text || '').replace(/\s+/gu, '').length
  return chars / Math.max(0.1, charsPerSecond)
}
