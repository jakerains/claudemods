// POWERTRAY (the open-tray mod): a pane of things to look at or listen to,
// with two tabs.
//
// Tray:
// - Made this session: what Claude opened, wrote, rendered or handed over,
//   plus anything the person kept. These stay until removed.
// - Related to what we're on: found for the area being worked on (a module, a
//   folder) and swapped out when the area changes. A project's rules file says
//   how to spot its areas and where their good stuff lives (rules.ts); without
//   one, the area is the folder Claude works in, or one a prompt names.
// - Local servers Claude started, each with stop, restart and remove.
// Recap (recap.ts): what we did, what waits on the person, and what comes
// next. A quick one (Haiku) after each stretch of work; a detailed one (the
// session's model) on request.
// A player card (player.ts) shows above both while a film's sound or an audio
// file plays.
//
// Nothing here is project-specific: projects bring their own rules (a repo's
// `.claude/tray.json`, or `~/.claude/open-tray/rules/<repo>.json`).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, Timer } from 'claude-code'

import type { Recaps, Related, RelatedGroup, ReviewPlayer, TrayAction, TrayItem, Work } from '../types'
import { clockText, ffplayArgs, ffprobeArgs, landing, lengthIn, positionOf } from './player'
import { ASK, KEEP, QUICK_MODEL, QUICK_SYSTEM, RECAP_FILES, digest, isWorth, parse, progress, quickAsk, scanner, spinner } from './recap'
import {
  SHOWN_PATH,
  actionPattern,
  actionsFor,
  areaIn,
  baseName,
  dirsScript,
  findScript,
  folderArea,
  folderIn,
  foldersScript,
  groupItems,
  isShown,
  kindOf,
  relatedPlan,
  rulesPaths,
  skipList,
  startsServer,
  tagOf,
} from './rules'
import type { Area, Rules } from './rules'
import { ICONS, KIND_COLORS, NAME, NAME_COLORS, THEME } from './theme'

const PANE = 'open-tray'
const MAX_ITEMS = 50
const FRESH_MS = 15 * 60_000
const CHECK_MS = 20_000
// The area changes after this many of the last WINDOW votes point at it.
const SWITCH_VOTES = 3
const WINDOW = 8
const REFRESH_GAP_MS = 60_000
const FOLDERS_MS = 60_000

const NO_RELATED: Related = { area: null, label: '', groups: [], actions: [], suggested: [] }
const NO_RECAPS: Recaps = { list: [], view: 0, isWriting: false, isDetailed: false, startedAt: 0, isNew: false, ticked: [], note: '' }
const NO_WORK: Work = { agents: 0, files: [], calls: 0 }

// Held by the host, so the tray survives a hot reload of this file.
const items = atom({ plugin: 'open-tray', key: 'items' } as const, [])
const selected = atom({ plugin: 'open-tray', key: 'selected' } as const, 0)
const players = atom({ plugin: 'open-tray', key: 'players' } as const, [])
const related = atom({ plugin: 'open-tray', key: 'related' } as const, NO_RELATED)
const signals = atom({ plugin: 'open-tray', key: 'signals' } as const, [])
const hidden = atom({ plugin: 'open-tray', key: 'hidden' } as const, [])
const tab = atom({ plugin: 'open-tray', key: 'tab' } as const, 'tray')
const playing = atom({ plugin: 'open-tray', key: 'playing' } as const, null)
const tick = atom({ plugin: 'open-tray', key: 'tick' } as const, 0)
const spin = atom({ plugin: 'open-tray', key: 'spin' } as const, 0)
const recaps = atom({ plugin: 'open-tray', key: 'recaps' } as const, NO_RECAPS)
const work = atom({ plugin: 'open-tray', key: 'work' } as const, NO_WORK)
const autoRecap = atom({ plugin: 'open-tray', key: 'autoRecap' } as const, true)

const LOCAL_URL = /https?:\/\/(?:127\.0\.0\.1|localhost|[\w.-]+\.localhost)(?::\d+)?(?:\/[^\s'"`)\]<>]*)?/g
const OUTPUT_FILE = /\/[^\s'"`]+\/tasks\/[\w-]+\.output\b/
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

// This load's view of the project: its root and rules, read at session start.
let root = ''
let rules: Rules | null = null
// A repo's own rules file waiting for /tray trust: its hash and where it is.
let untrusted: { path: string; hash: string } | null = null
let lastRefreshAt = 0
// The repo's folders, for prompts that name one (no rules only).
let folders: { at: number; list: string[] } = { at: 0, list: [] }
// The player's child lives as long as its stream is read, so the handle is
// here; a reload kills the child, and session.start clears what the pane shows.
let child: AsyncGenerator<unknown, unknown> | null = null
// Bumped on every start and stop, so a stream that ends after being replaced
// does not clear the player that replaced it.
let generation = 0
let ticker: Timer | null = null
let hasFfplay: boolean | null = null
// One recap at a time; a reload ends the call, so a module variable is enough.
let isRecapping = false
// "Recap now" pressed while a quick one was being written: the detailed one follows it.
let wantDetailed = false
// Moves the "writing recap" bar while one is written, and only then.
let spinning: Timer | null = null
const SPIN_MS = 120

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    root = (await $.session.repo())?.root ?? (await $.session.root())
    rules = await loadRules($, root)
    await resetPlayer($)
    await resetRecap($)
    const isAuto = (await $.store.get('autoRecap').catch(() => undefined)) !== false
    await update($, autoRecap, () => isAuto)
    await $.command.register({
      name: 'tray',
      description: `Show ${NAME}: what was made for you this session, things related to what we are on, and a recap of the work (recap: write a detailed one now; autorecap on|off: quick recaps on their own; trust: use this repo's .claude/tray.json)`,
      argumentHint: '[recap|autorecap [on|off]|trust|untrust]',
      immediate: true,
    })
    await $.tool.register({
      name: 'offer',
      description:
        `Put a file, folder or local URL in the user's ${NAME} pane (Open Tray), where they open it, reveal it in Finder or play a film's sound. ` +
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
      const area = areaIn(e.text, rules) ?? (rules?.areas?.length ? null : folderIn(e.text, await folderList($)))
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
      return { result: `Suggested in ${NAME}: ${item.label}` }
    }
    await addItem($, item, true)

    return { result: `In ${NAME}: ${item.label}` }
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if ('deny' in result && result.deny) {
      return result
    }
    const input = e as unknown as Record<string, unknown>
    const isMain = !e.agentId
    if (isMain) await noteCall($)

    const path = String(input.file_path ?? input.path ?? input.notebook_path ?? '')
    if (path.startsWith('/')) {
      // The files the main loop works on vote for the area.
      if (isMain) {
        const current = (await read($, related)).area
        const area = areaIn(path, rules) ?? (rules?.areas?.length ? null : folderArea(path, root, current))
        if (area) await vote($, area, false)
      }
      // Changed files, anyone's, make a stretch worth a recap; a shown file Claude writes lands.
      if (EDIT_TOOLS.has(e.tool)) await noteFile($, path)
      if (e.tool === 'Write' && isShown(path)) {
        const item = await itemFor($, path)
        if (item) await addItem($, item, false)
      }
    }

    if (e.tool === 'Bash') {
      const command = String(input.command ?? '')
      const output = typeof result.text === 'string' ? result.text : ''
      const cwd = await $.session.cwd()
      // What anyone opens is meant to be seen.
      for (const target of openTargets(command, cwd)) {
        const item = await itemFor($, target)
        if (item) await addItem($, item, false)
      }
      // What the main loop prints, if it is new; a subagent's listings are its own business.
      if (isMain) {
        const now = await $.clock.now()
        for (const path of new Set(output.match(SHOWN_PATH) ?? [])) {
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

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (!result.deny) await noteAgent($)

    return result
  })

  // New renders land during a turn; look again once it ends (at most once a
  // minute). A stretch of work gets its quick recap, off the hook's own time.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) return result
    const r = await read($, related)
    const now = await $.clock.now()
    if (r.area && now - lastRefreshAt > REFRESH_GAP_MS) {
      const area = areaFromKey(r.area)
      if (area) await refresh($, area)
    }
    if (e.reason === 'answer') $.clock.after(0, () => void afterTurn($))

    return result
  })

  // Closing the pane stops the sound.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const result = await next(e)
    await stopSound($)

    return result
  })

  on('command.run', { command: 'tray' }, async ($, e) => {
    const [word = '', choice] = e.args.trim().toLowerCase().split(/\s+/)
    if (word === 'trust' || word === 'untrust') return { text: await trustRepo($, word === 'trust') }
    if (word === 'autorecap') return { text: await setAutoRecap($, choice) }
    if (word === 'recap') await showTab($, 'recap')
    const opened = await $.ui.open({ id: PANE, title: NAME, focus: true })
    if (word === 'recap') {
      await writeRecap($, true)
      return { text: opened.isPlaced ? `${NAME}: writing a recap.` : `${NAME} could not be placed; widen the terminal.` }
    }
    const count = (await read($, items)).length
    const r = await read($, related)

    const note = untrusted ? ` This repo has rules (${untrusted.path}); review them, then /tray trust to use them.` : ''
    return {
      text: opened.isPlaced
        ? `${NAME}: ${count} made this session${r.area ? `, ${r.label} related` : ''}.${note}`
        : `${NAME} could not be placed; widen the terminal.`,
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const columns = e.props.bodyColumns
    const now = await $.clock.now()
    const r = await read($, related)
    const showing = await read($, tab)
    const rc = await read($, recaps)
    const done = await read($, work)
    const isAuto = await read($, autoRecap)
    const sound = await read($, playing)
    await read($, tick) // Redraws the player's clock each second while it plays.
    const step = rc.isWriting ? await read($, spin) : 0 // Moves the recap's bar while it is written.
    const writingFor = rc.isWriting && rc.startedAt ? `${Math.max(0, Math.round((now - rc.startedAt) / 1000))}s` : ''

    const title = (text: string, count?: number) => {
      const tail = count === undefined ? '' : ` ${count}`
      return (
        <Box flexDirection="row" marginTop={1}>
          <Text color={THEME.grid}>{'▸ '}</Text>
          <Text bold color={THEME.chrome}>{text.toUpperCase()}</Text>
          <Text color={THEME.faint}>{`${tail} `}</Text>
          <Text color={THEME.rule}>{'─'.repeat(Math.max(0, columns - text.length - tail.length - 3))}</Text>
        </Box>
      )
    }

    const header = (
      <Box flexDirection="row" justifyContent="space-between" width={columns}>
        <Box flexDirection="row">
          <Text color={THEME.grid}>{'▚▞ '}</Text>
          {[...NAME].map((letter, i) => (
            <Text bold color={NAME_COLORS[i % NAME_COLORS.length]}>{letter}</Text>
          ))}
        </Box>
        {r.label ? (
          <Text backgroundColor={THEME.accent} color={THEME.onAccent} bold>{` ◆ ${r.label} `}</Text>
        ) : (
          <Text color={THEME.faint}>{'PLAYER 1 READY'}</Text>
        )}
      </Box>
    )

    const tabs = (
      <Box flexDirection="row" marginTop={1}>
        <Text color={THEME.accent}>{showing === 'tray' ? '▸' : ' '}</Text>
        <Button key="tab-tray" plain hotkey="1" dimColor={showing !== 'tray'} label="TRAY   " onPress={() => void showTab($, 'tray')} />
        <Text color={THEME.accent}>{showing === 'recap' ? '▸' : ' '}</Text>
        <Button key="tab-recap" plain hotkey="2" dimColor={showing !== 'recap'} label="RECAP" onPress={() => void showTab($, 'recap')} />
        <Text color={THEME.accent}>{rc.isNew ? ' ●' : ''}</Text>
        <Text color={THEME.accent}>{rc.isWriting ? `  ${spinner(step)}` : ''}</Text>
        <Text color={THEME.faint}>{rc.isWriting ? ` writing ${writingFor}` : ''}</Text>
      </Box>
    )

    const body = showing === 'recap' ? drawRecap() : await drawTray()

    return (
      <Box flexDirection="column" width={columns}>
        {header}
        {tabs}
        {sound && drawPlayer(sound)}
        {body}
      </Box>
    )

    function drawPlayer(p: NonNullable<typeof sound>) {
      const inner = Math.max(10, columns - 4)
      const at = positionOf(p, now)
      const time = p.duration ? `${clockText(at)} / ${clockText(p.duration)}` : clockText(at)
      const filled = p.duration ? Math.round(inner * Math.min(1, at / p.duration)) : 0
      const isPaused = p.startedAt === null
      return (
        <Box flexDirection="column" borderStyle="double" borderColor={THEME.accent} paddingX={1} marginTop={1} width={columns}>
          <Box flexDirection="row" justifyContent="space-between" width={inner}>
            <Text bold color={THEME.chrome}>{isPaused ? 'PAUSED' : 'NOW PLAYING'}</Text>
            <Text color={THEME.sub}>{time}</Text>
          </Box>
          <Text color={KIND_COLORS.audio}>{`♪ ${clip(p.label, inner - 2)}`}</Text>
          {p.duration ? (
            <Box flexDirection="row">
              {filled > 0 && <Text color={THEME.accent}>{'█'.repeat(filled)}</Text>}
              {inner - filled > 0 && <Text color={THEME.rule}>{'░'.repeat(inner - filled)}</Text>}
            </Box>
          ) : null}
          <Box flexDirection="row" flexWrap="wrap">
            <Button
              key="play"
              plain
              label={isPaused ? '▶ play   ' : '‖ pause   '}
              onPress={() => void (isPaused ? resume($) : pause($))}
            />
            <Button key="back-60" plain label="-1m   " onPress={() => void jump($, -60)} />
            <Button key="back-10" plain label="-10s   " onPress={() => void jump($, -10)} />
            <Button key="ahead-10" plain label="+10s   " onPress={() => void jump($, 10)} />
            <Button key="ahead-60" plain label="+1m   " onPress={() => void jump($, 60)} />
            <Button key="stop" plain label="■ stop" onPress={() => void stopSound($)} />
          </Box>
        </Box>
      )
    }

    async function drawTray() {
      const mine = await read($, items)
      const away = new Set(await read($, hidden))
      const live = await read($, players)
      const rows = flatten(mine, r, away)
      const pick = Math.min(await read($, selected), Math.max(0, rows.length - 1))
      const mineCount = rows.filter(row => row.place === 'mine').length
      const areaCount = rows.length - mineCount

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
              <Button key="audio" plain hotkey="a" label="listen   " onPress={() => void act($, pick, 'audio')} />
              <Button key="keep" plain hotkey="p" label="keep   " onPress={() => void keep($, pick)} />
              <Button key="remove" plain hotkey="x" label="remove   " onPress={() => void remove($, pick)} />
              <Button key="down" plain hotkey="j" label="down   " onPress={() => void move($, 1)} />
              <Button key="up" plain hotkey="k" label="up" onPress={() => void move($, -1)} />
            </Box>
          )}

          {live.length > 0 && (
            <Box flexDirection="column" borderStyle="round" borderColor={THEME.rule} paddingX={1} marginTop={1}>
              <Text bold color={THEME.sub}>{'Local servers'}</Text>
              {live.map((server, index) => (
                <Box flexDirection="row">
                  <Text color={server.isAlive ? THEME.go : THEME.stop}>{server.isAlive ? '● ' : '○ '}</Text>
                  <Button
                    key={`server-${index}`}
                    plain
                    dimColor={!server.isAlive}
                    label={`${server.tag ?? 'server'}  ${server.url}`}
                    onPress={() => void $.process.run(['open', server.url])}
                  />
                  {server.isAlive ? (
                    <Button key={`stop-${index}`} plain label="   stop" onPress={() => void stopServer($, server)} />
                  ) : (
                    <Button key={`restart-${index}`} plain label="   restart" onPress={() => void restartServer($, server)} />
                  )}
                  <Button key={`drop-${index}`} plain dimColor label="   remove" onPress={() => void dropServer($, server)} />
                </Box>
              ))}
            </Box>
          )}
        </Box>
      )
    }

    function drawRecap() {
      const shown = rc.list[Math.min(rc.view, rc.list.length - 1)]
      const wide = Math.max(10, columns - 4)
      const barWidth = Math.max(6, Math.min(24, columns - 30))
      const writing = rc.isWriting && (
        <Box flexDirection="column" borderStyle="round" borderColor={THEME.accent} paddingX={1} marginTop={1} width={columns}>
          <Box flexDirection="row" justifyContent="space-between" width={Math.max(10, columns - 4)}>
            <Box flexDirection="row">
              <Text bold color={THEME.chrome}>{'WRITING RECAP  '}</Text>
              <Text color={THEME.accent}>{scanner(step, barWidth)}</Text>
            </Box>
            <Text color={THEME.sub}>{writingFor}</Text>
          </Box>
          <Text color={THEME.faint} wrap="wrap">
            {rc.isDetailed
              ? 'Detailed, on the session model: reading back over our conversation for what we did, what waits on you and what comes next.'
              : 'Quick, on Haiku: reading the latest stretch of work. Press r for a detailed one.'}
          </Text>
        </Box>
      )
      const footer = (
        <Box flexDirection="row" flexWrap="wrap" marginTop={1}>
          <Button key="recap-now" plain hotkey="r" label="recap now   " onPress={() => writeRecap($, true)} />
          {rc.view < rc.list.length - 1 && (
            <Button key="older" plain label="◂ older   " onPress={() => void update($, recaps, x => ({ ...x, view: x.view + 1 }))} />
          )}
          {rc.view > 0 && (
            <Button key="newer" plain label="newer ▸   " onPress={() => void update($, recaps, x => ({ ...x, view: x.view - 1 }))} />
          )}
          {shown && (
            <Text color={THEME.faint}>{`${wrote(now - shown.at)} · ${shown.isAsked ? 'detailed' : 'quick (Haiku)'}`}</Text>
          )}
        </Box>
      )
      const status = !rc.isWriting && (
        <Box flexDirection="column" paddingX={1} width={columns}>
          <Text color={THEME.faint} wrap="wrap">
            {isAuto ? progress(done) : 'Quick recaps are off (/tray autorecap on). Press r for a detailed one.'}
          </Text>
          {isAuto && rc.note && <Text color={THEME.stop} wrap="wrap">{rc.note}</Text>}
        </Box>
      )
      if (!shown) {
        return (
          <Box flexDirection="column" width={columns}>
            {writing}
            {!rc.isWriting && (
              <Box flexDirection="column" marginTop={1} paddingX={1} width={columns}>
                <Text color={THEME.sub}>{'No recap yet.'}</Text>
                <Text color={THEME.faint} wrap="wrap">
                  {`A quick one writes itself after a stretch of work (a subagent, ${RECAP_FILES}+ files changed, or a run of steps): what we did, what waits on you, and what comes next. Press r for a detailed one.`}
                </Text>
              </Box>
            )}
            {footer}
            {status}
          </Box>
        )
      }
      return (
        <Box flexDirection="column" width={columns}>
          {writing}
          {title('What we did')}
          {shown.did.map(text => (
            <Box flexDirection="row">
              <Text color={THEME.chrome}>{' · '}</Text>
              <Box width={wide}>
                <Text wrap="wrap">{text}</Text>
              </Box>
            </Box>
          ))}

          {title('Waiting on you', shown.waiting.length)}
          {shown.waiting.length === 0 && <Text color={THEME.faint}>{'  Nothing waits on you.'}</Text>}
          {shown.waiting.map((text, index) => {
            const id = `${shown.at}:${index}`
            const isDone = rc.ticked.includes(id)
            return (
              <Box flexDirection="row">
                <Button key={`todo-${index}`} plain label={isDone ? ' [x] ' : ' [ ] '} onPress={() => void toggle($, id)} />
                <Box width={wide - 2}>
                  <Text wrap="wrap" color={isDone ? THEME.faint : undefined}>{text}</Text>
                </Box>
              </Box>
            )
          })}

          {shown.next && title('Next up')}
          {shown.next && (
            <Box paddingX={1} width={columns}>
              <Text wrap="wrap">{shown.next}</Text>
            </Box>
          )}
          {footer}
          {status}
        </Box>
      )
    }
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

async function showTab($: EngineInterface, which: 'tray' | 'recap') {
  await update($, tab, () => which)
  if (which === 'recap') await update($, recaps, r => (r.isNew ? { ...r, isNew: false } : r))
}

async function toggle($: EngineInterface, id: string) {
  await update($, recaps, r => ({
    ...r,
    ticked: r.ticked.includes(id) ? r.ticked.filter(t => t !== id) : [...r.ticked, id].slice(-100),
  }))
}

async function runRow($: EngineInterface, index: number) {
  const row = (await rowsNow($))[index]
  if (!row) return
  await update($, selected, () => index)
  if (row.kind === 'action') {
    await $.prompt.submit({ text: row.action.prompt })
    return
  }
  await openSafely($, row.item.target, row.item.kind)
}

// Opens a file or folder to look at it. The link is resolved first, and only
// what is plainly for viewing opens (films, audio, images, pages, documents, a
// folder); anything else (an app, a script, a bundle, a profile) is shown in
// Finder, since `open` would launch it.
async function openSafely($: EngineInterface, target: string, kind: string) {
  if (kind === 'url') {
    if (/^https?:\/\//i.test(target)) await $.process.run(['open', target])
    return
  }
  const linked = await $.fs.stat(target, { resolve: true }).catch(() => null)
  const real = linked?.realPath ?? target
  const stat = await $.fs.stat(real).catch(() => null)
  if (!stat) {
    $.ui.toast(`Not found: ${baseName(target)}`)
    return
  }
  const isViewable = stat.kind === 'file' ? kindOf(real) !== 'other' : stat.kind === 'dir' && !baseName(real).includes('.')
  if (!isViewable) {
    $.ui.toast(`Shown in Finder: ${NAME} opens only films, audio, images, pages and documents`)
    await $.process.run(['open', '-R', real])
    return
  }
  await $.process.run(['open', real])
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
  if (item.kind !== 'video' && item.kind !== 'audio') {
    $.ui.toast('Listen works on a film or an audio file')
    return
  }
  if (!(await canPlay($))) {
    $.ui.toast('Playing in the tray needs ffplay (brew install ffmpeg); opening it instead')
    await openSafely($, item.target, item.kind)
    return
  }
  await play($, item.target, item.label)
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
  const opened = await $.ui.open({ id: PANE, title: NAME })
  if (!opened.isPlaced && isAsked) {
    $.ui.toast(`${NAME}: ${item.label}  (/tray to show)`)
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
function areaFromKey(key: string): Area | null {
  return areaIn(key, rules) ?? (rules?.areas?.length ? null : { key, label: key, values: { '1': key, '1n': key } })
}

// The repo's folders, looked up again at most once a minute.
async function folderList($: EngineInterface): Promise<string[]> {
  const now = await $.clock.now()
  if (root && now - folders.at > FOLDERS_MS) {
    const run = await $.process.run(['/bin/sh', '-c', foldersScript(root)], { timeoutMs: 5_000 }).catch(() => null)
    const list = (run?.stdout ?? '')
      .split('\n')
      .map(line => line.replace(/^\.\//, ''))
      .filter(Boolean)
    folders = { at: now, list }
  }

  return folders.list
}

async function refresh($: EngineInterface, area: Area) {
  const now = await $.clock.now()
  lastRefreshAt = now
  const skip = skipList(rules)
  const groups: RelatedGroup[] = []
  for (const rule of relatedPlan(area, rules)) {
    const run = await $.process.run(['/bin/sh', '-c', findScript(root, rule.paths, rule.names, rule.maxDepth)], { timeoutMs: 15_000 })
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

// Rules decide which shell searches run and which patterns run on your prompts,
// so only rules you chose are used: your own (~/.claude/open-tray/rules/), or a
// repo's .claude/tray.json once you have trusted that exact content with
// `/tray trust` (a changed file asks again).
async function loadRules($: EngineInterface, projectRoot: string): Promise<Rules | null> {
  const home = (await $.env.get('HOME')) ?? ''
  const [repoPath, ownPath] = rulesPaths(projectRoot, home)
  untrusted = null
  const own = await readRules($, ownPath!)
  if (own) return own.rules
  const repo = await readRules($, repoPath!)
  if (!repo) return null
  const trusted = ((await $.store.get('trusted').catch(() => undefined)) ?? {}) as Record<string, string>
  if (trusted[projectRoot] === repo.hash) return repo.rules
  untrusted = { path: '.claude/tray.json', hash: repo.hash }
  $.ui.toast(`This repo has ${NAME} rules (.claude/tray.json). Review them, then /tray trust to use them.`)

  return null
}

async function readRules($: EngineInterface, path: string): Promise<{ rules: Rules; hash: string } | null> {
  try {
    const text = await $.fs.read(path)
    return { rules: JSON.parse(text) as Rules, hash: await sha256(text) }
  } catch {
    return null // Not there, or not valid JSON.
  }
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

async function trustRepo($: EngineInterface, isTrusting: boolean): Promise<string> {
  const trusted = ((await $.store.get('trusted').catch(() => undefined)) ?? {}) as Record<string, string>
  if (!isTrusting) {
    delete trusted[root]
    await $.store.set('trusted', trusted)
    rules = await loadRules($, root)
    return `${NAME}: this repo's rules are no longer used.`
  }
  if (!untrusted) return rules ? `${NAME}: rules already in use.` : `${NAME}: this repo has no .claude/tray.json.`
  trusted[root] = untrusted.hash
  await $.store.set('trusted', trusted)
  rules = await loadRules($, root)
  const r = await read($, related)
  const area = r.area ? areaFromKey(r.area) : null
  if (area) await refresh($, area)
  return `${NAME}: using this repo's rules. If .claude/tray.json changes, /tray trust again.`
}

// ── The player ───────────────────────────────────────────────────────────────

/** Is ffplay here? Asked once a load. */
async function canPlay($: EngineInterface): Promise<boolean> {
  if (hasFfplay === null) {
    const probe = await $.process.run(['ffplay', '-version'], { timeoutMs: 5000 }).catch(() => null)
    hasFfplay = probe?.exitCode === 0
  }

  return hasFfplay
}

async function play($: EngineInterface, target: string, label: string) {
  stopChild()
  const probe = await $.process.run(ffprobeArgs(target), { timeoutMs: 10_000 }).catch(() => null)
  const duration = probe?.exitCode === 0 ? lengthIn(probe.stdout) : null
  const now = await $.clock.now()
  await update($, playing, () => ({ target, label, offset: 0, startedAt: now, duration }))
  startSound($, target, 0)
}

async function pause($: EngineInterface) {
  const p = await read($, playing)
  if (!p || p.startedAt === null) return
  stopChild()
  const at = positionOf(p, await $.clock.now())
  await update($, playing, () => ({ ...p, offset: at, startedAt: null }))
}

async function resume($: EngineInterface) {
  const p = await read($, playing)
  if (!p || p.startedAt !== null) return
  const now = await $.clock.now()
  await update($, playing, () => ({ ...p, startedAt: now }))
  startSound($, p.target, p.offset)
}

/** Jumps by `seconds` (negative goes back), playing or paused. */
async function jump($: EngineInterface, seconds: number) {
  const p = await read($, playing)
  if (!p) return
  const now = await $.clock.now()
  const at = landing(positionOf(p, now), seconds, p.duration)
  if (p.startedAt === null) {
    await update($, playing, () => ({ ...p, offset: at }))
    return
  }
  stopChild()
  await update($, playing, () => ({ ...p, offset: at, startedAt: now }))
  startSound($, p.target, at)
}

async function stopSound($: EngineInterface) {
  stopChild()
  if (await read($, playing)) await update($, playing, () => null)
}

/** After a reload: the child died with the old module, so nothing plays. */
async function resetPlayer($: EngineInterface) {
  child = null
  ticker = null
  if (await read($, playing)) await update($, playing, () => null)
}

function startSound($: EngineInterface, target: string, offset: number) {
  const mine = ++generation
  const stream = $.process.spawn({ argv: ffplayArgs(target, offset) })
  child = stream
  if (!ticker) ticker = $.clock.every(1000, () => void update($, tick, n => n + 1))
  void (async () => {
    let errors = ''
    let code: number | null = 0
    try {
      for await (const piece of stream) {
        if (piece.stream === 'stderr') errors = (errors + piece.text).slice(-400)
      }
      code = (await stream.result).code
    } catch {
      code = null
    }
    if (mine !== generation) return // Replaced, or stopped on purpose.
    stopChild()
    await update($, playing, () => null)
    if (code !== 0 && errors.trim()) $.ui.toast(`Could not play it: ${errors.trim().split('\n').pop()}`)
  })()
}

function stopChild() {
  generation++
  ticker?.cancel()
  ticker = null
  const old = child
  child = null
  if (old) void old.return(undefined).catch(() => {})
}

// ── Recaps ───────────────────────────────────────────────────────────────────

async function noteAgent($: EngineInterface) {
  await update($, work, w => ({ ...w, agents: w.agents + 1 }))
}

async function noteCall($: EngineInterface) {
  await update($, work, w => ({ ...w, calls: (w.calls ?? 0) + 1 }))
}

async function noteFile($: EngineInterface, path: string) {
  await update($, work, w => (w.files.includes(path) ? w : { ...w, files: [...w.files, path].slice(-200) }))
}

/** After a main-loop turn: a quick recap of the work, once no subagent is still at it. */
async function afterTurn($: EngineInterface) {
  if (!(await read($, autoRecap))) return
  if (!isWorth(await read($, work))) return
  // Subagents run in the background; their results wake the main loop for
  // another turn, which comes back here once they are done.
  const agents = await $.agent.list().catch(() => [])
  const busy = agents.filter(a => a.status === 'running' || a.status === 'pending').length
  if (busy > 0) {
    await update($, recaps, r => ({ ...r, note: `Waiting for ${busy} subagent${busy === 1 ? '' : 's'} to finish.` }))
    return
  }
  await writeRecap($, false)
}

// Shows "writing" at once, then writes the recap on a timer of its own: a
// press or a command answers right away, so the pane draws the bar first.
// Asked for: detailed, on the session's model. On its own: quick, on Haiku.
async function writeRecap($: EngineInterface, isAsked: boolean) {
  if (isRecapping) {
    if (isAsked && !(await read($, recaps)).isDetailed) wantDetailed = true
    return
  }
  isRecapping = true
  const now = await $.clock.now()
  await update($, recaps, r => ({ ...r, isWriting: true, isDetailed: isAsked, startedAt: now }))
  if (!spinning) spinning = $.clock.every(SPIN_MS, () => void update($, spin, n => n + 1))
  $.clock.after(0, () => void runRecap($, isAsked))
}

/** The detailed recap forks the session; the quick one hands Haiku a cut of the transcript. */
async function askRecap($: EngineInterface, isAsked: boolean) {
  if (isAsked) return $.model.fork({ prompt: ASK })
  const transcript = digest(await $.session.messages())
  if (!transcript) return null
  const last = (await read($, recaps)).list[0]
  return $.model.complete({
    model: QUICK_MODEL,
    system: QUICK_SYSTEM,
    prompt: quickAsk(transcript, last),
    maxTokens: 1024,
    effort: 'low',
    timeoutMs: 90_000,
  })
}

async function runRecap($: EngineInterface, isAsked: boolean) {
  try {
    const reply = await askRecap($, isAsked)
    if (!reply?.isAnswered) {
      if (isAsked && reply?.reason === 'api-error') $.ui.toast(`${NAME}: the recap could not be written (API error)`)
      else if (isAsked && reply?.reason === 'nothing-to-fork') $.ui.toast(`${NAME}: nothing to recap yet`)
      if (!isAsked) {
        const why = !reply ? 'no transcript yet' : reply.reason === 'api-error' ? `API error ${reply.status ?? ''} ${reply.error}`.replace(/\s+/g, ' ') : reply.reason
        await update($, recaps, r => ({ ...r, note: `The last quick recap did not come: ${why}.` }))
      }
      return
    }
    const note = parse(reply.text, await $.clock.now(), isAsked)
    await update($, work, () => NO_WORK)
    const isLooking = (await read($, tab)) === 'recap'
    await update($, recaps, r => ({ ...r, list: [note, ...r.list].slice(0, KEEP), view: 0, isNew: !isLooking, note: '' }))
  } catch (error) {
    if (isAsked) $.ui.toast(`${NAME}: the recap could not be written`)
    else {
      const why = String(error instanceof Error ? error.message : error).slice(0, 160)
      await update($, recaps, r => ({ ...r, note: `The last quick recap did not come: ${why}` }))
    }
  } finally {
    isRecapping = false
    spinning?.cancel()
    spinning = null
    await update($, recaps, r => ({ ...r, isWriting: false, isDetailed: false, startedAt: 0 }))
    if (wantDetailed) {
      wantDetailed = false
      await writeRecap($, true)
    }
  }
}

/** `/tray autorecap [on|off]`: on its own, it flips. Kept for every session. */
async function setAutoRecap($: EngineInterface, choice: string | undefined): Promise<string> {
  if (choice !== undefined && choice !== 'on' && choice !== 'off') return `${NAME}: /tray autorecap on, or off`
  const isOn = choice === undefined ? !(await read($, autoRecap)) : choice === 'on'
  await update($, autoRecap, () => isOn)
  await $.store.set('autoRecap', isOn)
  return isOn
    ? `${NAME}: quick recaps (Haiku) write themselves again after a stretch of work.`
    : `${NAME}: quick recaps are off; press r in the Recap tab, or /tray recap, for a detailed one.`
}

/** After a reload: no recap call survives it. */
async function resetRecap($: EngineInterface) {
  isRecapping = false
  wantDetailed = false
  spinning = null
  if ((await read($, recaps)).isWriting) await update($, recaps, r => ({ ...r, isWriting: false, startedAt: 0 }))
}

// ── Local servers ────────────────────────────────────────────────────────────

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
  for (const server of list) {
    checked.push({ ...server, isAlive: await isAnswering($, server.url) })
  }
  // A server removed while the checks ran stays removed.
  await update($, players, now => now.map(p => checked.find(c => c.url === p.url) ?? p))
}

async function isAnswering($: EngineInterface, url: string): Promise<boolean> {
  const probe = await $.process.run(['curl', '-s', '-o', '/dev/null', '--max-time', '2', '-w', '%{http_code}', url], { timeoutMs: 5000 })
  return probe.stdout.trim() !== '000' && probe.stdout.trim() !== ''
}

// Stops what listens on the server's port: the server Claude started there.
async function stopServer($: EngineInterface, server: ReviewPlayer) {
  const port = server.url.match(/^https?:\/\/[^/:]+:(\d+)/)?.[1]
  if (!port) {
    $.ui.toast(`${server.url} names no port, so ${NAME} cannot tell which process it is`)
    return
  }
  const found = await $.process.run(['lsof', '-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { timeoutMs: 5000 }).catch(() => null)
  const pids = (found?.stdout ?? '').split('\n').map(s => s.trim()).filter(s => /^\d+$/.test(s))
  if (pids.length === 0) {
    $.ui.toast(`Nothing is listening on :${port}`)
  } else {
    const names: string[] = []
    for (const pid of pids) {
      const ps = await $.process.run(['ps', '-o', 'comm=', '-p', pid], { timeoutMs: 5000 }).catch(() => null)
      names.push(baseName(ps?.stdout.trim() || pid))
      await $.process.run(['kill', '-TERM', pid], { timeoutMs: 5000 }).catch(() => null)
    }
    $.ui.toast(`Stopped ${[...new Set(names)].join(', ')} on :${port}`)
  }
  await update($, players, list => list.map(p => (p.url === server.url ? { ...p, isAlive: false } : p)))
}

async function restartServer($: EngineInterface, server: ReviewPlayer) {
  await $.prompt.submit({ text: `The local server ${server.tag ? `for ${server.tag} ` : ''}(${server.url}) has stopped. Restart it.` })
}

async function dropServer($: EngineInterface, server: ReviewPlayer) {
  await update($, players, list => list.filter(p => p.url !== server.url))
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

function wrote(ms: number): string {
  const when = ago(ms)
  return when === 'now' ? 'written just now' : `written ${when} ago`
}

function clip(text: string, room: number): string {
  return text.length <= room ? text : `…${text.slice(text.length - room + 1)}`
}
