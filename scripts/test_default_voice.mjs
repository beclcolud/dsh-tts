/**
 * 默认音色解析的单元测试：起一个假服务顶替 /bank_list，不碰 GPU、不碰模型。
 *
 * 盯住的回归：voice 留空时用 defaultVoice，而 defaultVoice 可能指向音色库条目
 * （克隆音色）。早期实现直接从这儿造 custom/speaker、跳过库查询，服务端就报
 * "Unsupported speakers: ['新闻联播音色']"，于是**所有不传 voice 的调用全挂**。
 *
 * 运行：node scripts/test_default_voice.mjs
 */
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const M = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'index.js')).href)

let fail = 0
const ok = (c, label, extra) => {
  if (c) console.log('  ok   ' + label)
  else { fail += 1; console.log('  FAIL ' + label + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra))) }
}

const BANK = {
  '新闻联播音色': { name: '新闻联播音色', kind: 'base', voice: { ref_audio: 'E:/ref/ref-1.wav', ref_text: '参考文本', blur: false } },
  'Serena-1115': { name: 'Serena-1115', kind: 'custom', voice: { speaker: 'Serena' } },
}

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += String(d) })
  req.on('end', () => {
    let j = {}
    try { j = JSON.parse(body) } catch { /* 非法请求体按空处理 */ }
    const out = j.req === 'bank_list' ? { ok: true, entries: BANK } : { ok: true }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(out))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const log = () => {}

const look = (defaultVoice, voice) =>
  M.resolveVoice({ port, timeoutMs: 5000, workDir: '', defaultVoice }, HERE, log, voice)

console.log('[1] defaultVoice 是音色库条目（克隆音色）时，留空也要命中库')
{
  const s = await look('新闻联播音色', '')
  ok(s.kind === 'base', 'kind = base', s.kind)
  ok(s.fromBank === true, 'fromBank = true', s.fromBank)
  ok(String(s.voice.ref_audio).endsWith('ref-1.wav'), '带上参考音频', s.voice.ref_audio)
  ok(String(s.label).includes('默认'), '标签标明是默认音色', s.label)
  ok(!String(s.label).includes('（音色库）（音色库）'), '标签不重复', s.label)
}

console.log('[2] defaultVoice 是预设名时，行为不变')
{
  const s = await look('Serena', '')
  ok(s.kind === 'custom', 'kind = custom', s.kind)
  ok(s.voice.speaker === 'Serena', 'speaker = Serena', s.voice.speaker)
  ok(String(s.label).includes('默认'), '标签标明是默认音色', s.label)
}

console.log('[3] 库里的 custom 条目也能当默认')
{
  const s = await look('Serena-1115', '')
  ok(s.fromBank === true, 'fromBank = true', s.fromBank)
  ok(s.voice.speaker === 'Serena', 'speaker = Serena', s.voice.speaker)
}

console.log('[4] defaultVoice 为空时退回 Dylan')
{
  const s = await look('', '')
  ok(s.voice.speaker === 'Dylan', 'speaker = Dylan', s.voice.speaker)
}

console.log('[5] 显式传库名照旧命中（原行为不回归）')
{
  const s = await look('', '新闻联播音色')
  ok(s.fromBank === true, 'fromBank = true', s.fromBank)
  ok(!String(s.label).includes('默认'), '显式传的不标默认', s.label)
}

console.log('[6] 显式传预设名照旧')
{
  const s = await look('新闻联播音色', 'Eric')
  ok(s.kind === 'custom' && s.voice.speaker === 'Eric', 'preset Eric', s.voice.speaker)
}

console.log('[7] 既不是预设、也不在库、又不是文件：落回描述型')
{
  const s = await look('', '低沉沙哑的中年男声')
  ok(s.kind === 'design', 'kind = design', s.kind)
  ok(s.voice.instruct === '低沉沙哑的中年男声', 'instruction 原样传', s.voice.instruct)
}

server.close()
console.log('')
console.log(fail === 0 ? '全部通过' : fail + ' 项失败')
process.exit(fail === 0 ? 0 : 1)
