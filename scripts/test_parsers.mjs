import { readFileSync } from 'node:fs'
import { readTimeline, pickSequence } from '../lib/timeline.js'
import { parseScript, estimateSeconds } from '../lib/script.js'

const seq = pickSequence(readTimeline(readFileSync(new URL('./fixtures/sample.fcpxml', import.meta.url), 'utf8')), 1)
console.log('序列:', seq.name, '| fps', seq.timebase, '| 时长', seq.durationSec + 's', '| 标记', seq.markers.length)
for (const m of seq.markers) {
  const head = '  ' + m.name.padEnd(4)
  console.log(head, m.isRange ? (m.startSec + 's -> ' + m.endSec + 's (' + (m.endSec - m.startSec).toFixed(2) + 's)') : ('点标记 @' + m.startSec + 's'))
}
const parsed = parseScript(readFileSync(new URL('./fixtures/sample.txt', import.meta.url), 'utf8'))
console.log('文案段数:', parsed.segments.length, '| 警告:', parsed.warnings.length)
for (const s of parsed.segments) {
  console.log('  ' + s.id + (s.mode || '-') + ' ' + s.text.length + '字 预计 ' + estimateSeconds(s.text, 4.5).toFixed(2) + 's  ' + s.text.slice(0, 20))
}