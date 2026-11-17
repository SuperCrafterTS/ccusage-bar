import { expect, test } from 'claude-code/testing'

const NOW = new Date(2026, 10, 16, 18, 0).getTime()
const today = '2026-11-16'

const daily = {
  daily: [
    { period: '2026-11-15', inputTokens: 10, outputTokens: 50000, cacheCreationTokens: 1000, cacheReadTokens: 900000, totalTokens: 951010, totalCost: 2, modelsUsed: ['claude-opus-5-5'], modelBreakdowns: [{ modelName: 'claude-opus-5-5', cost: 2 }] },
    { period: today, inputTokens: 20, outputTokens: 70000, cacheCreationTokens: 2000, cacheReadTokens: 5000000, totalTokens: 5072020, totalCost: 6.7, modelsUsed: ['claude-opus-5-5'], modelBreakdowns: [{ modelName: 'claude-opus-5-5', cost: 6.7 }] },
  ],
}
const blocks = {
  blocks: [{ isActive: true, costUSD: 7.32, totalTokens: 12700000, startTime: '2026-11-16T22:00:00.000Z', endTime: '2026-11-17T03:00:00.000Z', burnRate: { costPerHour: 2.7, tokensPerMinute: 78000 }, projection: { totalCost: 11.15, totalTokens: 19000000, remainingMinutes: 85 } }],
}
const monthly = { monthly: [{ period: '2026-11', inputTokens: 30, outputTokens: 120000, cacheCreationTokens: 3000, cacheReadTokens: 5900000, totalTokens: 6023030, totalCost: 8.7, modelsUsed: ['claude-opus-5-5'] }] }
const session = { session: [{ period: '0000aaaa-test', inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3, cacheReadTokens: 4, totalTokens: 2500000, totalCost: 0.5, modelsUsed: ['claude-opus-5-5'], metadata: { lastActivity: '2026-11-16T20:00:00.000Z' } }] }

const band = (surface: 'terminal' | 'desktop') =>
  ({
    plugin: 'ccusage-bar',
    component: 'AbovePrompt',
    surface,
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 4, bodyColumns: 200 },
  }) as const

function engine(on: any, runs: string[][]) {
  on('clock.now', () => ({ value: NOW }))
  on('session.id', () => ({ value: '0000aaaa-test' }))
  on('clock.every', () => ({ value: { cancel() {} } }))
  on('command.register', () => ({ value: { command: 'ccusage' } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW,
      context: { window: 1000000, percent: 42, tokens: 420000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 38, resetsAt: new Date(NOW + 130 * 60000).toISOString() },
        { kind: 'seven_day', percentUsed: 12 },
      ],
      cost: { usd: 6.7 },
    },
  }))
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    runs.push(e.argv)
    const which = e.argv[1]
    const body = which === 'daily' ? daily : which === 'blocks' ? blocks : which === 'monthly' ? monthly : session
    return { value: { exitCode: 0, stdout: JSON.stringify(body), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

test('the bar shows session tokens, API value, limits and fun stats', async ($, on) => {
  const runs: string[][] = []
  engine(on, runs)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'ccusage', args: 'refresh' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(band(surface))
    const texts = (await ui.findAll({ type: 'Text' })).map((t: { text: string }) => t.text).join('|')
    expect(texts).toContain('$6.70')
    expect(texts).toContain('2.5M')
    expect(texts).toContain('38%')
    expect(texts).toContain('Week')
    expect(texts).toContain('Month $8.70')
    expect(texts).toContain('2-day streak')
    await ui.unmount()
  }
  expect(runs.some(a => a.includes('daily') && a.includes('--json'))).toBe(true)
})

test('/ccusage returns the full report', async ($, on) => {
  engine(on, [])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'ccusage', args: '' })
  expect(r.text).toContain('ccusage report')
  expect(r.text).toContain('Usage limits')
  expect(r.text).toContain('Daily (last 14 days)')
  expect(r.text).toContain('Recent sessions')
  expect(r.text).toContain('$11.15')
})

test('/ccusage bar hides the bar', async ($, on) => {
  engine(on, [])
  on('ui.render', ($2: any, e: any) => {
    const { Text } = $2.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'ccusage', args: 'bar' })
  expect(r.text).toContain('hidden')
  const ui = await $.ui.mount(band('desktop'))
  expect((await ui.find({ type: 'Text', text: /◆/ })) ?? null).toBe(null)
  await ui.unmount()
})
