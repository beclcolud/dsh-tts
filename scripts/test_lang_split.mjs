import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const S = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'synth.js')).href)
let fail = 0
const ok = (c, label, extra) => { if (c) console.log('  ok   ' + label); else { fail++; console.log('  FAIL ' + label + ' -> ' + JSON.stringify(extra)) } }
console.log('[英文切句不能吞空格]')
const one = S.splitForRequest('Good morning. This is a test. The weather is nice today.', 300, 'en')
ok(one.length === 1, '小文本合成 1 个请求', one)
ok(one[0].indexOf('Good morning. This') >= 0, '句号后的空格还在', one[0])
ok(one[0].split('. ').length === 3, '三个句子都还能被认出', one[0])
const multi = S.splitForRequest('One. Two! Three?', 6, 'en')
ok(multi.length === 3, '限长时分成 3 段', multi)
ok(multi.join('') === 'One. Two! Three?', '拼回去与原文一致', multi.join(''))
console.log('')
console.log(fail === 0 ? '全部通过' : fail + ' 项失败')
process.exit(fail === 0 ? 0 : 1)
