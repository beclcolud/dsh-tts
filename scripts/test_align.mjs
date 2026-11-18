/**
 * 强制对齐字幕重排的单元测试（纯逻辑，不需要模型、GPU 或服务）。
 * 运行：node scripts/test_align.mjs
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const S = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'synth.js')).href)

let fail = 0
const ok = (c, label, extra) => {
  if (c) console.log('  ok   ' + label)
  else { fail += 1; console.log('  FAIL ' + label + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra))) }
}

// 造一串字级时间：每字 120ms，标点处多留 100ms
function buildChars(text, msPerChar = 120) {
  const out = []
  let t = 0
  for (const ch of text) {
    out.push({ text: ch, start: t, end: t + msPerChar })
    t += msPerChar
    if ('。！？；，、：'.includes(ch)) t += 100
  }
  return out
}

console.log('[1] 标点处断行')
const t1 = '清早的菜市场是最热闹的地方。摊主一边摆菜，一边招呼。'
const c1 = S.groupAlignedCues(buildChars(t1), { maxChars: 40 })
ok(c1.length >= 3, '至少断成 3 条（两个句号 + 一个逗号）', c1.map((c) => c.text))
ok(c1.every((c) => c.text.length > 0), '没有空字幕')
ok(c1.join('').length === t1.length || c1.map((c) => c.text).join('') === t1, '拼回等于原文', c1.map((c) => c.text).join(''))

console.log('[2] 超过 maxChars 强制断行')
const t2 = '一二三四五六七八九十一二三四五六七八九十'
const c2 = S.groupAlignedCues(buildChars(t2), { maxChars: 6 })
ok(c2.every((c) => c.text.length <= 7), '每条不超过 maxChars+1', c2.map((c) => c.text.length))
ok(c2.map((c) => c.text).join('') === t2, '不丢字')

console.log('[3] 长停顿处断行')
const items3 = [
  { text: '甲', start: 0, end: 120 },
  { text: '乙', start: 130, end: 250 },
  { text: '丙', start: 900, end: 1020 },   // 与上一条隔 650ms
  { text: '丁', start: 1030, end: 1150 },
]
const c3 = S.groupAlignedCues(items3, { maxChars: 40, maxGapMs: 350 })
ok(c3.length === 2, '在长停顿处断开', c3.map((c) => c.text))
ok(c3[0].text === '甲乙' && c3[1].text === '丙丁', '内容分对', c3.map((c) => c.text))

console.log('[4] 时间单调、且以秒为单位')
const c4 = S.groupAlignedCues(buildChars('第一句话。第二句话。'), { maxChars: 40 })
ok(c4.every((c, i) => i === 0 || c.start >= c4[i - 1].start), '起始时间不减')
ok(c4.every((c) => c.end > c.start), '每条 end > start')
// 10 个字，每字 120ms，句号后再空 100ms：最后一个字结束在第 1180ms，即 1.3s
// （末尾那次 100ms 停顿没有对应字符，不会计入任何一条字幕）
ok(Math.abs(c4[c4.length - 1].end - 1.30) < 0.05, '总时长量级正确（秒，不是毫秒）', c4[c4.length - 1].end)

console.log('[5] 脏数据要被跳过而不是崩')
const mixed = [
  { text: '甲', start: 0, end: 100 },
  { text: '', start: 100, end: 200 },
  { text: '乙', start: 'x', end: 300 },
  null,
  { text: '丙', start: 400, end: 500 },
]
const c5 = S.groupAlignedCues(mixed, { maxChars: 40 })
ok(c5.map((c) => c.text).join('') === '甲丙', '只保留有效项', c5.map((c) => c.text))

console.log('')
console.log(fail === 0 ? '全部通过' : fail + ' 项失败')
process.exit(fail === 0 ? 0 : 1)
