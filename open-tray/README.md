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

Rules decide which searches run and which patterns run on your prompts, so a
repo's `.claude/tray.json` is not used until you trust it: the tray tells you
it's there, you read it, then `/tray trust` (`/tray untrust` to stop). Trust is
for that exact content; if the file changes, the tray asks again. Your own
`~/.claude/open-tray/rules/` file is always used, and wins over the repo's.

`open` resolves links first and opens only films, audio, images, pages,
documents and folders; anything else (apps, scripts, bundles, profiles) is
shown in Finder instead of launched.
