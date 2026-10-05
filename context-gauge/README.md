# context-gauge

One line under the Claude Code prompt:

```
my-project/main · Opus 5.5 1M · high  ██████████░░ 52% · 520K free  ·  5h ███████░░░ 72% · 2:14:05  ·  wk 60%
```

| Piece | What it is |
|---|---|
| `my-project/main` | Repo and branch (shown from 100 columns) |
| `Opus 5.5 1M · high` | The model each request goes out with, its window, and effort |
| bar `52% · 520K free` | Room left in the context window |
| `5h` bar `72% · 2:14:05` | What's left of the plan's 5-hour usage window, and the time to its reset |
| `wk 60%` | What's left of the weekly window |

Colours: green, yellow under 20% left, red under 10%. The usage parts show only
on a Claude subscription (an API key or cloud provider reports no plan windows).
Under 100 columns the usage bar drops and `5h 72% · 2:14` stays.

## /gauge

`/gauge` (or `/gauge on`) swaps the line for a detailed view: one bar split by
what fills the context window, in `/context`'s own colours, sitting right on the
input, with a short key under it:

```
my-project/main · Opus 5.5 1M · high                      30% used · 667K free
███████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▒▒▒▒
> your prompt
■ sys 4K  ■ tools 18K  ■ memory 3K  ■ msgs 296K  ▒ buffer 33K
```

`/gauge off` goes back to the one line. The choice is remembered across sessions.
The breakdown is a local estimate (no API calls), refreshed after each turn and
at most every 3 seconds during one.

## Install

```sh
claude plugin marketplace add jakerains/claudemods
claude plugin install context-gauge@claudemods
```
