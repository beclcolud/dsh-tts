/**
 * 从 Word 文档里抽纯文本。
 *
 * .docx 就是一个 zip，正文在 word/document.xml 里，用 Node 自带的 zlib 解就够了，
 * 不需要 python-docx 或第三方包。
 *
 * .doc（Word 97 二进制）没法可靠解析，这里只做两件事：
 *   - 如果它其实是 zip（很多"另存为 doc"的其实是 docx），按 docx 处理
 *   - 如果是 RTF（也能存成 .doc），粗略去控制符
 * 真正老的二进制 .doc 会明确报错，让用户另存为 .docx 或 .txt。
 */
import { inflateRawSync } from 'node:zlib'

function findEocd(buf) {
  const min = Math.max(0, buf.length - 66000)
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  return -1
}

export function listZipEntries(buf) {
  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('这不是 zip（找不到目录结尾）')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const entries = []
  for (let i = 0; i < count; i += 1) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) throw new Error('zip 目录损坏')
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen)
    entries.push({ name, method, compSize, localOff })
    off += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

export function readZipEntry(buf, entry) {
  const lo = entry.localOff
  if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('zip 条目损坏')
  const nameLen = buf.readUInt16LE(lo + 26)
  const extraLen = buf.readUInt16LE(lo + 28)
  const start = lo + 30 + nameLen + extraLen
  const data = buf.subarray(start, start + entry.compSize)
  if (entry.method === 0) return Buffer.from(data)
  if (entry.method === 8) return inflateRawSync(data)
  throw new Error('不支持的压缩方式：' + entry.method)
}

function decodeXml(s) {
  return s
    .replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'").replace(/&#(\d+);/gu, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/gu, '&')
}

/** word/document.xml → 纯文本：段落换行，<w:br> 换行，<w:tab> 制表。 */
export function docxXmlToText(xml) {
  let s = String(xml || '')
  s = s.replace(/<w:tab\b[^>]*\/>/gu, '\t')
  s = s.replace(/<w:br\b[^>]*\/>/gu, '\n')
  s = s.replace(/<\/w:p>/gu, '\n')
  s = s.replace(/<[^>]+>/gu, '')
  s = decodeXml(s)
  s = s.replace(/\r\n?/gu, '\n').replace(/[ \t]+\n/gu, '\n').replace(/\n{3,}/gu, '\n\n')
  return s.trim()
}

/** RTF 里的中文是按文档代码页写成 \\'hh 的；这里按 \\ansicpg 选解码器。 */
function rtfEncoding(rtf) {
  const m = String(rtf).match(/\\ansicpg(\d+)/u)
  const cp = m ? Number(m[1]) : 1252
  if (cp === 936) return 'gbk'
  if (cp === 65001) return 'utf-8'
  if (cp === 950) return 'big5'
  if (cp === 1251) return 'windows-1251'
  return 'windows-1252'
}

/** RTF 粗剥：去掉控制字和分组，保留可见文本。够用于"其实就是 rtf 的 .doc"。 */
export function stripRtf(rtf) {
  const src = String(rtf || '')
  const encoding = rtfEncoding(src)
  let s = src
  // 只删 \{\* 这种"目标组"（如 {\*\generator ...}），别把整个文档吃掉：
  // 这里必须是"字面反斜杠 + 星号"，写成 \{\\* 会变成"零个或多个反斜杠"，
  // 没有内层大括号的 RTF 会被整段删掉。
  s = s.replace(/\{\\\*[^{}]*\}/gu, '')
  s = s.replace(/\\u(-?\d+)\??/gu, (_m, n) => String.fromCharCode((Number(n) + 65536) % 65536))
  s = s.replace(/\\par[d]?/gu, '\n')
  s = s.replace(/\\tab/gu, '\t')
  s = s.replace(/\\[a-zA-Z]+-?\d* ?/gu, '')
  s = s.replace(/[{}]/gu, '')
  // 最后再把 \\'hh 的字节串按代码页解出来（顺序很关键：先解码的话中文会变乱码）
  s = s.replace(/(?:\\'[0-9a-fA-F]{2})+/gu, (run) => {
    const bytes = []
    for (const m of run.matchAll(/\\'([0-9a-fA-F]{2})/gu)) bytes.push(parseInt(m[1], 16))
    try { return new TextDecoder(encoding).decode(Uint8Array.from(bytes)) } catch { return run }
  })
  s = s.replace(/\r\n?/gu, '\n').replace(/\n{3,}/gu, '\n\n')
  return s.trim()
}

/**
 * 统一入口：传 Buffer，按内容判断类型。
 * 返回 { text, kind }，kind 是 'docx' | 'rtf' | 'text'。
 */
export function extractText(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  if (b.length === 0) throw new Error('空文件')
  // zip（docx 也是）
  if (b.length > 4 && b.readUInt32LE(0) === 0x04034b50) {
    const entries = listZipEntries(b)
    const doc = entries.find((e) => e.name === 'word/document.xml')
    if (!doc) throw new Error('这是 zip，但不是 docx（缺少 word/document.xml）')
    return { text: docxXmlToText(readZipEntry(b, doc).toString('utf8')), kind: 'docx' }
  }
  const head = b.subarray(0, 5).toString('latin1')
  if (head === '{\\rtf') return { text: stripRtf(b.toString('latin1')), kind: 'rtf' }
  // OLE 复合文档的魔数是 D0 CF 11 E0（按小端读出来是 0xE011CFD0）
  if (b.length > 8 && b.readUInt32LE(0) === 0xe011cfd0) {
    throw new Error('这是老的二进制 .doc，无法可靠解析；请在 Word 里另存为 .docx 或 .txt')
  }
  // 当成纯文本（顺带去掉 BOM）
  let s = b.toString('utf8')
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1)
  return { text: s.trim(), kind: 'text' }
}
