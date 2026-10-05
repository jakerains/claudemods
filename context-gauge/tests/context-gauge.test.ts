import { describe, expect, mock, test } from 'claude-code/testing'

const ok = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

describe('context-gauge', () => {
  test('one line under the prompt: branch, model, effort and context left', async ($, on) => {
    let tokens = 120_000
    mock.clock(on, { now: 1_000_000 })
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as any)
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('settings.read', () => ({ value: { effortLevel: 'high' } }))
    on('session.usage', () => ({
      value: { startedAt: 0, rateLimits: [], context: { tokens, window: 200_000, percent: Math.round(tokens / 2_000) } },
    }))
    on('process.run', ($, e) => ok(e.argv[1] === 'rev-parse' ? '/Users/x/my-project\n' : 'main\n'))
    on('ui.render', { component: 'PromptHint' }, ($, e) => $.ui.resolve(e).Text({ children: '? for shortcuts' }))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    const ui = await $.ui.mount({
      plugin: 'context-gauge',
      surface: 'terminal',
      component: 'PromptHint',
      props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
      viewport: { columns: 140, rows: 40 },
    } as any)

    expect(await ui.find({ type: 'Text', text: /my-project\/main/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Opus 5\.5/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /high/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: / 40%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /80K free/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /for shortcuts/ })).toBeDefined()

    tokens = 190_000
    await $.tool.call({ tool: 'Bash', command: 'true' } as any)
    expect(await ui.find({ type: 'Text', text: / 5%/ })).toBeDefined()
    expect(await ui.find({ type: 'Raster' })).toBeUndefined()
    await ui.unmount()
  })

  test('/gauge swaps the line for a detailed band above the prompt, and back', async ($, on) => {
    const store: Record<string, unknown> = {}
    mock.clock(on, { now: 1_000_000 })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('settings.read', () => ({ value: { effortLevel: 'high' } }))
    on('command.register', () => ({ value: { command: 'gauge' } }) as any)
    on('store.get', ($, e) => ({ value: store[e.key] }))
    on('store.set', ($, e) => {
      store[e.key] = e.value
      return { value: undefined } as any
    })
    on('session.usage', ($, e) => ({
      value: {
        startedAt: 0,
        rateLimits: [],
        context: {
          tokens: 300_000,
          window: 1_000_000,
          percent: 30,
          ...(e.breakdown
            ? {
                breakdown: {
                  categories: [
                    { name: 'System prompt', tokens: 4_000, color: 'promptBorder', isDeferred: false, kind: 'used' },
                    { name: 'MCP tools', tokens: 50_000, color: 'cyan_FOR_SUBAGENTS_ONLY', isDeferred: true, kind: 'deferred' },
                    { name: 'Messages', tokens: 296_000, color: 'purple_FOR_SUBAGENTS_ONLY', isDeferred: false, kind: 'used' },
                    { name: 'Free space', tokens: 667_000, color: 'promptBorder', isDeferred: false, kind: 'free' },
                    { name: 'Autocompact buffer', tokens: 33_000, color: 'inactive', isDeferred: false, kind: 'buffer' },
                  ],
                  totalTokens: 300_000,
                  maxTokens: 1_000_000,
                  rawMaxTokens: 1_000_000,
                  percentage: 30,
                },
              }
            : {}),
        },
      },
    }) as any)
    on('process.run', () => ok('/Users/x/claudemods\n'))
    on('ui.render', { component: 'PromptHint' }, ($, e) => $.ui.resolve(e).Text({ children: '? for shortcuts' }))
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({}))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    const hint = await $.ui.mount({
      plugin: 'context-gauge',
      surface: 'terminal',
      component: 'PromptHint',
      props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
      viewport: { columns: 140, rows: 40 },
    } as any)
    const above = await $.ui.mount({
      plugin: 'context-gauge',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 140 },
      viewport: { columns: 140, rows: 40 },
    } as any)
    expect(await hint.find({ type: 'Text', text: /free/ })).toBeDefined()
    expect(await above.find({ type: 'Text', text: /Messages/ })).toBeUndefined()

    const on1 = await $.command.run({ command: 'gauge', args: '' } as any)
    expect((on1 as any).text).toMatch(/detailed/)
    expect(store.detail).toBe(true)
    expect(await above.find({ type: 'Text', text: /30% used/ })).toBeDefined()
    expect(await above.find({ type: 'Text', text: /667K free/ })).toBeDefined()
    expect(await above.find({ type: 'Text', text: /█/ })).toBeDefined()
    // The key moved under the input, with short labels.
    expect(await above.find({ type: 'Text', text: /^msgs$/ })).toBeUndefined()
    expect(await hint.find({ type: 'Text', text: /^msgs$/ })).toBeDefined()
    expect(await hint.find({ type: 'Text', text: /^sys$/ })).toBeDefined()
    expect(await hint.find({ type: 'Text', text: /^buffer$/ })).toBeDefined()
    expect(await hint.find({ type: 'Text', text: / 296K/ })).toBeDefined()
    expect(await hint.find({ type: 'Text', text: /^mcp$/ })).toBeUndefined()
    expect(await hint.find({ type: 'Text', text: /free/ })).toBeUndefined()
    expect(await hint.find({ type: 'Text', text: /for shortcuts/ })).toBeDefined()

    await $.command.run({ command: 'gauge', args: 'off' } as any)
    expect(store.detail).toBe(false)
    expect(await above.find({ type: 'Text', text: /used/ })).toBeUndefined()
    expect(await hint.find({ type: 'Text', text: /^msgs$/ })).toBeUndefined()
    expect(await hint.find({ type: 'Text', text: /free/ })).toBeDefined()
    await hint.unmount()
    await above.unmount()
  })

  test('the 5-hour usage window drains from 100% beside the context bar, with a countdown to its reset', async ($, on) => {
    const resetsAt = new Date(Date.now() + (2 * 3600 + 14 * 60 + 5) * 1000).toISOString()
    let used = 28
    mock.clock(on, { now: 1_000_000 })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('settings.read', () => ({ value: {} }))
    on('command.register', () => ({ value: { command: 'gauge' } }) as any)
    on('store.get', () => ({ value: undefined }))
    on('session.usage', () => ({
      value: {
        startedAt: 0,
        rateLimits: [
          { kind: 'five_hour', percentUsed: used, resetsAt },
          { kind: 'seven_day', percentUsed: 40 },
        ],
        context: { tokens: 100_000, window: 1_000_000, percent: 10 },
      },
    }) as any)
    on('process.run', () => ok('/Users/x/claudemods\n'))
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as any)
    on('ui.render', { component: 'PromptHint' }, ($, e) => $.ui.resolve(e).Text({ children: '? for shortcuts' }))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    const mount = (columns: number) =>
      $.ui.mount({
        plugin: 'context-gauge',
        surface: 'terminal',
        component: 'PromptHint',
        props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
        viewport: { columns, rows: 40 },
      } as any)

    const wide = await mount(140)
    expect(await wide.find({ type: 'Text', text: /900K free/ }), 'context').toBeDefined()
    expect(await wide.find({ type: 'Text', text: /5h/ }), 'label').toBeDefined()
    expect(await wide.find({ type: 'Text', text: /^72%$/ }), 'left').toBeDefined()
    expect(await wide.find({ type: 'Text', text: /^ · 2:1[34]:\d\d$/ }), 'countdown').toBeDefined()
    expect(await wide.find({ type: 'Text', text: /wk/ }), 'weekly label').toBeDefined()
    expect(await wide.find({ type: 'Text', text: /^60%$/ }), 'weekly left').toBeDefined()

    used = 95
    await $.tool.call({ tool: 'Bash', command: 'true' } as any)
    expect(await wide.find({ type: 'Text', text: /^5%$/ }), 'drained').toBeDefined()
    await wide.unmount()

    const narrow = await mount(80)
    expect(await narrow.find({ type: 'Text', text: /^ · 2:1[34]$/ }), 'narrow countdown').toBeDefined()
    await narrow.unmount()
  })

  test('off a subscription there is no usage window and no usage bar', async ($, on) => {
    mock.clock(on, { now: 1_000_000 })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('settings.read', () => ({ value: {} }))
    on('command.register', () => ({ value: { command: 'gauge' } }) as any)
    on('store.get', () => ({ value: undefined }))
    on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { tokens: 100_000, window: 1_000_000, percent: 10 } } }) as any)
    on('process.run', () => ok('/Users/x/claudemods\n'))
    on('ui.render', { component: 'PromptHint' }, ($, e) => $.ui.resolve(e).Text({ children: '? for shortcuts' }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    const ui = await $.ui.mount({
      plugin: 'context-gauge',
      surface: 'terminal',
      component: 'PromptHint',
      props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
      viewport: { columns: 140, rows: 40 },
    } as any)
    expect(await ui.find({ type: 'Text', text: /900K free/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5h/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /wk/ })).toBeUndefined()
    await ui.unmount()
  })
})
