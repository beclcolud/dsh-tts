/**
 * 平台相关小函数的单元测试。运行：node scripts/test_platform.mjs
 *
 * 这台机器只有 Windows，所以这里靠"传 platform 参数"覆盖另一条分支——
 * 逻辑可测，但真正的 Linux 运行仍然没有验证过（见 README 的平台说明）。
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const P = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'platform.js')).href)

let fail = 0
const ok = (c, label, extra) => {
  if (c) console.log('  ok   ' + label)
  else { fail += 1; console.log('  FAIL ' + label + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra))) }
}

console.log('[1] isWindows')
ok(P.isWindows('win32') === true, 'win32 判定为 Windows')
ok(P.isWindows('linux') === false, 'linux 不是 Windows')
ok(P.isWindows('darwin') === false, 'darwin 不是 Windows')

console.log('[2] ffmpeg concat 列表里的路径')
ok(P.ffconcatPath('C:\\a\\b.wav', 'win32') === 'C:/a/b.wav', 'Windows 上反斜杠换成斜杠', P.ffconcatPath('C:\\a\\b.wav', 'win32'))
ok(P.ffconcatPath('/home/a/b.wav', 'linux') === '/home/a/b.wav', 'Linux 上原样不动', P.ffconcatPath('/home/a/b.wav', 'linux'))
// Linux 文件名里反斜杠是合法字符，替换会改坏真实路径
ok(P.ffconcatPath('/home/a/b\\c.wav', 'linux') === '/home/a/b\\c.wav', 'Linux 上反斜杠不被改写', P.ffconcatPath('/home/a/b\\c.wav', 'linux'))
ok(P.ffconcatPath('', 'win32') === '', '空串不炸')

console.log('[3] 命令行引用')
ok(P.shellQuote('C:\\a b\\c.wav', 'win32') === '"C:\\a b\\c.wav"', 'Windows 用双引号', P.shellQuote('C:\\a b\\c.wav', 'win32'))
ok(P.shellQuote("/home/a b/c.wav", 'linux') === "'/home/a b/c.wav'", 'POSIX 用单引号', P.shellQuote("/home/a b/c.wav", 'linux'))
ok(P.shellQuote("it's", 'linux') === "'it'\\''s'", 'POSIX 单引号转义正确', P.shellQuote("it's", 'linux'))
ok(P.shellQuote('say "hi"', 'win32') === '"say ""hi"""', 'Windows 双引号转义正确', P.shellQuote('say "hi"', 'win32'))

console.log('')
console.log(fail === 0 ? '全部通过' : fail + ' 项失败')
process.exit(fail === 0 ? 0 : 1)
