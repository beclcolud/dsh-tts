/**
 * Turn a timeline + an external script into a preflight plan.
 *
 * Nothing is synthesised here: the plan is what the user reviews before we spend
 * minutes on the GPU. Every mismatch is reported with a concrete suggestion.
 */
import { parseScript, estimateSeconds } from './script.js'

export const OVER_SEC = 0.3
export const UNDER_SEC = 0.3

function normId(key) {
  const n = Number.parseInt(String(key ?? '').replace(/[^\d]/gu, ''), 10)
  return Number.isInteger(n) ? String(n).padStart(2, '0') : String(key ?? '')
}

export function buildPlan(sequence, scriptText, opts) {
  const cps = Number(opts && opts.charsPerSecond) > 0 ? Number(opts.charsPerSecond) : 4.5
  const globalMode = (opts && opts.mode) || 'both'
  const { segments, warnings } = parseScript(scriptText)
  const issues = [...warnings]
  const errors = []

  const markers = sequence.markers.filter((m) => m.name && m.name.trim() !== '')
  const byId = new Map()
  for (const m of markers) {
    const id = normId(m.name)
    if (byId.has(id)) issues.push('标记编号重复：' + id)
    byId.set(id, m)
  }

  const rows = []
  const usedIds = new Set()
  for (const seg of segments) {
    const id = normId(seg.id)
    // Two paragraphs claiming the same marker would fight for the same output file.
    if (usedIds.has(id)) {
      errors.push('文案里编号 ' + id + ' 出现了两次（同一编号只能有一段）')
      continue
    }
    usedIds.add(id)
    const marker = byId.get(id)
    if (!marker) {
      errors.push('文案里的 ' + id + ' 在时间轴上找不到同名标记')
      continue
    }
    if (!marker.isRange) {
      errors.push('标记 ' + id + ' 是点标记（没有出点），无法判断该段时长')
      continue
    }
    const range = marker.endSec - marker.startSec
    const mode = seg.mode === 'S' ? 'subtitle' : seg.mode === 'V' ? 'voice' : globalMode
    // 只出字幕 + 正文留空 = 反听字幕：把这段原片音频拿去 ASR + 强制对齐。
    // 这比"按字数把文案摊到区间里"准得多，也是原来要手工 curl 才能做的事。
    const asr = mode === 'subtitle' && String(seg.text || '').trim() === ''
    const est = asr ? 0 : estimateSeconds(seg.text, cps)
    const delta = asr ? 0 : est - range
    let status = 'ok'
    if (asr) status = 'asr'
    else if (delta > OVER_SEC) status = 'over'
    else if (-delta > UNDER_SEC) status = 'under'
    const chars = seg.text.length
    let suggestion = ''
    if (status === 'over') {
      const cut = Math.max(1, Math.round(delta * cps))
      suggestion = '超出 ' + delta.toFixed(2) + 's，约需删减 ' + cut + ' 字（当前 ' + chars + ' 字）'
    } else if (status === 'under') {
      const add = Math.max(1, Math.round(-delta * cps))
      suggestion = '比范围短 ' + (-delta).toFixed(2) + 's，可补 ' + add + ' 字，或留白'
    }
    rows.push({
      id,
      mode,
      asr,
      text: seg.text,
      chars,
      estimate: Number(est.toFixed(2)),
      startSec: Number(marker.startSec.toFixed(3)),
      endSec: Number(marker.endSec.toFixed(3)),
      range: Number(range.toFixed(2)),
      delta: Number(delta.toFixed(2)),
      status,
      suggestion,
    })
  }

  for (const m of markers) {
    const id = normId(m.name)
    if (!usedIds.has(id)) issues.push('时间轴上的标记 ' + id + ' 在文案里没有对应段落')
  }

  const order = /^\d+$/u
  rows.sort((a, b) => (order.test(a.id) && order.test(b.id) ? Number(a.id) - Number(b.id) : a.id.localeCompare(b.id)))

  const voiceRows = rows.filter((r) => r.mode !== 'subtitle')
  const totalVoice = voiceRows.reduce((n, r) => n + r.estimate, 0)
  return {
    rows,
    errors,
    issues,
    summary: {
      total: rows.length,
      voice: voiceRows.length,
      subtitleOnly: rows.filter((r) => r.mode === 'subtitle').length,
      asr: rows.filter((r) => r.asr).length,
      over: rows.filter((r) => r.status === 'over').length,
      under: rows.filter((r) => r.status === 'under').length,
      estimatedVoiceSeconds: Number(totalVoice.toFixed(1)),
      charsPerSecond: cps,
    },
  }
}

export function renderPlanTable(plan) {
  const lines = []
  lines.push('| 编号 | 模式 | 字数 | 预计 | 标记范围 | 差 | 状态 |')
  lines.push('|---|---|---|---|---|---|---|')
  const label = { voice: '配音', subtitle: '字幕', both: '配音+字幕' }
  const mark = { ok: '✓', over: '超出', under: '偏短', asr: '反听' }
  for (const r of plan.rows) {
    const modeText = r.asr ? '字幕（反听）' : label[r.mode]
    const estText = r.asr ? '—' : r.estimate + 's'
    const deltaText = r.asr ? '—' : (r.delta > 0 ? '+' : '') + r.delta + 's'
    lines.push('| ' + r.id + ' | ' + modeText + ' | ' + (r.asr ? '—' : r.chars) + ' | ' + estText + ' | ' + r.startSec + '→' + r.endSec + 's（' + r.range + 's） | ' + deltaText + ' | ' + mark[r.status] + ' |')
  }
  const bad = plan.rows.filter((r) => r.status !== 'ok' && r.status !== 'asr')
  if (bad.length) {
    lines.push('')
    lines.push('**需要处理：**')
    for (const r of bad) lines.push('- ' + r.id + '：' + r.suggestion)
  }
  return lines.join('\n')
}
