# Open Tray

A Claude Code mod: a pane (`/tray`) of things to look at or listen to while
you work, so you never have to ask Claude to "open that in Finder" again.

- **Made this session**: whatever Claude opens for you, renders, or hands you
  with its `offer` tool. Stays until you remove it.
- **Related to what you're on**: found for the area you're working in and
  swapped out when you move on. With no setup, the area is the folder Claude
  is working in, and you get the newest films, audio, images, pages and PDFs
  there (skipping `node_modules`, builds, `.git` and archives).
- **Local servers**: dev servers Claude starts (`pnpm dev`, `npm run dev`,
  `vite`, `next dev`, `python -m http.server`, …) with a live/stopped dot.

Keys in the pane: `o`/Enter open · `f` show in Finder · `a` play a film's
audio only (needs `ffmpeg`) · `p` keep a related item · `x` remove ·
`j`/`k` move · `r` restart a stopped server. macOS (`open`).

## Teaching it your project

Rules tell the tray how to name an area ("Chapter 3") from your prompts and
file paths, and where that area's good stuff lives. Put them in either:

- `<repo>/.claude/tray.json` (travels with the repo), or
- `~/.claude/open-tray/rules/<repo folder name>.json` (yours alone).

Start from `examples/tray.json`; its `$comment` explains every field.

Actions (buttons that send Claude a prompt) are read only from your own
`~/.claude/open-tray/rules/` file, never from a repo's `.claude/tray.json`: a
button's label need not show the prompt it sends, so a repo you cloned could
otherwise hide one. Patterns that are invalid, very long or prone to
catastrophic backtracking are ignored, and the tray shows runnable files
(apps, scripts, executables) in Finder instead of launching them.
