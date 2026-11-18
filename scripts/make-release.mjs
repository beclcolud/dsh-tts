/**
 * 打包一个可以发给别人的分发包（脱敏）。
 *
 *   node scripts/make-release.mjs            # 生成 dist/dsh-tts-<版本>/ 并压成 zip
 *   node scripts/make-release.mjs --check    # 只体检当前仓库，不打包
 *
 * 做什么：
 *   1. 只拷运行时需要的文件（不含开发脚本、交接文档、__pycache__、dist）
 *   2. 把 cordis.patch.yml 里的绝对路径清空（换成待填写的空串 + 注释）
 *   3. 扫描所有文本文件，发现绝对路径 / 邮箱 / 本机用户名就报错退出
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const checkOnly = process.argv.includes('--check')

// 只发这些（白名单，避免漏掉新文件时把开发脚本一起发出去）
const INCLUDE = [
  'lib', 'server', 'requirements',
  'package.json', 'README.md', '使用手册.md', 'AI声明.md', 'LICENSE',
  'bootstrap_env.py', 'models.manifest.json', 'cordis.patch.yml',
  '一键安装.cmd', '一键安装.sh', '一键卸载.cmd', '一键卸载.sh',
  'scripts/install.mjs',
]
// 明确不发：开发脚本（内含本机路径）、交接文档、构建产物
const SKIP_DIRS = new Set(['__pycache__', 'dist', 'node_modules', '.git'])

const LEAKS = [
  { re: /[A-Za-z]:\\\\[^\s'"`]+/, label: 'Windows 绝对路径' },
  { re: /\/(Users|home)\/[A-Za-z0-9._-]+/, label: 'Unix 家目录路径' },
  { re: /[\w.+-]+@[\w-]+\.[\w.]{2,}/, label: '邮箱地址' },
  { re: /<工作区>/, label: '本机目录名' },
]
const TEXT_EXT = new Set(['.js', '.mjs', '.py', '.json', '.yml', '.yaml', '.md', '.html', '.txt', '.sh', '.cmd'])

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/** 扫描一个文本文件里的敏感内容，返回命中行。 */
function scanFile(file, text) {
  const hits = []
  text.split(/\r?\n/).forEach((line, i) => {
    for (const rule of LEAKS) {
      const m = line.match(rule.re)
      if (m) hits.push({ line: i + 1, label: rule.label, sample: m[0].slice(0, 60) })
    }
  })
  return hits
}

/** cordis.patch.yml 里的路径清空，留注释让收件人自己填。 */
function blankConfig(text) {
  const header = [
    '# 分享包：为避免带走原作者的机器路径，下面的路径都已清空。',
    '# 填写方法见 README「下载内容与依赖」与 使用手册 §10。',
    '# 必填：pythonPath、libs、models.custom / base / asr',
    '',
  ].join('\n')
  const body = text
    .replace(/^\s*(pythonPath|libs|workDir|mtModel|logFile):\s*'.*'\s*$/gm, (m, key) => m.replace(/'.*'/, "''"))
    .replace(/(custom|base|asr|design|aligner):\s*'.*'/g, (m, key) => key + ": ''")
  return header + body
}

const list = []
for (const item of INCLUDE) {
  const p = path.join(ROOT, item)
  if (!fs.existsSync(p)) { console.warn('[跳过] 不存在：' + item); continue }
  if (fs.statSync(p).isDirectory()) walk(p, list)
  else list.push(p)
}

console.log('[1] 待打包 ' + list.length + ' 个文件')

// —— 体检 ——
const problems = []
for (const p of list) {
  if (!TEXT_EXT.has(path.extname(p).toLowerCase())) continue
  const rel = path.relative(ROOT, p)
  let text = fs.readFileSync(p, 'utf8')
  if (rel === 'cordis.patch.yml') text = blankConfig(text)
  const hits = scanFile(p, text)
  for (const h of hits) problems.push({ file: rel, ...h })
}

if (checkOnly) {
  if (problems.length === 0) {
    console.log('[2] 体检通过：没有绝对路径、邮箱或本机目录名')
    process.exit(0)
  }
  console.log('[2] 发现 ' + problems.length + ' 处需要处理：')
  for (const p of problems) console.log('    ' + p.file + ':' + p.line + '  ' + p.label + '  ' + p.sample)
  process.exit(1)
}

// —— 打包 ——
const outName = 'dsh-tts-' + pkg.version
const outDir = path.join(ROOT, 'dist', outName)
fs.rmSync(outDir, { recursive: true, force: true })
for (const p of list) {
  const rel = path.relative(ROOT, p)
  const dst = path.join(outDir, rel)
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  if (rel === 'cordis.patch.yml') fs.writeFileSync(dst, blankConfig(fs.readFileSync(p, 'utf8')), 'utf8')
  else fs.copyFileSync(p, dst)
}
console.log('[2] 已写到 ' + outDir)

// —— 对产物再体检一次（防止漏网） ——
const outProblems = []
for (const p of walk(outDir)) {
  if (!TEXT_EXT.has(path.extname(p).toLowerCase())) continue
  const hits = scanFile(p, fs.readFileSync(p, 'utf8'))
  for (const h of hits) outProblems.push({ file: path.relative(outDir, p), ...h })
}
if (outProblems.length) {
  console.log('[3] 产物里仍有 ' + outProblems.length + ' 处敏感内容：')
  for (const p of outProblems.slice(0, 20)) console.log('    ' + p.file + ':' + p.line + '  ' + p.sample)
  process.exit(1)
}
console.log('[3] 产物体检通过')

// —— 压缩 ——（函数定义在下面，先声明再调用，避免 TDZ）

/* ---- 极简 zip 写入（store 目录用 deflate，文件名 UTF-8） ---- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

function dosTime(d) {
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)) & 0xFFFF
  const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF
  return { time, date }
}

function writeZip(outFile, rootDir, topName) {
  const entries = []
  const addDir = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const a2 = path.join(abs, e.name)
      const r2 = rel + '/' + e.name
      if (e.isDirectory()) { entries.push({ name: r2 + '/', dir: true }); addDir(a2, r2) }
      else entries.push({ name: r2, dir: false, abs: a2 })
    }
  }
  entries.push({ name: topName + '/', dir: true })
  addDir(rootDir, topName)

  const chunks = []
  const central = []
  let offset = 0
  for (const en of entries) {
    const nameBuf = Buffer.from(en.name, 'utf8')
    const st = en.dir ? null : fs.statSync(en.abs)
    const raw = en.dir ? Buffer.alloc(0) : fs.readFileSync(en.abs)
    const data = en.dir ? Buffer.alloc(0) : zlib.deflateRawSync(raw, { level: 9 })
    const crc = en.dir ? 0 : crc32(raw)
    const { time, date } = dosTime(st ? st.mtime : new Date())
    const method = en.dir ? 0 : 8

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)      // bit 11 = 文件名 UTF-8
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, nameBuf, data)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt16LE(time, 12)
    cd.writeUInt16LE(date, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(raw.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30)
    cd.writeUInt16LE(0, 32)
    cd.writeUInt16LE(0, 34)
    cd.writeUInt16LE(0, 36)
    cd.writeUInt32LE(0, 38)
    cd.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([cd, nameBuf]))

    offset += local.length + nameBuf.length + data.length
  }
  const cdBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cdBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  fs.writeFileSync(outFile, Buffer.concat([...chunks, cdBuf, end]))
}

// —— 真正打包 ——（函数已定义完，这里才调用）
const zip = path.join(ROOT, 'dist', outName + '.zip')
fs.rmSync(zip, { force: true })
writeZip(zip, outDir, outName)
const mb = (fs.statSync(zip).size / 1e6).toFixed(1)
console.log('[4] 已打包 ' + zip + '（' + mb + ' MB，UTF-8 文件名）')
