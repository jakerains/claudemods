// What the tray knows about a project: an optional rules file says how to tell
// which area we're working on and where that area's good stuff lives. Without
// one, the area is the folder Claude has been working in, and "related" is
// the newest media, pages and PDFs inside it.
//
// Rules are read from the project's own `.claude/tray.json`, else from the
// person's own `~/.claude/open-tray/rules/<repo folder name>.json`. The plugin
// ships no project's rules, only `examples/tray.json` to copy from.

import type { TrayAction, TrayItem, TrayKind } from '../types'

export type AreaRule = { key: string; label: string; patterns: string[]; pad?: number }
export type RelatedRule = {
  label: string
  paths: string[]
  names: string[]
  as?: 'file' | 'folder'
  /** Show one per folder (its index.html when there is one). */
  onePerFolder?: boolean
  pathMatch?: string
  maxDepth?: number
  max?: number
}
export type Rules = {
  areas?: AreaRule[]
  tag?: string
  skip?: string[]
  related?: RelatedRule[]
  actions?: { label: string; each: string; prompt: string }[]
  servers?: { spot: string }
}

const DEFAULT_SKIP = ['/node_modules/', '/.git/', '/dist/', '/build/', '/.next/', '/archive/', '/.cache/']
const DEFAULT_NAMES = ['*.mp4', '*.mov', '*.webm', '*.mp3', '*.wav', '*.m4a', '*.png', '*.jpg', '*.jpeg', '*.gif', '*.pdf', '*.html']

export const KINDS: Record<string, TrayKind> = {
  mp4: 'video', mov: 'video', webm: 'video', m4v: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio', ogg: 'audio',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image',
  html: 'page', htm: 'page',
  pdf: 'doc', md: 'doc', txt: 'doc', json: 'doc',
}

/** Where a project's rules may be: its own file first, then the person's own rules folder. */
export function rulesPaths(root: string, home: string): string[] {
  return [`${root}/.claude/tray.json`, `${home}/.claude/open-tray/rules/${baseName(root)}.json`]
}

/**
 * Commands that start a local server, for every project: package-manager dev,
 * start, serve and preview scripts, and the common servers run directly.
 * A project's rules may add its own (`servers.spot`).
 */
export const DEFAULT_SERVER_SPOT =
  '\\b(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?(?:dev|start|serve|preview|storybook)\\b|\\b(?:vite|next\\s+dev|astro\\s+dev|http-server|live-server|serve)\\b|\\bpython3?\\s+-m\\s+http\\.server\\b'

/** Does this command start a server worth watching? */
export function startsServer(command: string, rules: Rules | null): boolean {
  const text = command.slice(0, MAX_TEXT)
  if (new RegExp(DEFAULT_SERVER_SPOT).test(text)) return true
  return Boolean(regexOf(rules?.servers?.spot)?.test(text))
}

// Best effort only: no check can tell every slow pattern from a fast one, so
// the boundary is that rules run only once chosen (your own file, or a repo's
// you trusted with /tray trust). Within that, text is cut short, and a pattern
// that is too long, invalid, or nests quantifiers (`(a+)+`) is ignored.
const MAX_TEXT = 2000
const MAX_PATTERN = 300
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/
const compiled = new Map<string, RegExp | null>()

export function regexOf(pattern: unknown, flags = ''): RegExp | null {
  if (typeof pattern !== 'string' || !pattern || pattern.length > MAX_PATTERN) return null
  const key = `${flags}/${pattern}`
  if (!compiled.has(key)) {
    let re: RegExp | null = null
    if (!NESTED_QUANTIFIER.test(pattern)) {
      try {
        re = new RegExp(pattern, flags)
      } catch {
        re = null
      }
    }
    compiled.set(key, re)
  }
  return compiled.get(key) ?? null
}

/** A search depth from the rules, whatever they hold: a whole number from 1 to 12. */
export function depthOf(value: unknown, fallback = 6): number {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) ? Math.min(12, Math.max(1, n)) : fallback
}

export type Area = { key: string; label: string; values: Record<string, string> }

/** The area a piece of text (a prompt, a path) points at, by the rules' patterns. */
export function areaIn(text: string, rules: Rules | null): Area | null {
  for (const rule of rules?.areas ?? []) {
    for (const pattern of rule.patterns) {
      const match = regexOf(pattern, 'i')?.exec(text.slice(0, MAX_TEXT))
      const raw = match?.slice(1).find(Boolean)
      if (!raw) continue
      const n = String(Number(raw))
      const padded = n.padStart(rule.pad ?? 0, '0')
      const values = { '1': padded, '1n': n }
      return { key: fill(rule.key, values), label: fill(rule.label, values), values }
    }
  }

  return null
}

/** Without rules: the folder (two levels under the repo root) a path sits in. */
export function folderArea(path: string, root: string): Area | null {
  if (!path.startsWith(`${root}/`)) return null
  const parts = path.slice(root.length + 1).split('/').slice(0, -1).slice(0, 2)
  if (parts.length === 0) return null
  const key = parts.join('/')

  return { key, label: key, values: { '1': key, '1n': key } }
}

export function tagOf(text: string, rules: Rules | null): string | null {
  if (!rules?.tag) return null
  return regexOf(rules.tag, 'i')?.exec(text.slice(0, MAX_TEXT))?.[0].toLowerCase() ?? null
}

export function kindOf(path: string): TrayKind {
  return KINDS[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'other'
}

export function baseName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() ?? path
}

/** The searches for an area: the rules' groups, or the generic newest-in-this-folder scan. */
export function relatedPlan(area: Area, rules: Rules | null): (RelatedRule & { pattern: RegExp | null })[] {
  const list: RelatedRule[] = rules?.related?.length
    ? rules.related
    : [{ label: 'Newest here', paths: [area.key], names: DEFAULT_NAMES, maxDepth: 4, max: 8 }]

  return list.map(rule => ({
    ...rule,
    paths: rule.paths.map(p => fill(p, area.values)),
    names: rule.names.map(n => fill(n, area.values)),
    // The area's values come from prompts and paths: escaped, so they match as text.
    pattern: rule.pathMatch ? regexOf(fill(rule.pathMatch, escapedValues(area.values)), 'i') : null,
  }))
}

export function skipList(rules: Rules | null): string[] {
  return [...DEFAULT_SKIP, ...(rules?.skip ?? [])]
}

/** Builds a group from search results (paths relative to the root, newest first). */
export function groupItems(
  rule: RelatedRule,
  dated: { path: string; mtime: number }[],
  root: string,
  rules: Rules | null,
  now: number,
): TrayItem[] {
  const dirOf = (path: string) => path.split('/').slice(0, -1).join('/')
  // One per folder: the folder's index.html wins, else its newest file.
  const picked = rule.onePerFolder
    ? [...new Map(dated.map(d => [dirOf(d.path), dated.find(x => dirOf(x.path) === dirOf(d.path) && /\/index\.html?$/i.test(x.path)) ?? d])).values()]
    : dated
  const targets: { target: string; mtime: number }[] = []
  const seen = new Set<string>()
  for (const { path, mtime } of picked) {
    const target = rule.as === 'folder' ? dirOf(path) : path
    if (seen.has(target)) continue
    seen.add(target)
    targets.push({ target, mtime })
  }
  // As folders, keep the deepest: a folder that holds another listed one is dropped.
  const kept = rule.as === 'folder' ? targets.filter(t => !targets.some(o => o.target.startsWith(`${t.target}/`))) : targets

  return kept.slice(0, rule.max ?? 6).map(({ target, mtime }) => ({
    target: `${root}/${target}`,
    label: rule.as === 'folder' ? `${baseName(target)}/` : baseName(target),
    kind: rule.as === 'folder' ? 'folder' : kindOf(target),
    tag: tagOf(target, rules),
    addedAt: Math.min(now, mtime),
  }))
}

/** The actions for an area (one per matching folder), from the folders the shell found. */
export function actionsFor(action: { label: string; prompt: string }, area: Area, dirs: string[]): TrayAction[] {
  return dirs.map(dir => {
    const values = { ...area.values, each: baseName(dir) }
    return { label: fill(action.label, values), prompt: fill(action.prompt, values) }
  })
}

export function actionPattern(each: string, area: Area): string {
  return fill(each, area.values)
}

/** `find` over shell-expanded paths (the rules' own globs), names matched case-insensitively. */
export function findScript(root: string, paths: string[], names: string[], depth: unknown): string {
  // Everything from the rules is quoted; the depth goes in bare, so it is a number here.
  const nameTest = names.map(n => `-iname ${quote(n)}`).join(' -o ')
  return `cd ${quote(root)} && for d in ${paths.map(globWord).join(' ')}; do [ -d "$d" ] && find "$d" -maxdepth ${depthOf(depth)} \\( -type f -o -type l \\) \\( ${nameTest} \\) -print; done 2>/dev/null | head -2000`
}

export function dirsScript(root: string, pattern: string): string {
  return `cd ${quote(root)} && for d in ${globWord(pattern)}; do [ -d "$d" ] && echo "$d"; done`
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole)
}

function escapedValues(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')]))
}

function quote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

// Quotes everything but the glob characters, so the shell expands `*` and nothing else.
function globWord(pattern: string): string {
  return pattern
    .split(/(\*|\?)/)
    .map(part => (part === '*' || part === '?' ? part : part ? quote(part) : ''))
    .join('')
}
