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

function engine(on: any, opts: { rules: string | null; rulesAt?: string; ran?: string[][]; prompts?: string[]; bashText?: string; executable?: string[] }) {
  mock.clock(on, { now: 10_000_000 })
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
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', ($: any, e: any) => {
    opts.prompts?.push(e.text)
    return { text: e.text }
  })
  on('fs.read', ($: any, e: any) => {
    if (opts.rules && e.path === (opts.rulesAt ?? '/w/.claude/tray.json')) return { value: opts.rules }
    throw new Error('ENOENT')
  })
  on('fs.stat', () => ({ value: { kind: 'file', size: 10, mtimeMs: 9_000_000, isLink: false } }))
  on('process.run', ($: any, e: any) => {
    opts.ran?.push([...e.argv])
    if (e.argv[0] === 'test') {
      const isX = opts.executable?.includes(e.argv[2])
      return { value: { exitCode: isX ? 0 : 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const script = String(e.argv[2] ?? '')
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
  for (const tool of ['Read', 'Edit']) {
    on('tool.call', { tool }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as any)
  }
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' } as any)
const say = ($: any, text: string) => $.prompt.submit({ text, origin: { kind: 'composer' } } as any)

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
    // Actions come only from the person's own rules, never a repo's (see below).
    expect(await ui.find({ type: 'Button', text: /Start m02-l02/ })).toBeUndefined()

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
    expect(await ui.find({ type: 'Text', text: /following your work/ })).toBeDefined()
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

  test("rules can live in the person's own folder instead of the repo, and only there may they have actions", async ($, on) => {
    const prompts: string[] = []
    engine(on, { rules: RULES, rulesAt: '/Users/x/.claude/open-tray/rules/w.json', prompts })
    await start($)
    const ui = await $.ui.mount(PANE)
    await say($, 'module 2')

    expect(await ui.find({ type: 'Text', text: /^MODULE 2$/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /opening\.mp4/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /Start m02-l02/ })).toBeDefined()
    await ui.unmount()
  })

  test('a runnable file (by suffix, or executable) is shown in Finder, never launched', async ($, on) => {
    const ran: string[][] = []
    engine(on, { rules: null, ran, executable: ['/w/tools/run'] })
    await start($)
    await $.tool.call({ tool: 'mcp__open-tray__offer', target: '/w/tools/setup.command' } as any)
    const ui = await $.ui.mount(PANE)
    ran.length = 0
    await ui.press({ key: 'open' })
    expect(ran).toContainEqual(['open', '-R', '/w/tools/setup.command'])
    expect(ran).not.toContainEqual(['open', '/w/tools/setup.command'])
    await ui.unmount()

    await $.tool.call({ tool: 'mcp__open-tray__offer', target: '/w/tools/run' } as any)
    const ui2 = await $.ui.mount(PANE)
    ran.length = 0
    await ui2.press({ key: 'open' })
    expect(ran).toContainEqual(['open', '-R', '/w/tools/run'])
    await ui2.unmount()
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
