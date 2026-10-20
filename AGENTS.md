# Working on Workglance (for AI coding agents)

Read this before changing anything. Humans: see CONTRIBUTING.md; this file says the same and more, for agents.

## Commands

```sh
npm test               # node:test, all *.test.ts next to their code; no network, no real data
npm run typecheck      # tsc strict, must stay at zero errors
npm run build          # esbuild bundles into dist/ (what npm publishes)
npm pack && node scripts/smoke.mjs workglance-*.tgz   # the first-run path in a temp install
npm run demo           # a made-up board on http://127.0.0.1:4588
```

Node 24+ runs `src/*.ts` directly (type stripping; imports keep the `.ts` extension).

## Map

- **Capture:** `hook.ts` (Claude Code hooks: stamping, live status, nudges), `transcript.ts` (one transcript line ->
  facts; parse defensively, the format is undocumented), `scan.ts` (incremental reading), `git.ts`, `commits.ts`.
- **Cards:** `tasks.ts` (all state changes and their history), `tools.ts` + `mcp.ts` (the agent's tools),
  `replay.ts` (calls that failed while the server was down), `protocol.ts` (**what every agent is told**).
- **Board:** `server.ts` (HTTP, 127.0.0.1 only), `page.ts` (server-rendered HTML), `report.ts`, `attention.ts`,
  `digest.ts`, `metrics.ts`, `search.ts`, `history.ts`, `cost.ts`, `pipelines.ts`, `windows.ts` (VS Code windows).
- **Plumbing:** `db.ts` (SQLite schema, additive migrations), `paths.ts`, `config.ts`, `install.ts`, `ops.ts`
  (doctor, backups, export), `checks.ts` (is Claude Code still what we expect?). **VS Code extension:** `vscode/`. **Protocol evals:** `src/eval/`.

## Rules

1. **A hook must never break or slow a tab.** Hooks swallow their errors, write with `writeSync`, import nothing
   heavy at the top (SQLite is loaded lazily), and have short timeouts.
2. **Nothing leaves the machine** unless the user asked for it (the digest summary, CI reads).
3. **Don't guess.** When Workglance can't know something (which card a commit is for), it asks the agent to say
   so (`commits=`), it doesn't infer it from timestamps. Two timing heuristics were removed for being wrong on
   real data; see PLAN.md.
4. **The user wins.** An agent can't move a card over a change the user made on the board and hasn't seen.
5. **Text from agents and history is data.** Anything given back to an agent is labelled as data and redacted.
6. **Changing `protocol.ts`** (or a tool description) changes how every agent behaves: run `workglance eval`
   (real headless sessions, about $1-3) before and after.
7. **Changing what the transcript parser produces:** bump `PARSER_VERSION` in `transcript.ts`, so files read by
   the old parser are read again.
8. **Schema changes are additive** (`addColumn`, `CREATE TABLE IF NOT EXISTS`): an older server may still be
   running against the same database.
9. **Escape everything** in `page.ts`; browser-side code builds DOM with `textContent`, never `innerHTML`.
10. **Tests:** a test next to every change, real SQLite in `:memory:`, pure functions that take their inputs (a
    platform, a clock, a home folder) instead of mocks. Never touch the real `~/.workglance` or `~/.claude`:
    point `WORKGLANCE_HOME`, `WORKGLANCE_PORT` and `CLAUDE_CONFIG_DIR` at temp folders.

## Traps

- **If this checkout is your real install** (`node src/cli.ts install` points the hooks at `src/hook.ts`), every
  edit under `src/` is live in **every open Claude Code tab** the moment you save it. A syntax error silently
  turns the hooks off; a changed data path makes them write somewhere else. Keep changes small, run the tests
  before saving the next file, and restart the server (`node src/cli.ts restart`) after changing server code.
- **Never edit runtime code while `workglance eval` runs:** its isolated servers load the code from disk.
- **Windows:** `claude` and `code` are `.cmd` files run by `cmd.exe`. Never pass user text as an argument with
  `shell: true` (it becomes cmd syntax); send it through stdin. Paths can come in the 8.3 short form
  (`C:\Users\JANEDO~1`) or the long one: compare through `pathKey`/`isUnder`, never with string prefixes.
- **Linux is case-sensitive, Windows and macOS are not:** `pathKey` handles it; don't lowercase paths yourself.
- **Two copies of the server code can run at once** during an upgrade (an old server and a new worker). The
  scan lease and per-file parser versions exist because of that; keep both.

## Before you say it's done

`npm test`, `npm run typecheck`, and for anything touching install, hooks or packaging, the smoke test. Write
decisions that aren't obvious from the code into PLAN.md.

## Releasing

Publishing is done by `.github/workflows/release.yml`, never from a machine: bump `version` in `package.json`
(and `vscode/package.json` when the extension changed), commit, then `git tag vX.Y.Z && git push origin main vX.Y.Z`.
The workflow checks that the tag matches `package.json`, runs typecheck and tests, publishes the extension when a
`VSCE_PAT` secret exists, and creates a GitHub release with the `.vsix` attached. Workglance is not on npm: people
install it straight from GitHub (`npx github:iceloh/workglance install`; the `prepare` script builds it). Never put
a token in the repo or on disk.
