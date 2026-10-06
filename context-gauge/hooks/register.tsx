// Context Gauge: one line under the prompt with repo/branch, model, effort and
// how much context is left. Replaces the old status line script.
//
//   my-project/main · Opus 5.5 1M · high  ████████████░░░░░░░░ 62% · 620K free  ·  5h 72% · 2:14:05  ·  wk 60%  ·  68 t/s
//
// `5h` is the plan's 5-hour usage window: what is left, draining from 100% to
// 0, and a countdown to its reset; `wk` is what is left of the weekly window.
// Both only on a subscription. `t/s` is how fast Claude writes: output tokens
// per second of the last few main-loop responses, timed from the first token.
//
// `/gauge` swaps that line for a detailed band above the prompt: one bar split
// by what fills the window (/context's categories and colours), and a key.
// `/gauge on` and `/gauge off` set it outright; the choice is kept.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GaugeBreakdown, GaugeCategory, GaugeLimit, GaugeReading } from '../types'

const EMPTY: GaugeReading = { model: '', effort: null, tokens: null, window: null, percent: null, place: null }

// Held by the host, so the reading survives a hot reload of this file.
const reading = atom({ plugin: 'context-gauge', key: 'reading' } as const, EMPTY)
const detail = atom({ plugin: 'context-gauge', key: 'detail' } as const, false)
const breakdown = atom({ plugin: 'context-gauge', key: 'breakdown' } as const, null as GaugeBreakdown | null)
const limits = atom({ plugin: 'context-gauge', key: 'limits' } as const, [] as GaugeLimit[])
const clock = atom({ plugin: 'context-gauge', key: 'now' } as const, 0)
const speed = atom({ plugin: 'context-gauge', key: 'speed' } as const, [] as number[])

// The countdown's ticker; a reload drops it and session.start starts another.
let lastTick = ''

// A breakdown is a local estimate, but a long turn calls tools often.
const BREAKDOWN_EVERY_MS = 3000

// A response shorter than this says little about speed (a lone tool call).
const SPEED_MIN_TOKENS = 50
// Responses averaged into the t/s figure.
const SPEED_SAMPLES = 3

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const settings = (await $.settings.read()) as Record<string, unknown>
    const effort = typeof settings.effortLevel === 'string' ? settings.effortLevel : null
    const model = await $.session.model()
    const place = await whereAmI($)
    await update($, reading, r => ({ ...r, model: r.model || model, effort: r.effort ?? effort, place }))
    await takeUsage($)
    await update($, clock, () => Date.now())
    lastTick = ''
    // Moves the clock only when the countdown's text would change.
    $.clock.every(1000, async () => {
      const now = Date.now()
      const label = countdown(await read($, limits), now)
      if (label === lastTick) return
      lastTick = label
      await update($, clock, () => now)
    })
    await $.command.register({
      name: 'gauge',
      description: 'Switch the context gauge between one line and the detailed breakdown',
      argumentHint: '[on|off]',
      immediate: true,
    })
    const isDetailed = (await $.store.get('detail')) === true
    await update($, detail, () => isDetailed)
    if (isDetailed) await takeBreakdown($, true)

    return result
  })

  on('command.run', { command: 'gauge' }, async ($, e) => {
    const word = e.args.trim().toLowerCase()
    if (word && !['on', 'off'].includes(word)) {
      return { text: 'Usage: /gauge [on|off]. Bare /gauge switches views.' }
    }
    const isDetailed = word ? word === 'on' : !(await read($, detail))
    await $.store.set('detail', isDetailed)
    await update($, detail, () => isDetailed)
    if (isDetailed) await takeBreakdown($, true)

    return {
      text: isDetailed
        ? 'Context gauge: detailed, above the prompt. /gauge off for the one line.'
        : 'Context gauge: one line under the prompt.',
    }
  })

  // The model and effort each main-loop request actually goes out with, and
  // how fast its response streams: output tokens over the time from the first
  // token (text, thinking or a tool call) to the end, so the wait before
  // Claude starts answering does not count against its speed.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    const effort = e.effort === undefined ? null : String(e.effort)
    await update($, reading, r => ({ ...r, model: e.model, effort }))

    const stream = next(e)
    let firstAt: number | undefined
    for (;;) {
      const n = await stream.next()
      if (n.done) {
        const out = n.value.usage?.output_tokens ?? 0
        if (firstAt !== undefined && out >= SPEED_MIN_TOKENS) {
          const seconds = ((await $.clock.now()) - firstAt) / 1000
          if (seconds > 0) await update($, speed, s => [...s, out / seconds].slice(-SPEED_SAMPLES))
        }
        return n.value
      }
      // the engine's own chunks (the envelope) come before any token
      if (firstAt === undefined && n.value.kind !== 'engine' && n.value.kind !== 'stop') firstAt = await $.clock.now()
      yield n.value
    }
  })

  // Pushed after every main-thread turn.
  on('session.measure', async ($, e, next) => {
    await setContext($, e.context)
    await setLimits($, e.rateLimits)
    await takeBreakdown($, true)

    return next(e)
  })

  // Keeps the gauge moving during a long turn, not only at its end.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) {
      await takeUsage($)
      await takeBreakdown($, false)
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) {
      const place = await whereAmI($)
      await update($, reading, r => ({ ...r, place }))
    }

    return result
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const engine = await next(e)
    if (await read($, detail)) {
      // The detailed view's key sits under the input, its bar right above it.
      const b = await read($, breakdown)
      if (!b) return engine
      const { Box, Text } = $.ui.resolve(e)

      return (
        <Box flexDirection="column">
          {legend(Box, Text, b, e.viewport?.columns ?? 120)}
          {engine}
        </Box>
      )
    }
    const r = await read($, reading)
    if (!r.model && r.percent === null) {
      return engine
    }
    const { Box, Text } = $.ui.resolve(e)
    const columns = e.viewport?.columns ?? 120
    const windows = await read($, limits)
    const five = windows.find(l => l.kind === 'five_hour')
    const week = windows.find(l => l.kind === 'seven_day')
    const now = await read($, clock)
    const tps = average(await read($, speed))

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          {gauge(Text, r, columns)}
          {five ? usage(Text, five, now, columns) : null}
          {week ? weekly(Text, week, now) : null}
          {tps !== null ? <Text dimColor>{`  ·  ${Math.round(tps)} t/s`}</Text> : null}
        </Box>
        {engine}
      </Box>
    )
  })

  // Composes: another mod (where-we-are) may draw in this band too. Theirs
  // goes first so the bar sits right on the input.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const others = await next(e)
    if (e.props.hasSurvey || !(await read($, detail))) return others
    const r = await read($, reading)
    const b = await read($, breakdown)
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {others}
        {band(Box, Text, r, b, e.props.bodyColumns)}
      </Box>
    )
  })
}

async function takeUsage($: EngineInterface) {
  const { context, rateLimits } = await $.session.usage()
  await setContext($, context)
  await setLimits($, rateLimits)
}

async function setLimits($: EngineInterface, windows: readonly { kind: string; percentUsed: number; resetsAt?: string }[]) {
  const next: GaugeLimit[] = windows.map(w => {
    const at = w.resetsAt ? Date.parse(w.resetsAt) : NaN
    return { kind: w.kind, percentUsed: w.percentUsed, resetsAt: Number.isFinite(at) ? at : null }
  })
  const was = await read($, limits)
  if (JSON.stringify(was) !== JSON.stringify(next)) await update($, limits, () => next)
}

// The 5-hour window's countdown text, or '' when there is none to show.
function countdown(windows: GaugeLimit[], now: number): string {
  const five = windows.find(l => l.kind === 'five_hour')
  if (!five?.resetsAt || five.resetsAt <= now) return ''
  return clockText(five.resetsAt - now)
}

function clockText(ms: number): string {
  const s = Math.ceil(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(sec).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`
}

// What is left of the weekly window, short: `wk 60%`.
function weekly(Text: any, week: GaugeLimit, now: number) {
  const left = leftOf(week, now)
  return [<Text dimColor>{'  ·  wk '}</Text>, <Text color={leftColor(left)}>{`${left}%`}</Text>]
}

// Percent of a window left, 0 to 100; a window past its reset reads full
// until the next response says more.
function leftOf(w: GaugeLimit, now: number): number {
  if (w.resetsAt !== null && w.resetsAt <= now) return 100
  return Math.max(0, Math.min(100, Math.round(100 - w.percentUsed)))
}

function leftColor(left: number): string {
  return left > 20 ? 'green' : left >= 10 ? 'yellow' : 'red'
}

function average(values: readonly number[]): number | null {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null
}

// What is left of the 5-hour window, draining from 100% to 0, and the time to
// its reset. Past the reset it reads full until the next response says more.
function usage(Text: any, five: GaugeLimit, now: number, columns: number) {
  const left = leftOf(five, now)
  const parts = [<Text dimColor>{'  ·  5h '}</Text>]
  parts.push(<Text color={leftColor(left)}>{`${left}%`}</Text>)
  const label = countdown([five], now)
  if (label) parts.push(<Text dimColor>{` · ${columns >= 100 ? label : label.replace(/^(\d+:\d\d):\d\d$/, '$1')}`}</Text>)

  return parts
}

async function setContext(
  $: EngineInterface,
  context: { tokens?: number; window: number; percent?: number } | undefined,
) {
  if (!context?.window) return
  const tokens = context.tokens ?? null
  const percent =
    context.percent ?? (tokens === null ? null : Math.round((tokens / context.window) * 100))
  await update($, reading, r => ({ ...r, tokens, window: context.window, percent }))
}

// Only while the detailed band shows; `force` skips the throttle.
async function takeBreakdown($: EngineInterface, force: boolean) {
  if (!(await read($, detail))) return
  const now = await $.clock.now()
  const last = await read($, breakdown)
  if (!force && last && now - last.takenAt < BREAKDOWN_EVERY_MS) return
  let usage
  try {
    usage = await $.session.usage({ breakdown: 'summary' })
  } catch {
    return
  }
  const found = usage.context.breakdown
  if (!found) return
  const categories: GaugeCategory[] = []
  for (const c of found.categories) {
    if (c.kind === 'deferred' || c.isDeferred) continue
    categories.push({ name: c.name, tokens: c.tokens, color: c.color, kind: c.kind })
  }
  await update($, breakdown, () => ({
    categories,
    totalTokens: found.totalTokens,
    rawMaxTokens: found.rawMaxTokens,
    percentage: found.percentage,
    takenAt: now,
  }))
}

async function whereAmI($: EngineInterface): Promise<string | null> {
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { timeoutMs: 3000 })
  if (top.exitCode !== 0) return null
  const repo = top.stdout.trim().split('/').pop() ?? ''
  const branch = await $.process.run(['git', 'branch', '--show-current'], { timeoutMs: 3000 })
  const name = branch.stdout.trim() || 'detached'

  return `${repo}/${name}`
}

function gauge(Text: any, r: GaugeReading, columns: number) {
  const parts = []
  if (r.place && columns >= 100) parts.push(<Text dimColor>{`${r.place} · `}</Text>)
  if (r.model) parts.push(<Text bold>{modelLabel(r.model)}</Text>)
  if (r.window) parts.push(<Text dimColor>{` ${short(r.window)}`}</Text>)
  if (r.effort) parts.push(<Text dimColor>{` · ${r.effort}`}</Text>)
  if (r.percent !== null && r.window) {
    const left = Math.max(0, 100 - r.percent)
    const free = Math.max(0, r.window - (r.tokens ?? 0))
    const color = left > 20 ? 'green' : left >= 10 ? 'yellow' : 'red'
    const width = columns >= 100 ? 20 : 10
    const filled = Math.min(width, Math.round((left * width) / 100))
    parts.push(<Text dimColor>{'  '}</Text>)
    parts.push(<Text color={color}>{'█'.repeat(filled)}</Text>)
    parts.push(<Text dimColor>{'░'.repeat(width - filled)}</Text>)
    parts.push(<Text color={color}>{` ${left}%`}</Text>)
    parts.push(<Text dimColor>{` · ${short(free)} free`}</Text>)
  }

  return parts
}

// The detailed band above the input: who and where, then the window as one
// bar split by category. Its key is `legend`, drawn under the input.
//
//   my-project/main · Opus 5.5 1M · high              38% used · 620K free
//   ███▓▓▓▓████████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▒▒▒▒
//   > prompt
//   ■ sys 4K  ■ tools 18K  ■ msgs 340K  ▒ buffer 33K
function band(Box: any, Text: any, r: GaugeReading, b: GaugeBreakdown | null, columns: number) {
  const who = []
  if (r.place && columns >= 70) who.push(<Text dimColor>{`${r.place} · `}</Text>)
  if (r.model) who.push(<Text bold>{modelLabel(r.model)}</Text>)
  if (r.window) who.push(<Text dimColor>{` ${short(r.window)}`}</Text>)
  if (r.effort) who.push(<Text dimColor>{` · ${r.effort}`}</Text>)

  if (!b) {
    return [
      <Box flexDirection="row">
        {who}
        <Text dimColor>{'  measuring context…'}</Text>
      </Box>,
    ]
  }

  const used = Math.min(100, Math.max(0, Math.round(b.percentage)))
  const left = 100 - used
  const color = left > 20 ? 'green' : left >= 10 ? 'yellow' : 'red'
  const free = b.categories.find(c => c.kind === 'free')?.tokens ?? Math.max(0, b.rawMaxTokens - b.totalTokens)
  const width = Math.max(10, Math.min(columns, 120))
  const cells = split(b.categories, width)

  return [
    <Box flexDirection="row" justifyContent="space-between" width={columns}>
      <Box flexDirection="row">{who}</Box>
      <Box flexDirection="row">
        <Text color={color} bold>{`${used}% used`}</Text>
        <Text dimColor>{` · ${short(free)} free`}</Text>
      </Box>
    </Box>,
    <Box flexDirection="row">
      {b.categories.map((c, i) =>
        cells[i] ? (
          c.kind === 'free' ? (
            <Text dimColor>{'░'.repeat(cells[i]!)}</Text>
          ) : (
            <Text color={c.color}>{(c.kind === 'buffer' ? '▒' : '█').repeat(cells[i]!)}</Text>
          )
        ) : null,
      )}
    </Box>,
  ]
}

// The bar's key, short labels wrapped to the width: `■ msgs 340K  ■ sys 4K`.
function legend(Box: any, Text: any, b: GaugeBreakdown, columns: number) {
  const shown = b.categories.filter(c => c.kind !== 'free' && c.tokens > 0)
  const lines: GaugeCategory[][] = [[]]
  let room = columns
  for (const c of shown) {
    const size = 2 + label(c).length + 1 + short(c.tokens).length + 2
    const line = lines[lines.length - 1]!
    if (line.length > 0 && size > room) {
      lines.push([c])
      room = columns - size
    } else {
      line.push(c)
      room -= size
    }
  }

  return lines.map(line => (
    <Box flexDirection="row">
      {line.flatMap(c => [
        <Text color={c.color}>{c.kind === 'buffer' ? '▒ ' : '■ '}</Text>,
        <Text>{label(c)}</Text>,
        <Text dimColor>{` ${short(c.tokens)}  `}</Text>,
      ])}
    </Box>
  ))
}

// Short display names for /context's rows; one it does not know keeps its
// first word. Display only: nothing branches on a row's name.
const LABELS: Record<string, string> = {
  'system prompt': 'sys',
  'system tools': 'tools',
  'mcp tools': 'mcp',
  'custom agents': 'agents',
  'memory files': 'memory',
  skills: 'skills',
  'slash commands': 'cmds',
  messages: 'msgs',
  'autocompact buffer': 'buffer',
}

function label(c: GaugeCategory): string {
  const name = c.name.toLowerCase()
  if (c.kind === 'buffer') return 'buffer'

  return LABELS[name] ?? name.split(/\s+/)[0] ?? name
}

// Cells per category that add up to exactly `width`: largest remainder, then
// a cell for any used category too small to round to one, taken from free.
function split(categories: GaugeCategory[], width: number): number[] {
  const total = categories.reduce((sum, c) => sum + c.tokens, 0)
  if (total <= 0) return categories.map(c => (c.kind === 'free' ? width : 0))
  const exact = categories.map(c => (c.tokens * width) / total)
  const cells = exact.map(Math.floor)
  let spare = width - cells.reduce((sum, n) => sum + n, 0)
  const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0])
  for (const [, i] of order) {
    if (spare <= 0) break
    cells[i]! += 1
    spare -= 1
  }
  const freeAt = categories.findIndex(c => c.kind === 'free')
  categories.forEach((c, i) => {
    if (c.kind === 'used' && c.tokens > 0 && cells[i] === 0 && freeAt >= 0 && cells[freeAt]! > 1) {
      cells[i] = 1
      cells[freeAt]! -= 1
    }
  })

  return cells
}

// Shows whatever id the engine reports; only recognized families get a short name.
function modelLabel(id: string): string {
  const lower = id.toLowerCase()
  const versioned = lower.match(/(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?!\d)/)
  if (versioned) {
    const [, name = '', major = '', minor] = versioned
    const family = capitalize(name)
    return minor ? `${family} ${major}.${minor}` : `${family} ${major}`
  }
  const alias = lower.match(/^(opus|sonnet|haiku|fable)\b/)
  if (alias) return capitalize(alias[1] ?? id)

  return id
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

function short(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}
