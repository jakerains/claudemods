# POWERTRAY (open-tray)

A Claude Code mod: a pane (`/tray`) of things to look at or listen to while
you work, so you never have to ask Claude to "open that in Finder" again, and
a recap of what a big move did and what comes next. The plugin is still
`open-tray`; POWERTRAY is what the pane is called.

## Tray tab (`1`)

- **Made this session**: whatever Claude opens for you, writes (films, audio,
  images, SVGs, pages, PDFs), renders, or hands you with its `offer` tool.
  Stays until you remove it.
- **Related to what you're on**: found for the area you're working in and
  swapped out when you move on. With no setup, the area is the folder Claude
  is working in, or one your prompt names ("let's polish context-gauge"), and
  you get the newest films, audio, images, pages and PDFs there (skipping
  `node_modules`, builds, `.git` and archives).
- **Local servers**: dev servers Claude starts (`pnpm dev`, `npm run dev`,
  `vite`, `next dev`, `python -m http.server`, …) with a live/stopped dot, and
  **stop** (ends what listens on that port), **restart** (asks Claude) and
  **remove** on each.

Keys in the pane: `o`/Enter open · `f` show in Finder · `a` listen (a film's
sound, or an audio file, in the tray) · `p` keep a related item · `x` remove ·
`j`/`k` move. macOS (`open`).

**Listening.** `a` plays the sound in the tray with no window, through
`ffplay` (comes with `brew install ffmpeg`; without it, the file opens in its
app). A NOW PLAYING card shows while it plays, with click-only buttons:
play/pause, −1m, −10s, +10s, +1m and stop. Closing the pane stops it.

## Recap tab (`2`)

After a big move (2+ subagents, or 8+ files changed since the last recap),
once no subagent is still running, the tray writes a short recap in plain
words:

- **What we did**
- **Waiting on you**: what you have to do before work can go on (review,
  test, decide), with boxes to tick
- **Next up**: the next step or phase by the plan you talked through

A dot on the tab means a new one. `r` (recap now) or `/tray recap` writes one
whenever you like; the last five are kept (◂ older / newer ▸). The recap is
one extra model call over the session's own conversation, mostly read from
the prompt cache.

## Teaching it your project

Rules tell the tray how to name an area ("Chapter 3") from your prompts and
file paths, and where that area's good stuff lives. Put them in either:

- `<repo>/.claude/tray.json` (travels with the repo), or
- `~/.claude/open-tray/rules/<repo folder name>.json` (yours alone).

Start from `examples/tray.json`; its `$comment` explains every field.

Rules decide which searches run and which patterns run on your prompts, so a
repo's `.claude/tray.json` is not used until you trust it: the tray tells you
it's there, you read it, then `/tray trust` (`/tray untrust` to stop). Trust is
for that exact content; if the file changes, the tray asks again. Your own
`~/.claude/open-tray/rules/` file is always used, and wins over the repo's.

`open` resolves links first and opens only films, audio, images, pages,
documents and folders; anything else (apps, scripts, bundles, profiles) is
shown in Finder instead of launched.
