# Contributing

Thanks for looking. Workglance is small on purpose: one Node process, one SQLite file, no build step to run
it from source. Working with an AI agent? It should read [AGENTS.md](AGENTS.md) first (Claude Code does, through
`CLAUDE.md`): the rules below plus a map of the code and the traps we already fell into.

## Setup

```sh
git clone https://github.com/iceloh/workglance && cd workglance
npm install
npm test            # node:test, no database or network needed
npm run typecheck
npm run demo        # a board full of made-up work on http://127.0.0.1:4588
```

Node 24+ runs the TypeScript sources directly. To use your checkout as your real install:
`node --no-warnings src/cli.ts install` (hooks then point at your source tree).

## Before a pull request

- `npm test` and `npm run typecheck` pass.
- New behavior comes with a test next to the code (`foo.ts` → `foo.test.ts`). Prefer pure functions that
  take their inputs (a platform, a clock, rows) over mocks.
- `npm run build && npm pack && node scripts/smoke.mjs workglance-*.tgz` passes: it installs the package
  into a temp folder with its own Claude config and port, runs a hook, the server, doctor and uninstall.
  CI runs it on Windows, macOS and Linux.
- Decisions that are not obvious from the code go into `PLAN.md`.

## Ground rules

- Nothing leaves the user's machine without them asking for it.
- A hook must never break or noticeably slow a Claude Code tab.
- Don't guess: when Workglance can't know something (which card a commit belongs to, say), it asks the
  agent to say so instead of inferring it from timing.
