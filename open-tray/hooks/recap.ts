// The Recap tab, its plain parts: what we did, what the person has to do
// before work can go on, and what comes next by the plan we talked through.
// Two writers, both in register.tsx:
// - quick, on its own after a stretch of work: Haiku (`$.model.complete`).
//   It has no history, so it reads `digest`'s cut of the transcript and the
//   last recap (to keep the plan in view). Cheap enough to run often.
// - detailed, on request: `$.model.fork`, the session's own conversation on
//   the session's model, as the main loop last sent it, mostly from the cache.

import type { SessionMessage } from 'claude-code'

import type { Recap, Work } from '../types'

/**
 * Worth a quick recap: this many subagents, files changed, or main-loop tool
 * calls since the last one. Calls count because much editing goes through
 * Bash (sed, heredocs, scripts), which the file count cannot see.
 */
export const RECAP_AGENTS = 1
export const RECAP_FILES = 3
export const RECAP_CALLS = 12
export const KEEP = 5
export const QUICK_MODEL = 'haiku'
/** How much of the transcript the quick recap reads, newest kept first. */
export const DIGEST_CHARS = 40_000

const SHAPE = ['Answer with JSON alone, no prose around it:', '{"did": ["..."], "waiting": ["..."], "next": "..."}']
const WAITING =
  '- waiting: what the PERSON has to do before the work can go on (review something, test an app, decide, run a command), each one short line starting with a verb; [] when nothing waits on them.'

/** The detailed recap: asked of the session's own model, after its own conversation. */
export const ASK = [
  'Pause the work for a moment: the person wants a careful recap in their tray.',
  ...SHAPE,
  "- did: up to 6 lines, in plain words a newcomer gets (explain-like-I'm-5: no jargon, no file paths unless they matter), on what we got done in the latest stretch of work and why it matters.",
  WAITING,
  '- next: two or three sentences on what comes next by the plan we discussed; name the phase when the plan has phases, and what is still open.',
  'Do not use any tools.',
].join('\n')

/** The quick recap's system prompt: Haiku reads a cut of the transcript, not the conversation itself. */
export const QUICK_SYSTEM =
  'You write a quick recap of a coding session for the person working in it, from a cut of its transcript (PERSON is them, CLAUDE is their coding agent, [Tool] lines are what it ran). Use only what the transcript shows.'

/** The quick recap's one message: the transcript's cut, the last recap, then what to answer. */
export function quickAsk(transcript: string, last: Recap | undefined): string {
  const before = last
    ? ['<last_recap>', `next: ${last.next}`, ...last.waiting.map(w => `waiting: ${w}`), '</last_recap>', '']
    : []
  return [
    '<transcript>',
    transcript,
    '</transcript>',
    '',
    ...before,
    ...SHAPE,
    "- did: up to 4 short lines, in plain words a newcomer gets (explain-like-I'm-5: no jargon, no file paths unless they matter), on what got done in the latest stretch of work (the end of the transcript).",
    WAITING,
    '- next: one or two sentences on what comes next by the plan they discussed; name the phase when the plan has phases.',
  ].join('\n')
}

/** The transcript's tail as plain lines, at most about `max` characters, newest kept first. */
export function digest(messages: readonly SessionMessage[], max = DIGEST_CHARS): string {
  const cut = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}…` : text)
  const kept: string[] = []
  let size = 0
  for (let i = messages.length - 1; i >= 0 && size < max; i--) {
    const m = messages[i]!
    const lines: string[] = []
    if (m.text.trim()) lines.push(`${m.role === 'user' ? 'PERSON' : 'CLAUDE'}: ${cut(m.text.trim(), 2000)}`)
    for (const use of m.toolUses ?? []) lines.push(`  [${use.tool}] ${cut(gist(use.input), 160)}`)
    if (lines.length === 0) continue
    const block = lines.join('\n')
    kept.push(block)
    size += block.length + 1
  }
  return kept.reverse().join('\n')
}

/** What a tool call was about, in one line: its file, command or description. */
function gist(input: Record<string, unknown>): string {
  for (const key of ['file_path', 'command', 'description', 'pattern', 'url', 'query', 'prompt']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value.trim().replace(/\s+/g, ' ')
  }
  return ''
}

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

export function isWorth(work: Work): boolean {
  return work.agents >= RECAP_AGENTS || work.files.length >= RECAP_FILES || (work.calls ?? 0) >= RECAP_CALLS
}

/** How far the work is toward the next quick recap, for the Recap tab. */
export function progress(work: Work): string {
  return `Next quick recap: ${work.files.length}/${RECAP_FILES} files, ${work.calls ?? 0}/${RECAP_CALLS} steps, or a subagent.`
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
    const next = typeof json.next === 'string' ? json.next.trim().slice(0, 600) : ''
    return { at, did: lines(json.did, 6), waiting: lines(json.waiting, 8), next, isAsked }
  } catch {
    return { at, did: [text.trim().slice(0, 400)], waiting: [], next: '', isAsked }
  }
}
