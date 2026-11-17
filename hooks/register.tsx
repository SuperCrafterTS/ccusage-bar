import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { Block, Live, Summary } from '../types'

const summary = atom({ plugin: 'ccusage-bar', key: 'summary' } as const, null)
const live = atom({ plugin: 'ccusage-bar', key: 'live' } as const, { tokens: 0, turns: 0, model: '' })
const isHidden = atom({ plugin: 'ccusage-bar', key: 'isHidden' } as const, false)
const tick = atom({ plugin: 'ccusage-bar', key: 'tick' } as const, 0)

// ---- ccusage JSON shapes (only the fields this mod reads) ----
type Breakdown = { modelName: string; cost: number }
type Row = {
  period: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  totalTokens: number
  totalCost: number
  modelsUsed?: string[]
  modelBreakdowns?: Breakdown[]
  metadata?: { lastActivity?: string }
}
type RawBlock = {
  isActive: boolean
  costUSD: number
  totalTokens: number
  endTime: string
  startTime: string
  burnRate?: { costPerHour: number; tokensPerMinute: number } | null
  projection?: { totalCost: number; totalTokens: number; remainingMinutes: number } | null
}

// ---- formatting ----
const tok = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${Math.round(n)}`
const usd = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`)
const num = (n: number) => Math.round(n).toLocaleString('en-US')
const bar = (pct: number, cells = 10) => {
  const filled = Math.max(0, Math.min(cells, Math.round((pct / 100) * cells)))
  return '█'.repeat(filled) + '░'.repeat(cells - filled)
}
const pctColor = (pct: number) => (pct >= 80 ? 'error' : pct >= 50 ? 'warning' : 'success')
const limitName = (kind: string) =>
  kind === 'five_hour' ? '5h' : kind === 'seven_day' ? 'Week' : kind === 'seven_day_opus' ? 'Week (Opus)' : kind.replace(/_/g, ' ')
const shortModel = (m: string) => m.replace(/^claude-/, '').replace(/-\d{8}$/, '')
const localDate = (ms: number) => {
  const d = new Date(ms)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const prettyDate = (iso: string) => {
  const [y = 1970, m = 1, d = 1] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
const clockTime = (iso?: string) =>
  iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : ''
const resetIn = (iso: string | undefined, now: number) => {
  if (!iso) return ''
  const mins = Math.max(0, Math.round((new Date(iso).getTime() - now) / 60000))
  if (mins >= 1440) return `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`
  return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`
}

// ---- running ccusage ----
const SAFE = /^[\w\-.:=/]+$/

async function ccusage($: EngineInterface, args: string[], json = true) {
  const argv = json ? [...args, '--json', '--offline'] : args
  const env = { NO_COLOR: '1', FORCE_COLOR: '0' }
  const init = { env, timeoutMs: 120000 }
  try {
    return await $.process.run(['ccusage', ...argv], init)
  } catch {
    // Windows: ccusage is an npm .cmd shim, which needs cmd.exe to start.
    return await $.process.run(['cmd.exe', '/d', '/s', '/c', ['ccusage', ...argv].join(' ')], init)
  }
}

async function ccusageJson<T>($: EngineInterface, args: string[], key: string): Promise<T[]> {
  const r = await ccusage($, args)
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `ccusage exited ${r.exitCode}`)
  const parsed = JSON.parse(r.stdout) as Record<string, T[]>
  return parsed[key] ?? []
}

function streakOf(days: Set<string>, now: number) {
  let streak = 0
  let t = now
  if (!days.has(localDate(t))) t -= 86400000 // no use yet today: count from yesterday
  while (days.has(localDate(t))) {
    streak += 1
    t -= 86400000
  }
  return streak
}

async function refresh($: EngineInterface) {
  const now = await $.clock.now()
  const [daily, blocks, sessions, sessionId] = await Promise.all([
    ccusageJson<Row>($, ['daily'], 'daily'),
    ccusageJson<RawBlock>($, ['blocks', '--active'], 'blocks'),
    ccusageJson<Row>($, ['session'], 'session'),
    $.session.id(),
  ])
  const mine = sessions.find(r => r.period === sessionId)
  const today = localDate(now)
  const month = today.slice(0, 7)
  const todayRow = daily.find(d => d.period === today)
  const monthRows = daily.filter(d => d.period.startsWith(month))
  const best = daily.reduce<Row | null>((b, d) => (!b || d.totalCost > b.totalCost ? d : b), null)
  const active = blocks.find(b => b.isActive)
  const block: Block | null = active
    ? {
        usd: active.costUSD,
        tokens: active.totalTokens,
        costPerHour: active.burnRate?.costPerHour ?? 0,
        projectedUsd: active.projection?.totalCost ?? active.costUSD,
        remainingMinutes: active.projection?.remainingMinutes ?? 0,
        endTime: active.endTime,
      }
    : null
  const next: Summary = {
    todayUsd: todayRow?.totalCost ?? 0,
    todayTokens: todayRow?.totalTokens ?? 0,
    monthUsd: monthRows.reduce((s, d) => s + d.totalCost, 0),
    monthTokens: monthRows.reduce((s, d) => s + d.totalTokens, 0),
    allUsd: daily.reduce((s, d) => s + d.totalCost, 0),
    allTokens: daily.reduce((s, d) => s + d.totalTokens, 0),
    outputTokens: daily.reduce((s, d) => s + d.outputTokens, 0),
    bestDay: best ? { date: best.period, usd: best.totalCost } : null,
    streak: streakOf(new Set(daily.map(d => d.period)), now),
    activeDays: daily.length,
    block,
    session: mine ? { tokens: mine.totalTokens, usd: mine.totalCost } : null,
    updatedAt: now,
  }
  await update($, summary, () => next)
}

function funStats(s: Summary): string[] {
  const out: string[] = []
  if (s.streak > 0) out.push(`🔥 ${s.streak}-day streak`)
  if (s.bestDay) out.push(`🏆 best day ${prettyDate(s.bestDay.date)} ${usd(s.bestDay.usd)}`)
  const novels = (s.outputTokens * 0.75) / 90000
  if (novels >= 0.1) out.push(`📚 Claude wrote ≈${novels.toFixed(1)} novels`)
  const lattes = s.monthUsd / 5
  if (lattes >= 1) out.push(`☕ ≈${Math.round(lattes)} lattes this month`)
  out.push(`📅 ${s.activeDays} active days`)
  return out
}

// ---- the full report for /ccusage ----
async function report($: EngineInterface): Promise<string> {
  const now = await $.clock.now()
  const [daily, monthly, sessions, blocks, use] = await Promise.all([
    ccusageJson<Row>($, ['daily'], 'daily'),
    ccusageJson<Row>($, ['monthly'], 'monthly'),
    ccusageJson<Row>($, ['session'], 'session'),
    ccusageJson<RawBlock>($, ['blocks', '--active'], 'blocks'),
    $.session.usage(),
  ])
  const l = await read($, live)
  const md: string[] = ['## 📊 ccusage report', '']

  md.push('### This session (live)')
  md.push(
    `- **API value:** ${use.cost ? usd(use.cost.usd) : 'n/a'}${l.model ? ` at ${shortModel(l.model)} prices` : ''}`,
    `- **Tokens:** ${num(Math.max(l.tokens, (await read($, summary))?.session?.tokens ?? 0))} over ${l.turns} turn${l.turns === 1 ? '' : 's'}`,
    `- **Context window:** ${use.context.percent ?? 0}% of ${tok(use.context.window)}`,
    '',
  )

  md.push('### Usage limits')
  if (use.rateLimits.length === 0) {
    md.push('_No limit readings yet: they arrive with the next reply on a Pro/Max plan._', '')
  } else {
    md.push('| Window | Used | | Resets |', '|---|---|---|---|')
    for (const r of use.rateLimits) {
      md.push(`| ${limitName(r.kind)} | ${r.percentUsed}% | \`${bar(r.percentUsed)}\` | ${r.resetsAt ? `${clockTime(r.resetsAt)} (in ${resetIn(r.resetsAt, now)})` : '—'} |`)
    }
    md.push('')
  }

  const a = blocks.find(b => b.isActive)
  md.push('### Current 5-hour block')
  if (a) {
    md.push(
      `- **So far:** ${usd(a.costUSD)} · ${tok(a.totalTokens)} tokens (started ${clockTime(a.startTime)}, ends ${clockTime(a.endTime)})`,
      `- **Burn rate:** ${a.burnRate ? `${usd(a.burnRate.costPerHour)}/hr · ${num(a.burnRate.tokensPerMinute)} tokens/min` : 'n/a'}`,
      `- **Projected by block end:** ${a.projection ? `${usd(a.projection.totalCost)} · ${tok(a.projection.totalTokens)} tokens (${a.projection.remainingMinutes} min left)` : 'n/a'}`,
      '',
    )
  } else {
    md.push('_No active block._', '')
  }

  md.push('### Daily (last 14 days)')
  md.push('| Date | Models | Input | Output | Cache write | Cache read | Total | Cost |', '|---|---|--:|--:|--:|--:|--:|--:|')
  for (const d of daily.slice(-14)) {
    md.push(`| ${prettyDate(d.period)} | ${(d.modelsUsed ?? []).map(shortModel).join(', ')} | ${num(d.inputTokens)} | ${num(d.outputTokens)} | ${num(d.cacheCreationTokens)} | ${num(d.cacheReadTokens)} | ${tok(d.totalTokens)} | ${usd(d.totalCost)} |`)
  }
  md.push('')

  md.push('### Monthly')
  md.push('| Month | Models | Output | Total tokens | Cost |', '|---|---|--:|--:|--:|')
  for (const m of monthly) {
    md.push(`| ${m.period} | ${(m.modelsUsed ?? []).map(shortModel).join(', ')} | ${num(m.outputTokens)} | ${tok(m.totalTokens)} | ${usd(m.totalCost)} |`)
  }
  md.push('')

  const recent = [...sessions]
    .sort((x, y) => (y.metadata?.lastActivity ?? '').localeCompare(x.metadata?.lastActivity ?? ''))
    .slice(0, 10)
  md.push('### Recent sessions')
  md.push('| Session | Last active | Models | Tokens | Cost |', '|---|---|---|--:|--:|')
  for (const s of recent) {
    const last = s.metadata?.lastActivity
    md.push(`| \`${s.period.slice(0, 8)}\` | ${last ? new Date(last).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'} | ${(s.modelsUsed ?? []).map(shortModel).join(', ')} | ${tok(s.totalTokens)} | ${usd(s.totalCost)} |`)
  }
  md.push('')

  // Totals and model split
  const byModel = new Map<string, number>()
  for (const d of daily) for (const b of d.modelBreakdowns ?? []) byModel.set(b.modelName, (byModel.get(b.modelName) ?? 0) + b.cost)
  const allUsd = daily.reduce((s, d) => s + d.totalCost, 0)
  const allTok = daily.reduce((s, d) => s + d.totalTokens, 0)
  const cacheRead = daily.reduce((s, d) => s + d.cacheReadTokens, 0)
  md.push('### Totals & fun stats')
  md.push(`- **All time:** ${usd(allUsd)} · ${tok(allTok)} tokens · ${daily.length} active days · avg ${usd(allUsd / Math.max(1, daily.length))}/day`)
  md.push(`- **By model:** ${[...byModel].sort((x, y) => y[1] - x[1]).map(([m, c]) => `${shortModel(m)} ${usd(c)} (${Math.round((c / Math.max(allUsd, 1e-9)) * 100)}%)`).join(' · ')}`)
  md.push(`- **Cache reads:** ${Math.round((cacheRead / Math.max(allTok, 1)) * 100)}% of all tokens were cheap cache re-reads`)
  await refresh($).catch(() => undefined)
  const s = await read($, summary)
  if (s) md.push(`- ${funStats(s).join(' · ')}`)
  md.push('', '_Costs are API-equivalent estimates from local logs, not your bill. `/ccusage bar` toggles the bar; `/ccusage <args>` runs ccusage with any arguments._')
  return md.join('\n')
}

const REFRESH_MS = 10000
let lastRefresh = 0
let isRefreshing = false

async function safeRefresh($: EngineInterface, force = false) {
  const now = await $.clock.now()
  if (isRefreshing || (!force && now - lastRefresh < REFRESH_MS - 500)) return
  lastRefresh = now
  isRefreshing = true
  try {
    await refresh($)
    await update($, tick, n => n + 1)
  } catch (err) {
    $.ui.status(`ccusage-bar: ${String(err).slice(0, 80)}`)
  } finally {
    isRefreshing = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ccusage',
      description: 'Token usage, API value, limits and fun stats (args: bar | refresh | any ccusage args)',
      argumentHint: '[bar | refresh | daily | monthly | session | blocks ...]',
    })
    void safeRefresh($)
    $.clock.every(REFRESH_MS, () => void safeRefresh($))
    return next(e)
  })

  // Every model response (each step of a turn, subagents too): add its tokens
  // and redraw, so the session's tokens and API cost move during a turn.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    const u = r.usage
    if (u) {
      const add = u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      await update($, live, (l: Live) => ({ ...l, tokens: l.tokens + add, model: e.agentId ? l.model || u.model : u.model || l.model }))
      await update($, tick, n => n + 1)
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    await update($, live, (l: Live) => ({ ...l, turns: l.turns + 1 }))
    void safeRefresh($)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await update($, tick, n => n + 1)
    return next(e)
  })

  on('command.run', { command: 'ccusage' }, async ($, e) => {
    const args = e.args.trim()
    if (args === 'bar') {
      const hidden = await update($, isHidden, h => !h)
      return { text: hidden ? 'Usage bar hidden. `/ccusage bar` shows it again.' : 'Usage bar shown.' }
    }
    if (args === 'refresh') {
      await safeRefresh($, true)
      return { text: 'Usage bar refreshed.' }
    }
    if (args) {
      const parts = args.split(/\s+/)
      if (!parts.every(p => SAFE.test(p))) return { text: 'Those arguments contain characters /ccusage does not pass on.' }
      const r = await ccusage($, [...parts, '--offline'], false)
      return { text: '```\n' + (r.stdout || r.stderr).trim() + '\n```' }
    }
    try {
      return { text: await report($) }
    } catch (err) {
      return { text: `ccusage failed: ${String(err)}` }
    }
  })

  // Draw /ccusage's output as Markdown so the tables render.
  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    if (e.props.command !== 'ccusage' || e.props.isErrored) return next(e)
    const { Markdown } = $.ui.resolve(e)
    return <Markdown text={e.props.text} />
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)
    await read($, tick) // redraw when the engine re-measures
    const { Box, Text } = $.ui.resolve(e)
    const [use, l, s, now] = await Promise.all([$.session.usage(), read($, live), read($, summary), $.clock.now()])

    const limits = use.rateLimits.map((r: SessionRateLimit) => (
      <Text key={r.kind}>
        <Text dimColor> │ {limitName(r.kind)} </Text>
        <Text color={pctColor(r.percentUsed)}>{bar(r.percentUsed, 8)}</Text>
        <Text> {r.percentUsed}%</Text>
        {r.resetsAt ? <Text dimColor> ↻{resetIn(r.resetsAt, now)}</Text> : null}
      </Text>
    ))
    const ctx = use.context.percent ?? 0

    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text color="claude" bold>◆ </Text>
          <Text bold>{tok(Math.max(l.tokens, s?.session?.tokens ?? 0))}</Text>
          <Text dimColor> tok · </Text>
          <Text bold color="success">{use.cost ? usd(use.cost.usd) : '$—'}</Text>
          <Text dimColor> API{l.model ? ` (${shortModel(l.model)})` : ''}</Text>
          <Text dimColor> │ ctx </Text>
          <Text color={pctColor(ctx)}>{ctx}%</Text>
          {limits.length > 0 ? limits : <Text dimColor> │ limits: waiting for a reply</Text>}
        </Text>
        {s ? (
          <Text dimColor wrap="truncate-end">
            {'✦ '}Today {usd(s.todayUsd)} · Month {usd(s.monthUsd)}
            {s.block ? ` · Block ${usd(s.block.usd)} @ ${usd(s.block.costPerHour)}/hr → ${usd(s.block.projectedUsd)}` : ''}
            {' · '}
            {funStats(s).join(' · ')}
          </Text>
        ) : (
          <Text dimColor>✦ Reading ccusage…</Text>
        )}
      </Box>
    )
  })
}
