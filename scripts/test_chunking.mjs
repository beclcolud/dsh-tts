/**
 * GPU-free, ffmpeg-free regression test for staging long scripts.
 * Targets lib/synth.js directly: the request helpers are fakes, so this runs in
 * a second anywhere. Run: node scripts/test_chunking.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const S = await import(pathToFileURL(path.join(ROOT, 'lib', 'synth.js')).href)
const WORK = mkdtempSync(path.join(os.tmpdir(), 'dsh-tts-synth-'))
mkdirSync(WORK, { recursive: true })

let failures = 0
const ok = (cond, label, extra) => {
  if (cond) console.log('  ok   ' + label)
  else { failures += 1; console.log('  FAIL ' + label + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra))) }
}

const PART_SEC = 0.5
function wavBytes(seconds, { sr = 24000, channels = 1, value = 0x0010 } = {}) {
  const frames = Math.round(seconds * sr)
  const block = channels * 2
  const data = Buffer.alloc(frames * block)
  for (let i = 0; i < data.length; i += 2) data.writeInt16LE(value, i)
  const buf = Buffer.alloc(44 + data.length)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + data.length, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(channels, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * block, 28)
  buf.writeUInt16LE(block, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(data.length, 40)
  data.copy(buf, 44)
  return buf
}
const stamp = (sec) => String(Math.floor(sec / 3600)).padStart(2, '0') + ':' +
  String(Math.floor((sec % 3600) / 60)).padStart(2, '0') + ':' +
  String(Math.floor(sec % 60)).padStart(2, '0') + ',' +
  String(Math.round((sec % 1) * 1000)).padStart(3, '0')

// A fake service: writes a real 16-bit mono wav + its srt, counts the calls.
let calls = []
const fakeSay = (text, stem) => {
  calls.push({ text, stem })
  const wav = path.join(WORK, stem + '.wav')
  const srt = path.join(WORK, stem + '.srt')
  writeFileSync(wav, wavBytes(PART_SEC))
  writeFileSync(srt, '1\n' + stamp(0) + ' --> ' + stamp(PART_SEC - 0.1) + '\n' + String(text).slice(0, 6) + '\n')
  return { wav, srt, dur: PART_SEC }
}

console.log('[1] 切分：无标点超长句也要硬切')
const noPunct = '配音测试'.repeat(175) // 700 字，一个标点都没有
const c1 = S.splitForRequest(noPunct, 300)
ok(c1.length === 3, '切成 3 段', c1.length)
ok(c1.map((t) => t.length).join(',') === '300,300,100', '切点 300/300/100', c1.map((t) => t.length))
ok(c1.join('') === noPunct, '拼回后一字不差')
const punct = '这是一句测试文案。'.repeat(40) // 360 字，每句 9 字
const c2 = S.splitForRequest(punct, 300)
ok(c2.length === 2 && c2.every((t) => t.endsWith('。')), '有标点时只按句号切', c2.map((t) => t.length))
ok(S.splitForRequest('短句。', 300).length === 1, '短文本不切')

console.log('[2] WAV 直拼：字节级，不失真')
const a = path.join(WORK, 'j-a.wav'); const b = path.join(WORK, 'j-b.wav'); const j = path.join(WORK, 'j.wav')
writeFileSync(a, wavBytes(1)); writeFileSync(b, wavBytes(0.5))
const info = S.concatPcm16([a, b], j)
ok(Math.abs(info.seconds - 1.5) < 1e-6, '时长 1.5s', info.seconds)
const raw = readFileSync(j)
ok(raw.readUInt32LE(40) === readFileSync(a).readUInt32LE(40) + readFileSync(b).readUInt32LE(40), 'data 长度等于两段之和')
ok(raw.readUInt32LE(24) === 24000 && raw.readUInt16LE(22) === 1, '保留原采样率与声道')
writeFileSync(path.join(WORK, 'stereo.wav'), wavBytes(0.5, { channels: 2 }))
writeFileSync(path.join(WORK, 'sr48.wav'), wavBytes(0.5, { sr: 48000 }))
const reject = (files) => {
  try { S.concatPcm16(files, path.join(WORK, 'nope.wav')); return false } catch { return true }
}
ok(reject([a, path.join(WORK, 'stereo.wav')]), '声道数不同时抛错（交给 ffmpeg 回退）')
ok(reject([a, path.join(WORK, 'sr48.wav')]), '采样率不同时抛错')
ok(reject([a, path.join(WORK, 'missing.wav')]), '分片缺失时抛错')

console.log('[3] 长文案分批 + 字幕按累计时长偏移')
mkdirSync(path.join(WORK, 't3'), { recursive: true })
calls = []
const r3 = await S.synthChunks({
  text: noPunct, stem: 'c3', outDir: path.join(WORK, 't3'), say: fakeSay,
})
ok(calls.length === 3, '发了 3 次合成', calls.length)
ok(r3.chunks === 3 && r3.reused === 0, 'chunks=3 reused=0', r3)
const cues = S.parseSrt(readFileSync(r3.srt, 'utf8'))
ok(cues.length === 3, '字幕 3 条', cues.length)
ok(Math.abs(cues[0].start - 0) < 1e-6 && Math.abs(cues[1].start - 0.5) < 1e-6 && Math.abs(cues[2].start - 1.0) < 1e-6,
  '起始时间 0 / 0.5 / 1.0', cues.map((c) => c.start))
ok(Math.abs(r3.dur - 1.5) < 1e-6, '总时长 1.5s', r3.dur)
ok(statSync(r3.wav).size > 44, '输出 wav 非空')

console.log('[4] 中断后续跑：已完成的分片不再请求')
calls = []
const r4 = await S.synthChunks({
  text: noPunct, stem: 'c3', outDir: path.join(WORK, 't3'), say: fakeSay,
})
ok(calls.length === 0, '0 次合成', calls.length)
ok(r4.reused === 3, '复用 3 批', r4.reused)
ok(S.parseSrt(readFileSync(r4.srt, 'utf8')).length === 3, '字幕依然 3 条')

console.log('[5] 改一个字 -> 只重做受影响的那一批')
calls = []
await S.synthChunks({
  text: noPunct.slice(0, -1) + '音', stem: 'c3', outDir: path.join(WORK, 't3'), say: fakeSay,
})
ok(calls.length === 1 && calls[0].stem === 'c3-p3', '只重做第 3 批', calls.map((c) => c.stem))

console.log('[6] 多角色 timeline：按累计字数分批，一段不丢')
mkdirSync(path.join(WORK, 't6'), { recursive: true })
const tlCalls = []
const fakeTimeline = (items, stem) => {
  tlCalls.push({ items, stem })
  const wav = path.join(WORK, 't6', stem + '.wav')
  const srt = path.join(WORK, 't6', stem + '.srt')
  writeFileSync(wav, wavBytes(PART_SEC))
  writeFileSync(srt, items.map((it, i) =>
    (i + 1) + '\n' + stamp(i * 0.1) + ' --> ' + stamp(i * 0.1 + 0.09) + '\n' + String(it.text).slice(0, 5)).join('\n\n') + '\n')
  return { wav, srt, dur: PART_SEC }
}
// 8 字一句 x 8 + 序号 = 65 字/段，5 段共 325 字，必然越过 300 字的批次上限
const items = Array.from({ length: 5 }, (_, i) => ({ voice: 'Serena', text: '第五段测试台词。'.repeat(8) + i }))
ok(items.reduce((n, it) => n + it.text.length, 0) > 300, 'fixture 总字数超过批次上限', items[0].text.length)
const r6 = await S.synthTimeline({ items, stem: 'tl6', outDir: path.join(WORK, 't6'), timeline: fakeTimeline })
ok(tlCalls.length === 2, 'timeline 拆成 2 个请求', tlCalls.map((c) => c.items.length))
ok(tlCalls.reduce((n, c) => n + c.items.length, 0) === 5, '5 段全部发出')
const cues6 = S.parseSrt(readFileSync(r6.srt, 'utf8'))
ok(cues6.length === 5, '字幕 5 条', cues6.length)
ok(cues6[cues6.length - 1].start >= 0.5, '第二批字幕已整体偏移', cues6.map((c) => c.start))

console.log('[7] 命名：默认 stem 用文案哈希，可直接续跑')
ok(/^[0-9a-f]{8}$/u.test(S.shortHash('任意文案')), '哈希是 8 位十六进制')
ok(S.shortHash('abc') !== S.shortHash('abd'), '不同文本哈希不同')

console.log('')
console.log(failures === 0 ? '全部通过' : failures + ' 项失败')
process.exit(failures === 0 ? 0 : 1)
