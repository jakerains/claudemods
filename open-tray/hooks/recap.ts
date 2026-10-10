// The Recap tab, its plain parts: after a big move (subagents, a lot of files
// changed), a short note in plain words of what we did, what the person has
// to do before work can go on, and what comes next by the plan we talked
// through. register.tsx writes it with `$.model.fork`: the session's own
// conversation, as the main loop last sent it, with ASK after it, so it knows
// the plan without the mod rebuilding it, and most of it reads from the cache.

import type { Recap, Work } from '../types'

/** A big move: this many subagents, or this many files changed, since the last recap. */
export const BIG_AGENTS = 2
export const BIG_FILES = 8
export const KEEP = 5

export const ASK = [
  'Pause the work for a moment: the person wants a quick recap in their tray. Answer with JSON alone, no prose around it:',
  '{"did": ["..."], "waiting": ["..."], "next": "..."}',
  "- did: up to 4 short lines, in plain words a newcomer gets (explain-like-I'm-5: no jargon, no file paths unless they matter), on what we got done in the latest stretch of work.",
  '- waiting: what the PERSON has to do before the work can go on (review something, test an app, decide, run a command), each one short line starting with a verb; [] when nothing waits on them.',
  '- next: one or two sentences on what comes next by the plan we discussed; name the phase when the plan has phases.',
  'Do not use any tools.',
].join('\n')

/** A bar of `width` cells with a light bouncing along it, at step `step`: ░▒▓█▓▒░. */
export function scanner(step: number, width: number): string {
  const span = Math.max(1, width - 1)
  const at = Math.abs(((step % (2 * span)) + 2 * span) % (2 * span) - span)
  const head = span - at
  return Array.from({ length: width }, (_, i) => ['█', '▓', '▒'][Math.abs(i - head)] ?? '░').join('')
}

/** A spinner frame for step `step`. */
export function spinner(step: number): string {
  const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
  return frames[((step % frames.length) + frames.length) % frames.length]!
}

export function isBig(work: Work): boolean {
  return work.agents >= BIG_AGENTS || work.files.length >= BIG_FILES
}

/** The model's JSON, read leniently; prose that is not JSON becomes the "did" line. */
export function parse(text: string, at: number, isAsked: boolean): Recap {
  const lines = (value: unknown, max: number) =>
    (Array.isArray(value) ? value : [])
      .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
      .map(v => v.trim().slice(0, 300))
      .slice(0, max)
  try {
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as Record<string, unknown>
    const next = typeof json.next === 'string' ? json.next.trim().slice(0, 500) : ''
    return { at, did: lines(json.did, 5), waiting: lines(json.waiting, 8), next, isAsked }
  } catch {
    return { at, did: [text.trim().slice(0, 400)], waiting: [], next: '', isAsked }
  }
}
