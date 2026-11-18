/**
 * picks.json 存储的单元测试（纯逻辑，不需要服务或模型）。
 * 运行：node scripts/test_picks.mjs
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const P = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'picks.js')).href)

let fail = 0
const ok = (c, label, extra) => {
  if (c) console.log('  ok   ' + label)
  else { fail += 1; console.log('  FAIL ' + label + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra))) }
}

console.log('[1] 文本 hash 稳定、忽略空白')
ok(P.textHash('第一句。') === P.textHash('第一句。'), '同一文本 hash 相同')
ok(P.textHash('第一句。') === P.textHash(' 第一 句。 '), '忽略空白后相同')
ok(P.textHash('第一句。') !== P.textHash('第一句！'), '改一个标点就不同')

console.log('[2] 音色标签区分音色与类型')
const a = P.voiceTag({ kind: 'base', voice: { ref_audio: 'E:/x/ref-1.wav' } })
const b = P.voiceTag({ kind: 'base', voice: { ref_audio: 'E:/y/ref-2.wav' } })
const c = P.voiceTag({ kind: 'custom', voice: { speaker: 'Serena' } })
ok(a !== b, '不同参考音频不同标签', [a, b])
ok(a !== c, '不同 kind 不同标签', [a, c])
ok(a === P.voiceTag({ kind: 'base', voice: { ref_audio: 'D:/z/ref-1.wav' } }), '同一文件名不同目录视为同音色', a)

console.log('[3] 旧格式自动迁移')
const v1 = { '3': { take: 2, file: 'chosen-3.wav', at: '2026-11-15T10:00:00Z', text: '旧句子的内容。' } }
const migrated = P.loadPicks(v1)
ok(migrated.version === 2, '升到 version 2', migrated.version)
const mk = Object.keys(migrated.entries)[0]
ok(mk.startsWith('3@'), '键以句序开头', mk)
ok(migrated.entries[mk].picks[0].take === 2, '保留了 take')
ok(migrated.entries[mk].migratedFrom === 'v1', '标了来源')
ok(migrated.entries[mk].voiceTag === 'unknown', '音色未知', migrated.entries[mk].voiceTag)

console.log('[4] 同一句反复选版会累积历史')
let store = P.emptyPicks()
for (let i = 1; i <= 3; i += 1) {
  const r = P.recordPick(store, { segNo: 2, text: '同一句话。', voiceTag: 'custom|speaker:Serena', take: i, file: 'chosen-2.wav' })
  store = r.store
}
const key = P.pickKey(2, '同一句话。', 'custom|speaker:Serena')
ok(store.entries[key].picks.length === 3, '三条历史', store.entries[key].picks.length)
ok(store.entries[key].current === 2, 'current 指向最新', store.entries[key].current)
ok(P.findPick(store, { segNo: 2, text: '同一句话。', voiceTag: 'custom|speaker:Serena' }).take === 3, '查到最后一版')

console.log('[5] 关键性质：改文案 / 换音色都不会串')
ok(P.findPick(store, { segNo: 2, text: '改过的句子。', voiceTag: 'custom|speaker:Serena' }) === null, '文案改了 → 旧选择查不到', null)
ok(P.findPick(store, { segNo: 2, text: '同一句话。', voiceTag: 'base|ref:ref-1.wav' }) === null, '换音色 → 旧选择查不到', null)
ok(P.findPick(store, { segNo: 3, text: '同一句话。', voiceTag: 'custom|speaker:Serena' }) === null, '换句序 → 查不到', null)

console.log('[6] 历史有上限，不会无限膨胀')
let s2 = P.emptyPicks()
for (let i = 1; i <= P.MAX_HISTORY + 5; i += 1) {
  s2 = P.recordPick(s2, { segNo: 1, text: '长历史。', voiceTag: 't', take: i, file: 'f.wav' }).store
}
const k2 = P.pickKey(1, '长历史。', 't')
ok(s2.entries[k2].picks.length === P.MAX_HISTORY, '截断到上限 ' + P.MAX_HISTORY, s2.entries[k2].picks.length)
ok(P.findPick(s2, { segNo: 1, text: '长历史。', voiceTag: 't' }).take === P.MAX_HISTORY + 5, '保留的是最新的', P.findPick(s2, { segNo: 1, text: '长历史。', voiceTag: 't' }).take)

console.log('[7] JSON 往返不丢信息')
const round = P.loadPicks(JSON.parse(JSON.stringify(s2)))
ok(JSON.stringify(round) === JSON.stringify(s2), '往返一致')

console.log('')
console.log(fail === 0 ? '全部通过' : fail + ' 项失败')
process.exit(fail === 0 ? 0 : 1)
