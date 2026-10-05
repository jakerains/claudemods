// Open Tray: a pane of things to look at or listen to, in two sections.
//
// - Made this session: what Claude opened, rendered or handed over, plus
//   anything the person kept. These stay until removed.
// - Related to what we're on: found for the area being worked on (a module, a
//   folder) and swapped out when the area changes. A project's rules file says
//   how to spot its areas and where their good stuff lives (rules.ts); without
//   one, the area is the folder Claude works in.
//
// Nothing here is project-specific: projects bring their own rules (a repo's
// `.claude/tray.json`, or `~/.claude/open-tray/rules/<repo>.json`).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Related, RelatedGroup, ReviewPlayer, TrayAction, TrayItem } from '../types'
import {
  actionPattern,
  actionsFor,
  areaIn,
  baseName,
  dirsScript,
  findScript,
  folderArea,
  groupItems,
  kindOf,
  relatedPlan,
  rulesPaths,
  skipList,
  startsServer,
  tagOf,
} from './rules'
import type { Area, Rules } from './rules'

const PANE = 'open-tray'
const MAX_ITEMS = 50
const FRESH_MS = 15 * 60_000
const CHECK_MS = 20_000
// The area changes after this many of the last WINDOW votes point at it.
const SWITCH_VOTES = 3
const WINDOW = 8
const REFRESH_GAP_MS = 60_000

const NO_RELATED: Related = { area: null, label: '', groups: [], actions: [], suggested: [] }

// Held by the host, so the tray survives a hot reload of this file.
const items = atom({ plugin: 'open-tray', key: 'items' } as const, [])
const selected = atom({ plugin: 'open-tray', key: 'selected' } as const, 0)
const players = atom({ plugin: 'open-tray', key: 'players' } as const, [])
const related = atom({ plugin: 'open-tray', key: 'related' } as const, NO_RELATED)
const signals = atom({ plugin: 'open-tray', key: 'signals' } as const, [])
const hidden = atom({ plugin: 'open-tray', key: 'hidden' } as const, [])

const ICONS: Record<TrayItem['kind'], string> = {
  video: '▶', audio: '♪', image: '▣', page: '◧', doc: '≡', folder: '▤', url: '↗', other: '·',
}
// One small palette: a violet accent, soft greys, and a colour per kind.
const THEME = {
  accent: '#a78bfa',
  onAccent: '#14121c',
  picked: '#26243a',
  sub: '#b8b5c8',
  faint: '#6e6a80',
  rule: '#3a3750',
  go: '#4ade80',
  stop: '#f87171',
}
const KIND_COLORS: Record<TrayItem['kind'], string> = {
  video: '#f472b6',
  audio: '#22d3ee',
  image: '#fbbf24',
  page: '#60a5fa',
  doc: '#cbd5e1',
  folder: '#34d399',
  url: '#38bdf8',
  other: '#94a3b8',
}
const MEDIA_PATH = /(?:~|\/)[^\s'"`<>|;,()\]]+\.(?:mp4|mov|webm|m4v|mp3|wav|m4a|aac|flac|ogg|png|jpe?g|gif|webp|pdf)\b/gi
const LOCAL_URL = /https?:\/\/(?:127\.0\.0\.1|localhost|[\w.-]+\.localhost)(?::\d+)?(?:\/[^\s'"`)\]<>]*)?/g
const OUTPUT_FILE = /\/[^\s'"`]+\/tasks\/[\w-]+\.output\b/

// This load's view of the project: its root and rules, read at session start.
let root = ''
let rules: Rules | null = null
let lastRefreshAt = 0

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    root = (await $.session.repo())?.root ?? (await $.session.root())
    rules = await loadRules($, root)
    await $.command.register({
      name: 'tray',
      description: 'Show the Open Tray: things made for you this session, and things related to what we are working on',
      immediate: true,
    })
    await $.tool.register({
      name: 'offer',
      description:
        "Put a file, folder or local URL in the user's Open Tray pane, where they open it, reveal it in Finder or play a film's audio alone. " +
        'Use it for anything you produced for the user to look at, listen to or read (renders, audio takes, screenshots, review sheets, ' +
        'scripts, local review URLs), and with suggest: true for existing things you think they will want for the current task. ' +
        'Paths must be absolute.',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Absolute path, or an http(s) URL' },
          label: { type: 'string', description: 'Short name to show; defaults to the file name' },
          suggest: {
            type: 'boolean',
            description: 'true: list it under "Related to what we are on" (it goes when the work moves on). false or absent: "Made this session" (it stays).',
          },
        },
        required: ['target'],
      },
    })
    $.clock.every(CHECK_MS, () => void checkPlayers($))

    return result
  })

  // What the person asks about votes for an area, and a clear mention switches at once.
  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    if (e.origin.kind === 'composer') {
      const area = areaIn(e.text, rules)
      if (area) await vote($, area, true)
    }

    return result
  })

  on('tool.call', { tool: 'mcp__open-tray__offer' }, async ($, e) => {
    const input = e as unknown as { target?: unknown; label?: unknown; suggest?: unknown }
    const target = typeof input.target === 'string' ? input.target.trim() : ''
    if (!target) {
      return { result: 'target is required', isError: true }
    }
    const label = typeof input.label === 'string' ? input.label : undefined
    const item = await itemFor($, target, label)
    if (!item) {
      return { result: `Not found: ${target}` }
    }
    if (input.suggest === true) {
      await update($, related, r => ({ ...r, suggested: [item, ...r.suggested.filter(s => s.target !== item.target)].slice(0, 8) }))
      return { result: `Suggested in the Open Tray: ${item.label}` }
    }
    await addItem($, item, true)

    return { result: `In the Open Tray: ${item.label}` }
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if ('deny' in result && result.deny) {
      return result
    }
    const input = e as unknown as Record<string, unknown>

    // The files Claude works on vote for the area.
    if (!e.agentId) {
      const path = String(input.file_path ?? input.path ?? input.notebook_path ?? '')
      if (path.startsWith('/')) {
        const area = areaIn(path, rules) ?? (rules?.areas?.length ? null : folderArea(path, root))
        if (area) await vote($, area, false)
      }
    }

    if (e.tool === 'Bash') {
      const command = String(input.command ?? '')
      const output = typeof result.text === 'string' ? result.text : ''
      const cwd = await $.session.cwd()
      for (const target of openTargets(command, cwd)) {
        const item = await itemFor($, target)
        if (item) await addItem($, item, false)
      }
      const now = await $.clock.now()
      for (const path of new Set(output.match(MEDIA_PATH) ?? [])) {
        const full = await expandHome($, path)
        try {
          const stat = await $.fs.stat(full)
          if (stat.kind === 'file' && now - stat.mtimeMs < FRESH_MS) {
            const item = await itemFor($, full)
            if (item) await addItem($, item, false)
          }
        } catch {
          // Printed, but not on disk.
        }
      }
      if (startsServer(command, rules)) {
        const tag = tagOf(command, rules)
        await notePlayers($, output, tag)
        const outFile = output.match(OUTPUT_FILE)?.[0]
        if (outFile) {
          for (const wait of [4000, 12000, 30000]) {
            $.clock.after(wait, () => void readOutputFile($, outFile, tag))
          }
        }
      }
    }

    return result
  })

  // New renders land during a turn; look again once it ends (at most once a minute).
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const r = await read($, related)
    const now = await $.clock.now()
    if (!e.agentId && r.area && now - lastRefreshAt > REFRESH_GAP_MS) {
      const area = areaFromKey(r.area, await read($, signals))
      if (area) await refresh($, area)
    }

    return result
  })

  on('command.run', { command: 'tray' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Open Tray', focus: true })
    const count = (await read($, items)).length
    const r = await read($, related)

    return {
      text: opened.isPlaced
        ? `Open Tray: ${count} made this session${r.area ? `, ${r.label} related` : ''}.`
        : 'Open Tray could not be placed; widen the terminal.',
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const mine = await read($, items)
    const r = await read($, related)
    const away = new Set(await read($, hidden))
    const live = await read($, players)
    const now = await $.clock.now()
    const columns = e.props.bodyColumns
    const rows = flatten(mine, r, away)
    const pick = Math.min(await read($, selected), Math.max(0, rows.length - 1))
    const stopped = live.find(p => !p.isAlive)
    const mineCount = rows.filter(row => row.place === 'mine').length
    const areaCount = rows.length - mineCount

    const title = (text: string, count: number) => (
      <Box flexDirection="row" marginTop={1}>
        <Text bold color={THEME.accent}>{text.toUpperCase()}</Text>
        <Text color={THEME.faint}>{` ${count} `}</Text>
        <Text color={THEME.rule}>{'─'.repeat(Math.max(0, columns - text.length - String(count).length - 2))}</Text>
      </Box>
    )

    const line = (index: number) => {
      const row = rows[index]!
      const isPicked = index === pick
      const bar = <Text color={THEME.accent}>{isPicked ? '▌' : ' '}</Text>
      if (row.kind === 'action') {
        return (
          <Box flexDirection="row" backgroundColor={isPicked ? THEME.picked : undefined}>
            {bar}
            <Text color={THEME.go}>{' ⏵ '}</Text>
            <Button key={`row-${index}`} plain label={clip(row.action.label, columns - 5)} onPress={() => void runRow($, index)} />
          </Box>
        )
      }
      const meta = `${row.item.tag ? `${row.item.tag}  ` : ''}${ago(now - row.item.addedAt)}`
      return (
        <Box flexDirection="row" justifyContent="space-between" width={columns} backgroundColor={isPicked ? THEME.picked : undefined}>
          <Box flexDirection="row" flexShrink={1}>
            {bar}
            <Text color={KIND_COLORS[row.item.kind]}>{` ${ICONS[row.item.kind]} `}</Text>
            <Button
              key={`row-${index}`}
              plain
              label={clip(row.item.label, Math.max(8, columns - meta.length - 7))}
              onPress={() => void runRow($, index)}
            />
          </Box>
          <Text color={THEME.faint}>{` ${meta} `}</Text>
        </Box>
      )
    }

    // The area's rows, under a small heading per group.
    const areaLines: RenderChildren[] = []
    let lastGroup = ''
    rows.forEach((row, index) => {
      if (row.place !== 'area') return
      if (row.group !== lastGroup) {
        areaLines.push(<Text color={THEME.sub}>{`  ${row.group}`}</Text>)
        lastGroup = row.group
      }
      areaLines.push(line(index))
    })

    return (
      <Box flexDirection="column" width={columns}>
        <Box flexDirection="row" justifyContent="space-between" width={columns}>
          <Text bold>
            <Text color={THEME.accent}>{'◆ '}</Text>
            {'Open Tray'}
          </Text>
          {r.label ? (
            <Text backgroundColor={THEME.accent} color={THEME.onAccent} bold>{` ${r.label} `}</Text>
          ) : (
            <Text color={THEME.faint}>{'following your work'}</Text>
          )}
        </Box>

        {rows.length === 0 && (
          <Box flexDirection="column" marginTop={1} paddingX={1}>
            <Text color={THEME.sub}>{'Nothing here yet.'}</Text>
            <Text color={THEME.faint} wrap="wrap">
              {'Films, audio, images and pages I make for you land here. As we work, things related to what we are on show up below.'}
            </Text>
          </Box>
        )}

        {mineCount > 0 && title('Made this session', mineCount)}
        {rows.map((row, index) => (row.place === 'mine' ? line(index) : null))}

        {areaCount > 0 && title(r.label || 'Related', areaCount)}
        {areaLines}

        {rows.length > 0 && (
          <Box flexDirection="row" flexWrap="wrap" marginTop={1}>
            <Button key="open" plain hotkey="o" label="open   " onPress={() => void runRow($, pick)} />
            <Button key="finder" plain hotkey="f" label="Finder   " onPress={() => void act($, pick, 'finder')} />
            <Button key="audio" plain hotkey="a" label="audio   " onPress={() => void act($, pick, 'audio')} />
            <Button key="keep" plain hotkey="p" label="keep   " onPress={() => void keep($, pick)} />
            <Button key="remove" plain hotkey="x" label="remove   " onPress={() => void remove($, pick)} />
            <Button key="down" plain hotkey="j" label="down   " onPress={() => void move($, 1)} />
            <Button key="up" plain hotkey="k" label="up" onPress={() => void move($, -1)} />
          </Box>
        )}

        {live.length > 0 && (
          <Box flexDirection="column" borderStyle="round" borderColor={THEME.rule} paddingX={1} marginTop={1}>
            <Text bold color={THEME.sub}>{'Local servers'}</Text>
            {live.map((player, index) => (
              <Box flexDirection="row">
                <Text color={player.isAlive ? THEME.go : THEME.stop}>{player.isAlive ? '● ' : '○ '}</Text>
                <Button
                  key={`player-${index}`}
                  plain
                  dimColor={!player.isAlive}
                  label={`${player.tag ?? 'player'}  ${player.url}`}
                  onPress={() => void $.process.run(['open', player.url])}
                />
                {!player.isAlive && <Text color={THEME.stop}>{'  stopped'}</Text>}
              </Box>
            ))}
            {stopped && (
              <Button key="restart" plain hotkey="r" label={`restart ${stopped.tag ?? stopped.url}`} onPress={() => void restart($, stopped)} />
            )}
          </Box>
        )}
      </Box>
    )
  })
}

// ── The list ─────────────────────────────────────────────────────────────────

type Row =
  | { kind: 'item'; place: 'mine' | 'area'; group: string; item: TrayItem; mine: boolean }
  | { kind: 'action'; place: 'area'; group: string; action: TrayAction }

function flatten(mine: TrayItem[], r: Related, away: Set<string>): Row[] {
  const rows: Row[] = mine.map(item => ({ kind: 'item', place: 'mine', group: '', item, mine: true }))
  const taken = new Set(mine.map(m => m.target))
  const fresh = (item: TrayItem) => !taken.has(item.target) && !away.has(item.target)
  for (const item of r.suggested.filter(fresh)) rows.push({ kind: 'item', place: 'area', group: 'Suggested', item, mine: false })
  for (const group of r.groups) {
    for (const item of group.items.filter(fresh)) rows.push({ kind: 'item', place: 'area', group: group.label, item, mine: false })
  }
  for (const action of r.actions) rows.push({ kind: 'action', place: 'area', group: 'Start', action })

  return rows
}

async function rowsNow($: EngineInterface): Promise<Row[]> {
  return flatten(await read($, items), await read($, related), new Set(await read($, hidden)))
}

async function runRow($: EngineInterface, index: number) {
  const row = (await rowsNow($))[index]
  if (!row) return
  await update($, selected, () => index)
  if (row.kind === 'action') {
    await $.prompt.submit({ text: row.action.prompt })
    return
  }
  await $.process.run(['open', row.item.target])
}

async function act($: EngineInterface, index: number, action: 'finder' | 'audio') {
  const row = (await rowsNow($))[index]
  if (!row || row.kind !== 'item') return
  await update($, selected, () => index)
  const item = row.item
  if (action === 'finder') {
    if (item.kind === 'url') {
      $.ui.toast('A URL has no Finder location')
      return
    }
    await $.process.run(['open', '-R', item.target])
    return
  }
  if (item.kind === 'audio') {
    await $.process.run(['open', item.target])
    return
  }
  if (item.kind !== 'video') {
    $.ui.toast('Audio only works on a film or an audio file')
    return
  }
  const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/$/, '')
  const out = `${tmp}/open-tray/${baseName(item.target).replace(/\.[^.]+$/, '')}.m4a`
  await $.fs.write(`${tmp}/open-tray/.keep`, '')
  $.ui.toast(`Pulling the audio out of ${item.label}…`)
  const run = await $.process.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', item.target, '-vn', '-c:a', 'aac', '-b:a', '192k', out], {
    timeoutMs: 180_000,
  })
  if (run.exitCode !== 0) {
    $.ui.toast(`ffmpeg could not pull the audio: ${run.stderr.trim().split('\n').pop() ?? ''}`)
    return
  }
  await $.process.run(['open', out])
}

// Keep: a related item moves up to "Made this session", so it stays when the area changes.
async function keep($: EngineInterface, index: number) {
  const row = (await rowsNow($))[index]
  if (!row || row.kind !== 'item' || row.mine) return
  await addItem($, { ...row.item, addedAt: await $.clock.now() }, false)
  $.ui.toast(`Kept: ${row.item.label}`)
}

async function remove($: EngineInterface, index: number) {
  const row = (await rowsNow($))[index]
  if (!row || row.kind !== 'item') return
  if (row.mine) await update($, items, list => list.filter(i => i.target !== row.item.target))
  else await update($, hidden, list => [...list, row.item.target].slice(-200))
  await update($, selected, n => Math.max(0, n - (n >= index ? 1 : 0)))
}

async function move($: EngineInterface, by: number) {
  const count = (await rowsNow($)).length
  await update($, selected, n => Math.min(Math.max(0, n + by), Math.max(0, count - 1)))
}

// ── Items ────────────────────────────────────────────────────────────────────

async function itemFor($: EngineInterface, raw: string, label?: string): Promise<TrayItem | null> {
  const now = await $.clock.now()
  if (/^https?:\/\//.test(raw)) {
    return { target: raw, label: label ?? raw.replace(/^https?:\/\//, ''), kind: 'url', tag: tagOf(raw, rules), addedAt: now }
  }
  const path = await expandHome($, raw)
  try {
    const stat = await $.fs.stat(path)
    return {
      target: path,
      label: label ?? baseName(path),
      kind: stat.kind === 'dir' ? 'folder' : kindOf(path),
      tag: tagOf(path, rules),
      addedAt: now,
    }
  } catch {
    return null
  }
}

async function addItem($: EngineInterface, item: TrayItem, isAsked: boolean) {
  await update($, items, list => [item, ...list.filter(one => one.target !== item.target)].slice(0, MAX_ITEMS))
  await update($, selected, () => 0)
  const isUp = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced)
  if (isUp) return
  const opened = await $.ui.open({ id: PANE, title: 'Open Tray' })
  if (!opened.isPlaced && isAsked) {
    $.ui.toast(`Open Tray: ${item.label}  (/tray to show)`)
  }
}

// ── The area ─────────────────────────────────────────────────────────────────

// A vote for an area; enough recent votes (or a prompt naming it) switch the tray to it.
async function vote($: EngineInterface, area: Area, isClear: boolean) {
  const votes = await update($, signals, list => [...list, area.key].slice(-WINDOW))
  const r = await read($, related)
  if (r.area === area.key) return
  const count = votes.filter(v => v === area.key).length
  if (isClear || count >= SWITCH_VOTES) {
    await update($, related, () => ({ ...NO_RELATED, area: area.key, label: area.label }))
    await update($, hidden, () => [])
    await refresh($, area)
  }
}

// Rebuilds an Area from its key: by the rules' patterns, or as a folder.
function areaFromKey(key: string, _votes: string[]): Area | null {
  return areaIn(key, rules) ?? (rules?.areas?.length ? null : { key, label: key, values: { '1': key, '1n': key } })
}

async function refresh($: EngineInterface, area: Area) {
  const now = await $.clock.now()
  lastRefreshAt = now
  const skip = skipList(rules)
  const groups: RelatedGroup[] = []
  for (const rule of relatedPlan(area, rules)) {
    const run = await $.process.run(['/bin/sh', '-c', findScript(root, rule.paths, rule.names, rule.maxDepth ?? 6)], { timeoutMs: 15_000 })
    const found = run.stdout
      .split('\n')
      .map(line => line.replace(/^\.\//, ''))
      .filter(path => path && !skip.some(s => `/${path}`.includes(s)) && (!rule.pattern || rule.pattern.test(path)))
    const dated: { path: string; mtime: number }[] = []
    for (const path of found.slice(0, 300)) {
      try {
        dated.push({ path, mtime: (await $.fs.stat(`${root}/${path}`)).mtimeMs })
      } catch {
        // Gone since the search.
      }
    }
    dated.sort((a, b) => b.mtime - a.mtime)
    const groupList = groupItems(rule, dated, root, rules, now)
    if (groupList.length > 0) groups.push({ label: rule.label, items: groupList })
  }
  const actions: TrayAction[] = []
  for (const action of rules?.actions ?? []) {
    const run = await $.process.run(['/bin/sh', '-c', dirsScript(root, actionPattern(action.each, area))], { timeoutMs: 5_000 })
    actions.push(...actionsFor(action, area, run.stdout.split('\n').filter(Boolean).sort()))
  }
  await update($, related, r => (r.area === area.key ? { ...r, groups, actions } : r))
}

async function loadRules($: EngineInterface, projectRoot: string): Promise<Rules | null> {
  const home = (await $.env.get('HOME')) ?? ''
  for (const path of rulesPaths(projectRoot, home)) {
    try {
      return JSON.parse(await $.fs.read(path)) as Rules
    } catch {
      // Not there, or not valid JSON: try the next one.
    }
  }

  return null
}

// ── Review players ───────────────────────────────────────────────────────────

async function notePlayers($: EngineInterface, text: string, tag: string | null) {
  const urls = [...new Set(text.match(LOCAL_URL) ?? [])].map(url => url.replace(/[.,]+$/, ''))
  if (urls.length === 0) return
  await update($, players, list => {
    const kept = list.filter(p => !urls.includes(p.url))
    return [...urls.map(url => ({ url, tag: tag ?? tagOf(url, rules), isAlive: true })), ...kept].slice(0, 12)
  })
}

async function readOutputFile($: EngineInterface, path: string, tag: string | null) {
  try {
    await notePlayers($, await $.fs.read(path), tag)
  } catch {
    // Not written yet, or already cleaned up.
  }
}

async function checkPlayers($: EngineInterface) {
  const list = await read($, players)
  if (list.length === 0) return
  const checked: ReviewPlayer[] = []
  for (const player of list) {
    const probe = await $.process.run(['curl', '-s', '-o', '/dev/null', '--max-time', '2', '-w', '%{http_code}', player.url], {
      timeoutMs: 5000,
    })
    checked.push({ ...player, isAlive: probe.stdout.trim() !== '000' && probe.stdout.trim() !== '' })
  }
  await update($, players, () => checked)
}

async function restart($: EngineInterface, player: ReviewPlayer) {
  await $.prompt.submit({ text: `The local server ${player.tag ? `for ${player.tag} ` : ''}(${player.url}) has stopped. Restart it.` })
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Paths and URLs a command passes to macOS `open`, following `cd` within the command.
function openTargets(command: string, cwd: string): string[] {
  const targets: string[] = []
  let dir = cwd
  for (const segment of command.split(/&&|\|\||;|\n|\|/)) {
    const words = shellWords(segment.trim())
    const into = words[0] === 'cd' ? words[1] : undefined
    if (into) {
      dir = resolvePath(into, dir)
      continue
    }
    if (words[0] !== 'open') continue
    for (let i = 1; i < words.length; i++) {
      const word = words[i] ?? ''
      if (word === '-a' || word === '-b') {
        i++
        continue
      }
      if (word.startsWith('-')) continue
      targets.push(/^https?:\/\//.test(word) ? word : resolvePath(word, dir))
    }
  }

  return targets
}

function shellWords(text: string): string[] {
  const words: string[] = []
  for (const match of text.matchAll(/"((?:\\.|[^"\\])*)"|'([^']*)'|((?:\\.|[^\s"'\\])+)/g)) {
    words.push((match[1] ?? match[2] ?? match[3] ?? '').replace(/\\(.)/g, '$1'))
  }

  return words
}

function resolvePath(path: string, dir: string): string {
  if (path.startsWith('/') || path.startsWith('~')) return path
  const out: string[] = []
  for (const part of `${dir}/${path}`.split('/')) {
    if (part === '..') out.pop()
    else if (part && part !== '.') out.push(part)
  }

  return `/${out.join('/')}`
}

async function expandHome($: EngineInterface, path: string): Promise<string> {
  if (!path.startsWith('~')) return path
  return ((await $.env.get('HOME')) ?? '') + path.slice(1)
}

function ago(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`

  return `${Math.round(minutes / (60 * 24))}d`
}

function clip(text: string, room: number): string {
  return text.length <= room ? text : `…${text.slice(text.length - room + 1)}`
}
