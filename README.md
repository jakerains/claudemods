<p align="center"><img src="assets/hero.png" alt="claudemods: a little wind-up robot tuning gauge bars on a retro terminal" width="100%"></p>

# claudemods

Small mods for [Claude Code](https://code.claude.com): gauges and panes that live
right around the prompt. Each one is a plugin whose behaviour is a function-hooks
module, and this repo is a plugin marketplace you can install them from.

## Install

```sh
claude plugin marketplace add jakerains/claudemods
claude plugin install context-gauge@claudemods
claude plugin install prompt-cache-control@claudemods
claude plugin install open-tray@claudemods
```

Install any or all. Then `/reload-plugins` (or restart Claude Code).
Mods are on by default from Claude Code 2.1.287; 2.1.259 to 2.1.286 need
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.

Update later with `claude plugin marketplace update claudemods` and
`claude plugin update <mod>@claudemods`.

## The mods

### context-gauge

One line under the prompt: where you are, which model, how much context is left,
and on a Claude subscription how much of your plan's usage is left.

```
my-project/main · Opus 5.5 1M · high  ██████████░░ 52% · 520K free  ·  5h ███████░░░ 72% · 2:14:05  ·  wk 60%
```

- **Context bar**: room left in the context window.
- **5h**: what's left of the 5-hour usage window, draining 100% → 0, with a live
  countdown to its reset. **wk**: what's left of the weekly window.
- Green, then yellow under 20% left, red under 10%.
- `/gauge` swaps the line for a colour-coded breakdown of what fills the context
  (system prompt, tools, memory, skills, messages…) right above the input;
  `/gauge off` goes back. Remembered.

[More →](context-gauge/README.md)

### prompt-cache-control

A prompt-cache meter above the prompt: how much of each request the cache served,
a countdown to when it lapses, and what to do about it (keep going, `/compact`,
`/clear`).

```
● cache ██████████ 98%  read 285k  wrote 368  new 2  ⏱ 59:46  1h · warm: keep going
```

- `/cache` opens a per-turn table; `/cache stop` closes it.
- `/cache off` / `/cache on` hides or shows the bar. Remembered.

Adapted from [claude-code-templates](https://github.com/davila7/claude-code-templates)
(MIT, Daniel Ávila): history survives reloads, and the bar shares the space above
the prompt with other mods. [More →](prompt-cache-control/README.md)

### open-tray (POWERTRAY)

A pane (`/tray`) of things to look at or listen to while you work: what Claude
made or opened this session, things related to the area you're in, and local dev
servers you can stop or restart. `a` plays a film's sound right in the tray. A
Recap tab says, after a big move, what was done, what waits on you and what
comes next. macOS. [More →](open-tray/README.md)

## Develop

Each mod is a folder: `.claude-plugin/plugin.json`, `hooks/` (the module),
`types/` (its state contract) and `tests/`.

```sh
claude --plugin-dir ./context-gauge     # try it, hot-reloading on save
claude plugin validate context-gauge
claude plugin test context-gauge
```

## License

MIT. See [LICENSE](LICENSE); prompt-cache-control keeps its original notice in
[its own LICENSE](prompt-cache-control/LICENSE).
