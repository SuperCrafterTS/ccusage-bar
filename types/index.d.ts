export type Block = {
  usd: number
  tokens: number
  costPerHour: number
  projectedUsd: number
  remainingMinutes: number
  endTime: string
}

export type Summary = {
  todayUsd: number
  todayTokens: number
  monthUsd: number
  monthTokens: number
  allUsd: number
  allTokens: number
  outputTokens: number
  bestDay: { date: string; usd: number } | null
  streak: number
  activeDays: number
  block: Block | null
  updatedAt: number
}

export type Live = { tokens: number; turns: number; model: string }

declare module 'claude-code' {
  interface PluginState {
    'ccusage-bar': {
      summary: Summary | null
      live: Live
      isHidden: boolean
      tick: number
    }
  }
}
