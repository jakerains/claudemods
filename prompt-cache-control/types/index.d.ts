export type Ttl = '5m' | '1h'

export type CacheEnv = {
  enable1h?: string
  force5m?: string
  /** CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" or "1h" for the main conversation */
  ttlVar?: string
  disableAll?: string
  disableHaiku?: string
  disableSonnet?: string
  disableOpus?: string
}

/** One main-loop request, as the API reported it. */
export type Sample = {
  turnId: string
  index: number
  model: string
  /** ms since the epoch when the request started: the cache's lifetime is counted from here */
  startedAt: number
  read: number
  write: number
  fresh: number
  output: number
}

/** What the account is billed as, as far as the mod can tell. */
export type Account = 'subscription' | 'credits' | 'other'

/** Everything the band and the pane draw from, held by the host so a reload keeps it. */
export type Meter = {
  samples: Sample[]
  /** The lifetime in use: the observed one when traffic proved it, else `baseTtl`. */
  ttl: Ttl
  /** The lifetime Claude Code's rules give (option, environment, setting, account). */
  baseTtl: Ttl
  /** Set by the `ttl` option; nothing overrides it. */
  pinned: boolean
  /** The lifetime request timing proved, or null. */
  observed: Ttl | null
  account: Account
  ttlSource: string
  envSource: string
  env: CacheEnv
  /** The promptCacheTtl setting, as read at session start. */
  setting: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'prompt-cache-control': {
      meter: Meter
      // The band steps aside while /cache is open.
      paneOpen: boolean
      // The bar above the prompt: /cache on, /cache off (kept in $.store).
      barOn: boolean
    }
  }
}
