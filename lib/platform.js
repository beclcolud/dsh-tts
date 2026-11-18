/**
 * 平台相关的零碎判断。
 *
 * 抽出来是因为这些逻辑没法靠"跑一遍"验证（这台机器只有 Windows），
 * 至少能让分支本身可单测：传 platform 进去，两种取值都能断言。
 */

export function isWindows(platform = process.platform) {
  return platform === 'win32'
}

/**
 * ffmpeg concat 列表里的路径。
 *
 * ffmpeg 在 Windows 上把反斜杠当转义符，所以那里必须换成正斜杠；
 * Linux 上反斜杠只是普通文件名字符，替换反而会改坏真实路径。
 */
export function ffconcatPath(file, platform = process.platform) {
  const s = String(file || '')
  return isWindows(platform) ? s.replace(/\\/g, '/') : s
}

/** 命令行里引用一个路径（Windows 用双引号，POSIX 用单引号更安全）。 */
export function shellQuote(arg, platform = process.platform) {
  const s = String(arg)
  if (isWindows(platform)) return '"' + s.replace(/"/g, '""') + '"'
  return "'" + s.replace(/'/g, "'\\''") + "'"
}
