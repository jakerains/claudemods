export type GaugeReading = {
  model: string
  effort: string | null
  tokens: number | null
  window: number | null
  percent: number | null
  place: string | null
}

// One plan usage window as the last response reported it (`five_hour`,
// `seven_day`): how much is used and when it resets (epoch ms, or null).
export type GaugeLimit = {
  kind: string
  percentUsed: number
  resetsAt: number | null
}

// One row of /context's breakdown, as the detailed band draws it.
export type GaugeCategory = {
  name: string
  tokens: number
  // A theme key (/context's own colour for the row) or a raw colour.
  color: string
  kind: 'used' | 'free' | 'buffer'
}

export type GaugeBreakdown = {
  categories: GaugeCategory[]
  totalTokens: number
  rawMaxTokens: number
  percentage: number
  takenAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'context-gauge': {
      reading: GaugeReading
      // On: the detailed band above the prompt; off: the one line under it.
      detail: boolean
      breakdown: GaugeBreakdown | null
      // Plan usage windows; empty off a subscription (API key, cloud provider).
      limits: GaugeLimit[]
      // The clock the usage countdown reads, moved once a second while it shows.
      now: number
      // Output tokens per second of the last few main-loop responses, newest last.
      speed: number[]
    }
  }
}
