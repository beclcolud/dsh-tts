/**
 * 时间轴输入格式与时码相关的回归测试（纯解析，不需要模型）。
 * 运行：node scripts/test_timeline_formats.mjs
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const T = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'timeline.js')).href)
const P = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'plan.js')).href)

let fail = 0
const ok = (c, label, extra) => {
  if (c) console.log('  ok   ' + label)
  else { fail += 1; console.log('  FAIL ' + label + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra))) }
}
const throws = (fn) => { try { fn(); return '' } catch (e) { return String(e.message) } }

function xmeml(opts = {}) {
  const tb = opts.timebase || 25
  const tc = opts.timecode
    ? '<timecode><rate><timebase>' + tb + '</timebase></rate><frame>' + opts.timecode.frame
      + '</frame><string>' + (opts.timecode.string || '') + '</string></timecode>'
    : ''
  const markers = (opts.markers || [])
    .map((m) => '<marker><name>' + m[0] + '</name><in>' + m[1] + '</in><out>' + m[2] + '</out></marker>')
    .join('')
  return '<?xml version="1.0" encoding="UTF-8"?>\n<xmeml version="5"><sequence id="s1">'
    + '<name>测试序列</name><duration>' + (opts.duration || 1200) + '</duration>'
    + '<timebase>' + tb + '</timebase>' + tc + markers
    + '</sequence></xmeml>'
}

console.log('[1] 非目标格式给出能照做的报错')
const fcp = throws(() => T.readTimeline('<?xml version="1.0"?><fcpxml version="1.9"><resources/></fcpxml>'))
ok(fcp.includes('FCPXML'), '识别出 FCPXML', fcp.slice(0, 60))
ok(fcp.includes('FCP 7 XML'), '给出了该导出什么', fcp.slice(0, 90))

const edl = throws(() => T.readTimeline('TITLE: 测试\nFCM: NON-DROP FRAME\n001  001      V     C        00:00:00:00 00:00:05:00\n'))
ok(edl.includes('EDL'), '识别出 EDL', edl.slice(0, 60))

const plain = throws(() => T.readTimeline('这只是普通文本，不是 XML'))
ok(plain.includes('不是 XML'), '普通文本单独提示', plain.slice(0, 60))

const empty = throws(() => T.readTimeline('<xmeml version="5"><nothing/></xmeml>'))
ok(empty.includes('xmeml'), '空 xmeml 提示找不到序列', empty.slice(0, 80))

console.log('[2] 读取序列起始时码')
const withTc = T.readTimeline(xmeml({ timecode: { frame: 86400, string: '01:00:00:00' }, markers: [['01', 0, 250]] }))
const seq = withTc.sequences[0]
ok(seq.startFrame === 86400, '读到起始帧', seq.startFrame)
ok(seq.startTcString === '01:00:00:00', '读到时码字符串', seq.startTcString)
ok(Math.abs(seq.startSec - 3456) < 0.001, '换算成秒', seq.startSec)

console.log('[3] 时码非 0 时 plan 会提示偏移风险')
const plan1 = P.buildPlan(seq, '01/测试文案。', { mode: 'both' })
ok(plan1.issues.some((s) => s.includes('起始时码')), '有起始时码提示', plan1.issues)
ok(plan1.issues.some((s) => s.includes('偏移')), '说明会整体偏移', plan1.issues)

console.log('[4] 标记超出序列时长会提示')
const seq2 = T.readTimeline(xmeml({ duration: 500, markers: [['01', 0, 250], ['02', 400, 900]] })).sequences[0]
const plan2 = P.buildPlan(seq2, '01/第一段。\n02/第二段。', { mode: 'both' })
ok(plan2.issues.some((s) => s.includes('超出序列时长')), '有超界提示', plan2.issues)

console.log('[5] 标记后缀与文案后缀冲突会提示')
const seq3 = T.readTimeline(xmeml({ markers: [['03v', 0, 250]] })).sequences[0]
const plan3 = P.buildPlan(seq3, '03/这段文案没写后缀。', { mode: 'both' })
ok(plan3.issues.some((s) => s.includes('后缀')), '有后缀冲突提示', plan3.issues)
ok(plan3.rows[0].mode === 'both', '仍然以文案为准（没后缀=全局模式）', plan3.rows[0].mode)

const plan4 = P.buildPlan(seq3, '03V/只配音。', { mode: 'both' })
ok(!plan4.issues.some((s) => s.includes('后缀')), '标记与文案模式一致时不误报', plan4.issues)

console.log('[6] 正常情况不误报')
const seq5 = T.readTimeline(xmeml({ markers: [['01', 0, 250], ['02', 300, 600]] })).sequences[0]
const plan5 = P.buildPlan(seq5, '01/第一段。\n02/第二段。', { mode: 'both' })
ok(plan5.issues.length === 0, '没有多余告警', plan5.issues)
ok(plan5.rows.length === 2, '两段都在', plan5.rows.length)

console.log('')
console.log(fail === 0 ? '全部通过' : fail + ' 项失败')
process.exit(fail === 0 ? 0 : 1)
