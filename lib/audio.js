/** Minimal 16-bit PCM WAV reader (mono/stereo) for take scoring. */
import { readFileSync } from 'node:fs'

export function readWav(file) {
  const buf = readFileSync(file)
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 WAV 文件：' + file)
  }
  let pos = 12
  let fmt = null
  let data = null
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    const body = pos + 8
    if (id === 'fmt ') {
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(body + size, buf.length))
    }
    pos = body + size + (size % 2)
  }
  if (!fmt || !data) throw new Error('WAV 缺少 fmt/data 块：' + file)
  if (fmt.bits !== 16) throw new Error('只支持 16-bit WAV：' + file)
  const ch = fmt.channels
  const frames = Math.floor(data.length / (2 * ch))
  const samples = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (let c = 0; c < ch; c++) sum += data.readInt16LE((i * ch + c) * 2)
    samples[i] = sum / (32768 * ch)
  }
  return { sampleRate: fmt.sampleRate, samples, durationSec: frames / fmt.sampleRate }
}

/** Silence runs (seconds) longer than minLen inside a wav. */
export function findPauses(wav, minLen = 0.18, thrRatio = 0.03) {
  const { samples, sampleRate } = wav
  const win = Math.max(2, Math.round(0.01 * sampleRate))
  const hop = Math.max(1, Math.round(0.005 * sampleRate))
  const rms = []
  for (let i = 0; i + win <= samples.length; i += hop) {
    let s = 0
    for (let j = 0; j < win; j++) s += samples[i + j] * samples[i + j]
    rms.push(Math.sqrt(s / win))
  }
  if (rms.length === 0) return []
  const thr = Math.max(rms.reduce((a, b) => Math.max(a, b), 0) * thrRatio, 1e-6)
  const out = []
  let run = 0
  for (const v of rms) {
    if (v < thr) run += 1
    else {
      const len = run * 0.005
      if (len >= minLen) out.push(Number(len.toFixed(2)))
      run = 0
    }
  }
  if (run * 0.005 >= minLen) out.push(Number((run * 0.005).toFixed(2)))
  return out
}

/** How many pauses a sentence legitimately deserves: one per inner punctuation mark. */
export function expectedPauses(text) {
  const m = String(text || '').match(/[，、：；]/gu)
  return m ? m.length : 0
}
