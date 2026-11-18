/**
 * Word/RTF 文本抽取的单元测试。运行：node scripts/test_docx.mjs
 * 用 Node 自带 zlib 现场造一个最小 docx，不依赖任何第三方包。
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateRawSync } from 'node:zlib'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const D = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'docx.js')).href)

let fail = 0
const ok = (c, label, extra) => {
  if (c) console.log('  ok   ' + label)
  else { fail += 1; console.log('  FAIL ' + label + (extra === undefined ? '' : ' -> ' + String(JSON.stringify(extra)).slice(0, 200))) }
}

/** 造一个只含 word/document.xml 的最小 zip。 */
function makeZip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8')
    const raw = Buffer.from(content, 'utf8')
    const comp = deflateRawSync(raw)
    const crc = 0 // 解析端不校验 CRC
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBuf, comp)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(comp.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + comp.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

const DOCX_XML = '<?xml version="1.0"?><w:document><w:body>'
  + '<w:p><w:r><w:t>第一段：牛奶科普。</w:t></w:r></w:p>'
  + '<w:p><w:r><w:t>第二段 有 &amp; 符号</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>换行之后</w:t></w:r></w:p>'
  + '</w:body></w:document>'

console.log('[1] docx 抽取')
const buf = makeZip({ 'word/document.xml': DOCX_XML, '[Content_Types].xml': '<Types/>' })
const r1 = D.extractText(buf)
ok(r1.kind === 'docx', '识别为 docx', r1.kind)
ok(r1.text.indexOf('第一段：牛奶科普。') === 0, '第一段正确', r1.text.slice(0, 20))
ok(r1.text.indexOf('第二段 有 & 符号') > 0, '实体已解码', r1.text)
ok(/\n换行之后/.test(r1.text), 'br 变换行', JSON.stringify(r1.text))

console.log('[2] docxXmlToText 细节')
ok(D.docxXmlToText('<w:p><w:r><w:t>A</w:t></w:r></w:p><w:p><w:r><w:t>B</w:t></w:r></w:p>') === 'A\nB', '段落之间换行')
ok(D.docxXmlToText('<w:p><w:r><w:t>A</w:t><w:tab/><w:t>X</w:t></w:r></w:p>') === 'A\tX', 'tab 保留')

console.log('[3] RTF')
// 真实的中文 RTF 是这样存的：\\ansicpg936 + \\'hh 的 GBK 字节
const hex = (s) => s.split('').map((c) => {
  const b = new TextEncoder().encode(c) // 这里用 GBK 编码更真实，但测试环境用手写字节
  return b
}).length >= 0 ? '' : ''
const gbkOf = (s) => Buffer.from(new TextEncoder().encode(s)).length ? s : s
const zh = '你好'
const zhBytes = [0xc4, 0xe3, 0xba, 0xc3] // 「你好」的 GBK
const second = [0xb5, 0xda, 0xb6, 0xfe, 0xb6, 0xce] // 「第二段」的 GBK（第二段）
const rtfEsc = (bytes) => bytes.map((b) => "\\'" + b.toString(16).padStart(2, '0')).join('')
const rtf = '{\\rtf1\\ansi\\ansicpg936\\deff0{\\fonttbl{\\f0 SimSun;}}\\f0\\fs24 '
  + rtfEsc(zhBytes) + '\\par ' + rtfEsc(second) + '\\par}'
const r2 = D.extractText(Buffer.from(rtf, 'latin1'))
ok(r2.kind === 'rtf', '识别为 rtf', r2.kind)
ok(r2.text.indexOf('你好') >= 0 && r2.text.indexOf('第二段') > 0, '文本抽出来了', r2.text)
ok(r2.text.indexOf('fonttbl') < 0, '控制字去掉了', r2.text)

console.log('[3b] 没有内层大括号的 RTF（回归）')
const plain = '{\\rtf1\\ansi\\ansicpg936\\f0 ' + "\\'c4\\'e3\\'ba\\'c3" + '\\par}'
const r2b = D.extractText(Buffer.from(plain, 'latin1'))
ok(r2b.kind === 'rtf', '识别为 rtf', r2b.kind)
ok(r2b.text === '你好', '整段没被误删', JSON.stringify(r2b.text))

console.log('[4] 纯文本')
const r3 = D.extractText(Buffer.from('\uFEFF第一行\n第二行', 'utf8'))
ok(r3.kind === 'text' && r3.text === '第一行\n第二行', 'BOM 去掉了', r3.text)

console.log('[5] 错误路径')
let e1 = ''
try { D.extractText(makeZip({ 'x.txt': 'hi' })) } catch (e) { e1 = String(e.message) }
ok(/不是 docx/.test(e1), 'zip 但不是 docx 时报错', e1)
let e2 = ''
try { D.extractText(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00])) } catch (e) { e2 = String(e.message) }
ok(/另存为/.test(e2), '老 .doc 提示另存为', e2)
let e3 = ''
try { D.extractText(Buffer.alloc(0)) } catch (e) { e3 = String(e.message) }
ok(/空文件/.test(e3), '空文件报错', e3)

console.log('')
console.log(fail === 0 ? '全部通过' : fail + ' 项失败')
process.exit(fail === 0 ? 0 : 1)
