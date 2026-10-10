import { describe, expect, mock, test } from 'claude-code/testing'
import { areaIn, findScript, regexOf, relatedPlan } from '../hooks/rules.ts'

const PANE = {
  plugin: 'open-tray',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'open-tray',
  props: { title: 'Open Tray', isFocused: true, bodyColumns: 90, placement: 'dock' },
} as any

// A small project with rules: areas are "m01".."m09", related films live under lessons/.
const RULES = JSON.stringify({
  areas: [{ key: 'm{1}', label: 'Module {1n}', patterns: ['\\bm(\\d\\d)\\b', '\\bmodule\\s*(\\d{1,2})\\b'], pad: 2 }],
  related: [{ label: 'Lesson films', paths: ['lessons/m{1}-*'], names: ['*.mp4'] }],
  actions: [{ label: 'Start {each}', each: 'lessons/m{1}-*', prompt: 'Start {each}.' }],
  servers: { spot: 'pnpm\\b[^;&|\\n]*\\breview\\b' },
  tag: '\\bm\\d\\d-l\\d\\d\\b',
})

const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

const OWN_RULES = '/Users/x/.claude/open-tray/rules/w.json'
const REPO_RULES = '/w/.claude/tray.json'

function engine(
  on: any,
  opts: {
    rules: string | null
    rulesAt?: string
    ran?: string[][]
    prompts?: string[]
    bashText?: string
    links?: Record<string, string>
    toasts?: string[]
    mtime?: number
    folders?: string
    spawned?: string[][]
    forks?: string[]
    completes?: { model: string; prompt: string }[]
    quickRefused?: boolean
    agents?: { status: string }[]
  },
) {
  const clock = mock.clock(on, { now: 10_000_000 })
  mock.env(on, { HOME: '/Users/x', TMPDIR: '/tmp/' })
  on('command.register', () => ({ value: { command: 'tray' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__open-tray__offer' } }))
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Box({ children: [] }))
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('session.repo', () => ({ value: { root: '/w', remote: null, internal: false, name: null } }))
  on('session.cwd', () => ({ value: '/w' }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', ($: any, e: any) => {
    opts.toasts?.push(String(e.text))
    return { value: undefined }
  })
  const kept: Record<string, unknown> = {}
  on('store.get', ($: any, e: any) => ({ value: kept[e.key] }))
  on('store.set', ($: any, e: any) => {
    kept[e.key] = e.value
    return { value: undefined }
  })
  on('prompt.submit', ($: any, e: any) => {
    opts.prompts?.push(e.text)
    return { text: e.text }
  })
  on('fs.read', ($: any, e: any) => {
    if (opts.rules && e.path === (opts.rulesAt ?? OWN_RULES)) return { value: opts.rules }
    throw new Error('ENOENT')
  })
  on('fs.stat', ($: any, e: any) => {
    const to = opts.links?.[e.path]
    return { value: { kind: 'file', size: 10, mtimeMs: opts.mtime ?? 9_000_000, isLink: Boolean(to), ...(e.resolve ? { realPath: to ?? e.path } : {}) } }
  })
  on('process.run', ($: any, e: any) => {
    opts.ran?.push([...e.argv])
    const script = String(e.argv[2] ?? '')
    if (e.argv[0] === 'ffplay') return out('ffplay version 9\n')
    if (e.argv[0] === 'ffprobe') return out('600.000000\n')
    if (e.argv[0] === 'lsof') return out('4242\n')
    if (e.argv[0] === 'ps') return out('/usr/local/bin/node\n')
    if (e.argv[0] === '/bin/sh' && script.includes('-mindepth 1 -maxdepth 2')) return out(opts.folders ?? '')
    if (e.argv[0] === '/bin/sh' && script.includes(' find ')) {
      if (script.includes("'lessons/m02-'")) return out('lessons/m02-l01/opening.mp4\n')
      if (script.includes("'lessons/m03-'")) return out('lessons/m03-l01/knowledge.mp4\n')
      if (script.includes("'src/ui'")) return out('src/ui/demo.mp4\nsrc/ui/node_modules/x/skip.mp4\n')
      return out('')
    }
    if (e.argv[0] === '/bin/sh') {
      if (script.includes("'lessons/m02-'")) return out('lessons/m02-l01\nlessons/m02-l02\n')
      return out('')
    }
    return out('')
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: opts.bashText ?? '' }) as any)
  for (const tool of ['Read', 'Edit', 'Write']) {
    on('tool.call', { tool }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as any)
  }
  // ffplay plays until the clock passes the hour, or the stream is closed.
  on('process.spawn', async function* (_$: any, e: any) {
    opts.spawned?.push([...e.argv])
    await clock.sleep(3_600_000)
    return { code: 0, signal: null }
  } as any)
  on('model.fork', ($: any, e: any) => {
    opts.forks?.push(e.prompt)
    return {
      value: {
        isAnswered: true,
        text: '{"did": ["Built the player"], "waiting": ["Try it on a real film"], "next": "Phase 2: the recap"}',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }
  })
  // Haiku answers five seconds later, so a test can press while it writes.
  on('model.complete', async ($: any, e: any) => {
    opts.completes?.push({ model: e.model, prompt: String(e.prompt) })
    if (opts.quickRefused) return { value: { isAnswered: false, reason: 'api-error', status: 400, error: 'invalid_request' } }
    await clock.sleep(5000)
    return {
      value: {
        isAnswered: true,
        text: '{"did": ["Changed three files"], "waiting": [], "next": "Test it"}',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }
  })
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'make the player quieter', toolUses: [] },
      { role: 'assistant', text: 'On it.', toolUses: [{ tool_use_id: 'u1', tool: 'Edit', input: { file_path: '/w/src/f0.ts' } }] },
    ],
  }))
  on('agent.list', () => ({ value: opts.agents ?? [] }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.close', () => ({ value: undefined }))

  return clock
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' } as any)
const say = ($: any, text: string) => $.prompt.submit({ text, origin: { kind: 'composer' } } as any)
const turnEnds = ($: any) => $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1000, isAborted: false, turnId: 't' } as any)

describe('open-tray', () => {
  test('what Claude opens lands in "Made this session" and opens again from it', async ($, on) => {
    const ran: string[][] = []
    engine(on, { rules: null, ran })
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'cd films && open opening.mp4' } as any)
    const ui = await $.ui.mount(PANE)

    expect(await ui.find({ type: 'Text', text: /^MADE THIS SESSION$/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /opening\.mp4/ })).toBeDefined()
    ran.length = 0
    await ui.press({ key: 'finder' })
    expect(ran).toContainEqual(['open', '-R', '/w/films/opening.mp4'])
    await ui.unmount()
  })

  test('the offer tool adds to the session, or suggests for the area', async ($, on) => {
    engine(on, { rules: RULES })
    await start($)
    await say($, 'work on module 2')
    await $.tool.call({ tool: 'mcp__open-tray__offer', target: 'http://127.0.0.1:4620/', label: 'm02 player' } as any)
    await $.tool.call({ tool: 'mcp__open-tray__offer', target: '/w/notes/plan.pdf', suggest: true } as any)
    const ui = await $.ui.mount(PANE)

    expect(await ui.find({ type: 'Button', text: /m02 player/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Suggested/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: / Module 2 / })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /plan\.pdf/ })).toBeDefined()
    await ui.unmount()
  })

  test('with rules: naming a module fills Related, and the next module swaps it out', async ($, on) => {
    const prompts: string[] = []
    engine(on, { rules: RULES, prompts })
    await start($)
    const ui = await $.ui.mount(PANE)

    await say($, "let's polish module 2")
    expect(await ui.find({ type: 'Text', text: /^MODULE 2$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Lesson films/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /opening\.mp4/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /Start m02-l02/ })).toBeDefined()

    await say($, 'now module 3')
    expect(await ui.find({ type: 'Button', text: /knowledge\.mp4/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /opening\.mp4/ })).toBeUndefined()
    await ui.unmount()
  })

  test('without rules: the folder Claude keeps working in becomes the area', async ($, on) => {
    engine(on, { rules: null })
    await start($)
    const ui = await $.ui.mount(PANE)

    await $.tool.call({ tool: 'Read', file_path: '/w/src/ui/a.ts' } as any)
    await $.tool.call({ tool: 'Edit', file_path: '/w/src/ui/b.ts', old_string: 'a', new_string: 'b' } as any)
    expect(await ui.find({ type: 'Button', text: /demo\.mp4/ })).toBeUndefined()
    await $.tool.call({ tool: 'Read', file_path: '/w/src/ui/c.ts' } as any)

    expect(await ui.find({ type: 'Text', text: /^SRC\/UI$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Newest here/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /demo\.mp4/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /skip\.mp4/ })).toBeUndefined()
    await ui.unmount()
  })

  test('keep moves a related item into the session, so it survives the next area', async ($, on) => {
    engine(on, { rules: RULES })
    await start($)
    const ui = await $.ui.mount(PANE)

    await say($, 'module 2 please')
    await ui.press({ key: 'keep' })
    await say($, 'module 3 now')

    expect(await ui.find({ type: 'Button', text: /opening\.mp4/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /knowledge\.mp4/ })).toBeDefined()
    await ui.unmount()
  })

  test('a server the rules spot shows in the servers card with its tag', async ($, on) => {
    engine(on, { rules: RULES, bashText: 'Review player ready at http://127.0.0.1:4620/' })
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'pnpm review m02-l01' } as any)
    const ui = await $.ui.mount(PANE)

    expect(await ui.find({ type: 'Text', text: /^Local servers$/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /m02-l01\s+http:\/\/127\.0\.0\.1:4620\// })).toBeDefined()
    await ui.unmount()
  })

  test('an empty tray says what will land in it', async ($, on) => {
    engine(on, { rules: null })
    await start($)
    const ui = await $.ui.mount(PANE)

    expect(await ui.find({ type: 'Text', text: /^Nothing here yet\.$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /PLAYER 1 READY/ })).toBeDefined()
    await ui.unmount()
  })

  test('any project: a dev server shows in the players card without rules', async ($, on) => {
    engine(on, { rules: null, bashText: '  ➜  Local:   http://localhost:5173/' })
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'pnpm dev' } as any)
    const ui = await $.ui.mount(PANE)

    expect(await ui.find({ type: 'Text', text: /^Local servers$/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /http:\/\/localhost:5173\// })).toBeDefined()
    await ui.unmount()
  })

  test("a repo's own rules wait for /tray trust, and a changed file asks again", async ($, on) => {
    const toasts: string[] = []
    const opts = { rules: RULES, rulesAt: REPO_RULES, toasts }
    engine(on, opts)
    await start($)
    expect(toasts.some(t => /tray trust/.test(t))).toBe(true)
    const ui = await $.ui.mount(PANE)
    await say($, 'module 2')
    expect(await ui.find({ type: 'Text', text: /^MODULE 2$/ })).toBeUndefined()

    const trusted = await $.command.run({ command: 'tray', args: 'trust' } as any)
    expect((trusted as any).text).toMatch(/using this repo's rules/)
    await say($, 'module 2')
    expect(await ui.find({ type: 'Text', text: /^MODULE 2$/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /Start m02-l02/ })).toBeDefined()
    await ui.unmount()

    // a reload with the same file: still trusted; an edited file: not
    await start($)
    expect(toasts.filter(t => /tray trust/.test(t)).length).toBe(1)
    opts.rules = RULES.replace('Lesson films', 'Films')
    await start($)
    expect(toasts.filter(t => /tray trust/.test(t)).length).toBe(2)
  })

  test('only films, audio, images, pages and documents open; anything else, or a link to it, is shown in Finder', async ($, on) => {
    const ran: string[][] = []
    engine(on, { rules: null, ran, links: { '/w/films/film.mp4': '/w/evil.command' } })
    await start($)
    const openNewest = async (target: string) => {
      await $.tool.call({ tool: 'mcp__open-tray__offer', target } as any)
      const ui = await $.ui.mount(PANE)
      ran.length = 0
      await ui.press({ key: 'open' })
      await ui.unmount()
    }

    await openNewest('/w/films/cut.mp4')
    expect(ran).toContainEqual(['open', '/w/films/cut.mp4'])

    for (const target of ['/w/tools/setup.command', '/w/tools/run', '/w/x.mobileconfig']) {
      await openNewest(target)
      expect(ran).toContainEqual(['open', '-R', target])
      expect(ran).not.toContainEqual(['open', target])
    }

    await openNewest('/w/films/film.mp4')
    expect(ran).toContainEqual(['open', '-R', '/w/evil.command'])
    expect(ran.some(argv => argv.length === 2 && argv[0] === 'open')).toBe(false)
  })

  test('listen plays a film\'s sound in the tray, with pause, jump and stop as buttons', async ($, on) => {
    const spawned: string[][] = []
    const toasts: string[] = []
    const clock = engine(on, { rules: null, spawned, toasts })
    await start($)
    await $.tool.call({ tool: 'mcp__open-tray__offer', target: '/w/films/cut.mp4' } as any)
    const ui = await $.ui.mount(PANE)
    expect(await ui.find({ type: 'Text', text: /NOW PLAYING/ })).toBeUndefined()

    await ui.press({ key: 'audio' })
    expect(spawned.at(-1)).toEqual(['ffplay', '-nodisp', '-vn', '-autoexit', '-loglevel', 'error', '-ss', '0.00', '/w/films/cut.mp4'])
    expect(await ui.find({ type: 'Text', text: /^NOW PLAYING$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^0:00 \/ 10:00$/ })).toBeDefined()

    await clock.advance(30_000)
    expect(await ui.find({ type: 'Text', text: /^0:30 \/ 10:00$/ })).toBeDefined()

    await ui.press({ key: 'play' })
    expect(await ui.find({ type: 'Text', text: /^PAUSED$/ })).toBeDefined()
    await ui.press({ key: 'ahead-60' })
    expect(await ui.find({ type: 'Text', text: /^1:30 \/ 10:00$/ })).toBeDefined()
    expect(spawned.length).toBe(1)

    await ui.press({ key: 'play' })
    expect(spawned.at(-1)).toContain('90.00')
    await ui.press({ key: 'back-10' })
    expect(spawned.at(-1)).toContain('80.00')

    await ui.press({ key: 'stop' })
    expect(await ui.find({ type: 'Text', text: /NOW PLAYING|PAUSED/ })).toBeUndefined()

    // Not a film or audio file: nothing plays. (The kit cannot close a pane,
    // so "closing the pane stops it" is checked live.)
    await $.tool.call({ tool: 'mcp__open-tray__offer', target: '/w/notes/plan.pdf' } as any)
    await ui.press({ key: 'audio' })
    expect(toasts).toContain('Listen works on a film or an audio file')
    expect(spawned.length).toBe(3)
    await ui.unmount()
  })

  test('a film, picture or page Claude writes lands in the tray; a note it writes does not', async ($, on) => {
    engine(on, { rules: null })
    await start($)
    await $.tool.call({ tool: 'Write', file_path: '/w/out/logo.svg', content: '<svg/>' } as any)
    await $.tool.call({ tool: 'Write', file_path: '/w/out/review.html', content: '<p>' } as any)
    await $.tool.call({ tool: 'Write', file_path: '/w/NOTES.md', content: '# hi' } as any)
    const ui = await $.ui.mount(PANE)

    expect(await ui.find({ type: 'Button', text: /logo\.svg/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /review\.html/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /NOTES\.md/ })).toBeUndefined()
    await ui.unmount()
  })

  test("new files the main loop prints land; a subagent's printed paths do not, but what it opens does", async ($, on) => {
    const state = { text: '' }
    engine(on, { rules: null, mtime: 9_900_000, get bashText() { return state.text } } as any)
    await start($)
    state.text = 'wrote /w/out/sub.png'
    await $.tool.call({ tool: 'Bash', command: 'make shots', agentId: 'sub-1' } as any)
    await $.tool.call({ tool: 'Bash', command: 'open /w/out/opened.pdf', agentId: 'sub-1' } as any)
    state.text = 'wrote /w/out/main.png and /w/out/page.html'
    await $.tool.call({ tool: 'Bash', command: 'make shots' } as any)
    const ui = await $.ui.mount(PANE)

    expect(await ui.find({ type: 'Button', text: /sub\.png/ })).toBeUndefined()
    expect(await ui.find({ type: 'Button', text: /opened\.pdf/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /main\.png/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /page\.html/ })).toBeDefined()
    await ui.unmount()
  })

  test('without rules: a prompt naming a folder switches at once, and work inside it holds', async ($, on) => {
    engine(on, { rules: null, folders: './context-gauge\n./context-gauge/hooks\n./open-tray\n./open-tray/hooks\n./src\n' })
    await start($)
    const ui = await $.ui.mount(PANE)

    await say($, "let's polish context-gauge today")
    expect(await ui.find({ type: 'Text', text: /^ ◆ context-gauge $/ })).toBeDefined()

    // "hooks" is in two places and "src" is generic: neither names an area.
    await say($, 'fix the hooks in src')
    expect(await ui.find({ type: 'Text', text: /^ ◆ context-gauge $/ })).toBeDefined()

    for (const name of ['a', 'b', 'c']) await $.tool.call({ tool: 'Read', file_path: `/w/context-gauge/hooks/${name}.ts` } as any)
    expect(await ui.find({ type: 'Text', text: /^ ◆ context-gauge $/ })).toBeDefined()

    await say($, 'now open-tray/hooks')
    expect(await ui.find({ type: 'Text', text: /^ ◆ open-tray\/hooks $/ })).toBeDefined()
    await ui.unmount()
  })

  test('a server can be stopped from the tray, then restarted or removed', async ($, on) => {
    const ran: string[][] = []
    const prompts: string[] = []
    engine(on, { rules: null, ran, prompts, bashText: '  ➜  Local:   http://localhost:5173/' })
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'pnpm dev' } as any)
    const ui = await $.ui.mount(PANE)

    await ui.press({ key: 'stop-0' })
    expect(ran).toContainEqual(['lsof', '-nP', '-t', '-iTCP:5173', '-sTCP:LISTEN'])
    expect(ran).toContainEqual(['kill', '-TERM', '4242'])
    expect(await ui.find({ type: 'Text', text: /^○ $/ })).toBeDefined()

    await ui.press({ key: 'restart-0' })
    expect(prompts.some(p => /localhost:5173.*Restart it/.test(p))).toBe(true)

    await ui.press({ key: 'drop-0' })
    expect(await ui.find({ type: 'Text', text: /^Local servers$/ })).toBeUndefined()
    await ui.unmount()
  })

  test('after a stretch of work, once no subagent is at it, Haiku writes a quick recap; "recap now" writes a detailed one on the session model', async ($, on) => {
    const forks: string[] = []
    const completes: { model: string; prompt: string }[] = []
    const agents = [{ status: 'running' }]
    const clock = engine(on, { rules: null, forks, completes, agents })
    await start($)
    for (let i = 0; i < 3; i++) {
      await $.tool.call({ tool: 'Edit', file_path: `/w/src/f${i}.ts`, old_string: 'a', new_string: 'b', agentId: 'sub-1' } as any)
    }
    await turnEnds($)
    await clock.advance(5000)
    expect(completes.length).toBe(0)

    agents.length = 0
    await turnEnds($)
    await clock.settle()
    const ui = await $.ui.mount(PANE)
    await clock.advance(5000)
    expect(completes.length).toBe(1)
    expect(forks.length).toBe(0)
    expect(completes[0]!.model).toBe('haiku')
    expect(completes[0]!.prompt).toContain('PERSON: make the player quieter')
    expect(completes[0]!.prompt).toContain('[Edit] /w/src/f0.ts')

    expect(await ui.find({ type: 'Text', text: /^ ●$/ })).toBeDefined()
    await ui.press({ key: 'tab-recap' })
    expect(await ui.find({ type: 'Text', text: /^ ●$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^WHAT WE DID$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Changed three files$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /quick \(Haiku\)$/ })).toBeDefined()

    // A turn with no work after it writes nothing.
    await turnEnds($)
    await clock.advance(5000)
    expect(completes.length).toBe(1)

    // "Recap now": detailed, from the session's own conversation.
    await ui.press({ key: 'recap-now' })
    expect(await ui.find({ type: 'Text', text: /^WRITING RECAP/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Detailed, on the session model/ })).toBeDefined()
    await clock.settle()
    expect(forks.length).toBe(1)
    expect(await ui.find({ type: 'Text', text: /^WRITING RECAP/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^Built the player$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Try it on a real film$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Phase 2: the recap$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /detailed$/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /older/ })).toBeDefined()

    await ui.press({ key: 'todo-0' })
    expect(await ui.find({ type: 'Button', text: /\[x\]/ })).toBeDefined()

    // Pressed while a quick one is being written: the detailed one follows it.
    for (let i = 3; i < 6; i++) {
      await $.tool.call({ tool: 'Edit', file_path: `/w/src/f${i}.ts`, old_string: 'a', new_string: 'b' } as any)
    }
    await turnEnds($)
    await clock.settle()
    expect(await ui.find({ type: 'Text', text: /^Quick, on Haiku/ })).toBeDefined()
    await ui.press({ key: 'recap-now' })
    await clock.advance(5000)
    expect(completes.length).toBe(2)
    expect(forks.length).toBe(2)
    expect(completes[1]!.prompt).toContain('<last_recap>')
    expect(await ui.find({ type: 'Text', text: /^WRITING RECAP/ })).toBeUndefined()
    await ui.unmount()
  })


  test('a run of Bash steps earns a quick recap too, and one that did not come says why', async ($, on) => {
    const completes: { model: string; prompt: string }[] = []
    const clock = engine(on, { rules: null, completes, quickRefused: true })
    await start($)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'tab-recap' })
    expect(await ui.find({ type: 'Text', text: /^Next quick recap: 0\/3 files, 0\/12 steps/ })).toBeDefined()
    for (let i = 0; i < 12; i++) await $.tool.call({ tool: 'Bash', command: `sed -i '' s/a/b/ f${i}.ts` } as any)
    expect(await ui.find({ type: 'Text', text: /12\/12 steps/ })).toBeDefined()
    await turnEnds($)
    await clock.advance(5000)
    expect(completes.length).toBe(1)
    expect(await ui.find({ type: 'Text', text: /^The last quick recap did not come: API error 400 invalid_request\.$/ })).toBeDefined()
    await ui.unmount()
  })

  test('/tray autorecap off leaves only the detailed recap; on brings the quick one back, and the choice is kept', async ($, on) => {
    const forks: string[] = []
    const completes: { model: string; prompt: string }[] = []
    const clock = engine(on, { rules: null, forks, completes })
    await start($)
    const off = await $.command.run({ command: 'tray', args: 'autorecap off' } as any)
    expect(String((off as any).text)).toMatch(/quick recaps are off/)
    for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Edit', file_path: `/w/src/f${i}.ts`, old_string: 'a', new_string: 'b' } as any)
    await turnEnds($)
    await clock.advance(5000)
    expect(completes.length).toBe(0)

    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'tab-recap' })
    expect(await ui.find({ type: 'Text', text: /^Quick recaps are off/ })).toBeDefined()
    await ui.press({ key: 'recap-now' })
    await clock.settle()
    expect(forks.length).toBe(1)

    // Kept across sessions: a new start reads it back.
    await start($)
    for (let i = 3; i < 6; i++) await $.tool.call({ tool: 'Edit', file_path: `/w/src/f${i}.ts`, old_string: 'a', new_string: 'b' } as any)
    await turnEnds($)
    await clock.advance(5000)
    expect(completes.length).toBe(0)

    await $.command.run({ command: 'tray', args: 'autorecap' } as any)
    await turnEnds($)
    await clock.advance(5000)
    expect(completes.length).toBe(1)
    await ui.unmount()
  })
})

describe('untrusted rules', () => {
  test('a depth from the rules cannot add to the shell command', () => {
    const script = findScript('/w', ['lessons/*'], ['*.mp4'], '6; touch /tmp/pwned' as unknown)
    expect(script).toContain('-maxdepth 6 ')
    expect(script).not.toContain('touch')
    expect(findScript('/w', ['x'], ['*.mp4'], 99)).toContain('-maxdepth 12 ')
    expect(findScript('/w', ['x'], ['*.mp4'], undefined)).toContain('-maxdepth 6 ')
  })

  test('a pattern that would backtrack forever, or is invalid, is ignored', () => {
    expect(regexOf('(a+)+$')).toBeNull()
    expect(regexOf('(\\w*)*x')).toBeNull()
    expect(regexOf('([a-z]+){2,}b')).toBeNull()
    expect(regexOf('(')).toBeNull()
    expect(regexOf('x'.repeat(301))).toBeNull()
    expect(regexOf('\\bm(\\d\\d)\\b', 'i')?.test('m02')).toBe(true)
    const evil = { areas: [{ key: 'a{1}', label: 'A', patterns: ['(a+)+$'] }] } as any
    const started = Date.now()
    expect(areaIn('a'.repeat(5000) + '!', evil)).toBeNull()
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test("an area's values match as text inside a rule's pathMatch", () => {
    const area = { key: 'x', label: 'x', values: { '1': 'a.b(', '1n': 'a.b(' } }
    const [plan] = relatedPlan(area, { related: [{ label: 'L', paths: ['p'], names: ['*'], pathMatch: 'dir/{1}' }] } as any)
    expect(plan?.pattern?.test('dir/a.b(')).toBe(true)
    expect(plan?.pattern?.test('dir/aXb(')).toBe(false)
  })
})
