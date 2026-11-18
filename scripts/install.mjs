/**
 * dsh-tts installer / uninstaller.
 *
 * DSH keeps profiles/desktop/package.json locked while it runs, so this must be
 * executed with DSH fully closed. It backs the profile up to backup/, patches
 * dependencies + bundles, links the package into node_modules, then really
 * imports the plugin entry (syntax / resolution errors surface here, not at the
 * next DSH start). Any failure rolls the profile back.
 *
 *   node scripts/install.mjs [--uninstall] [--dry-run]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', 'desktop')
const PKG_FILE = path.join(PROFILE_DIR, 'package.json')
const args = process.argv.slice(2)
const uninstall = args.includes('--uninstall')
const dryRun = args.includes('--dry-run')

const log = (...a) => console.log('[dsh-tts]', ...a)

if (!fs.existsSync(PKG_FILE)) {
  console.error('找不到 profile:' + PKG_FILE)
  process.exit(1)
}

const raw = fs.readFileSync(PKG_FILE, 'utf8')
const pkg = JSON.parse(raw)
const deps = pkg.dependencies || (pkg.dependencies = {})
const bundles = pkg.dsh?.profile?.bundles || []

if (uninstall) {
  delete deps['dsh-tts']
  const i = bundles.indexOf('dsh-tts')
  if (i >= 0) bundles.splice(i, 1)
  if (dryRun) { log('dry-run: 将移除 dsh-tts'); process.exit(0) }
  writeProfile()
  removeLink()
  log('已卸载。重启 DSH 生效。')
  process.exit(0)
}

if (deps['dsh-tts'] && bundles.includes('dsh-tts')) {
  log('已经装过了，无需重复安装。')
  process.exit(0)
}
deps['dsh-tts'] = 'link:' + ROOT.replace(/\\/g, '/')
if (!bundles.includes('dsh-tts')) bundles.push('dsh-tts')
if (!pkg.dsh) pkg.dsh = {}
if (!pkg.dsh.profile) pkg.dsh.profile = {}
pkg.dsh.profile.bundles = bundles

if (dryRun) {
  log('dry-run: 将写入 ' + PKG_FILE)
  log('dry-run: 链接方式 ' + (process.platform === 'win32' ? 'junction (mklink /J)' : '符号链接 (symlink)'))
  log(JSON.stringify({ dependencies: deps, bundles }, null, 2))
  process.exit(0)
}

const backupDir = path.join(PROFILE_DIR, 'backup')
fs.mkdirSync(backupDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = path.join(backupDir, 'package.json.' + stamp + '.bak')
fs.copyFileSync(PKG_FILE, backup)
log('已备份 profile → ' + backup)

try {
  writeProfile()
  link()
  verify()
  log('安装完成。重启 DSH 后 voiceover 工具可用。')
} catch (error) {
  console.error('[dsh-tts] 安装失败：' + (error && error.message))
  fs.copyFileSync(backup, PKG_FILE)
  removeLink()
  console.error('[dsh-tts] 已回滚 profile。')
  process.exit(1)
}

function writeProfile() {
  fs.writeFileSync(PKG_FILE, JSON.stringify(pkg, null, 2), 'utf8')
}

function link() {
  const nm = path.join(PROFILE_DIR, 'node_modules')
  fs.mkdirSync(nm, { recursive: true })
  const target = path.join(nm, 'dsh-tts')
  removeLink()
  if (process.platform === 'win32') {
    // Windows 上真链接要管理员权限，junction 不需要，而且 DSH 能正常解析
    const res = spawnSync('cmd', ['/c', 'mklink', '/J', target, ROOT], { encoding: 'utf8' })
    if (res.status !== 0) throw new Error('创建 junction 失败：' + (res.stderr || res.stdout))
    return
  }
  // POSIX 用符号链接；目录链接用 'dir'
  try {
    fs.symlinkSync(ROOT, target, 'dir')
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      fs.unlinkSync(target)
      fs.symlinkSync(ROOT, target, 'dir')
      return
    }
    throw new Error('创建符号链接失败：' + (error && error.message))
  }
}

function removeLink() {
  const target = path.join(PROFILE_DIR, 'node_modules', 'dsh-tts')
  let st = null
  try { st = fs.lstatSync(target) } catch { return }
  try {
    // 符号链接必须用 unlink：对它 rmSync(recursive) 在 POSIX 上会删到目标目录里去
    if (process.platform !== 'win32' && st.isSymbolicLink()) fs.unlinkSync(target)
    else fs.rmSync(target, { recursive: true, force: true })
  } catch { /* junction/链接可能已经不在，忽略 */ }
}

async function verify() {
  const entry = pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href
  const mod = await import(entry)
  if (typeof mod.apply !== 'function' || typeof mod.name !== 'string') {
    throw new Error('插件入口没有导出 name/apply')
  }
  log('入口自检通过：' + mod.name)
}
