# Phase 0: results (19/10/2026)

Question: can Workglance track what every Claude tab did, across every repo, at almost no memory cost?
Answer: yes. Every assumption the design depends on was checked against the real Claude Code 2.1.273 CLI.
Two findings change the plan: see "Changes to the plan".

All tests ran in a throwaway repo (`C:\tmp\workglance-eval\sandbox-p0`) with project-level hooks and
`--setting-sources project,local`, so the user's global settings and open tabs were never touched.

## What was verified

| Check | Result |
|---|---|
| Hooks fire on all six events | ✅ SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd |
| Hook payload has what we need | ✅ `session_id`, `transcript_path`, `cwd`, `prompt_id`, `prompt`, `tool_name`, `tool_input`, `tool_response`; Stop also has `last_assistant_message` and `stop_hook_active` |
| Hooks fire in the VS Code extension too | ✅ (indirect) this very session runs in the extension and receives `UserPromptSubmit` context from another tool's global hook |
| A hook can add context to the next turn | ✅ (same evidence) |
| Session identity is stamped, not typed | ✅ a `PreToolUse` hook injects `{ session_id, cwd }` into every `mcp__workglance__*` call via `updatedInput`; the agent never fills it |
| One server for every tab, MCP over HTTP | ✅ registered as `{"type":"http","url":"http://127.0.0.1:4477/mcp"}`; stateless, one process |
| Memory of that server | ✅ **~70 MB RSS idle, ~69 MB after three sessions** (Node + MCP SDK + `node:sqlite`). For comparison: one Claude session ≈ 230 MB; Conus = Docker VM (~1 GB) + app + Postgres + one Node per tab |
| SQLite without native builds | ✅ `node:sqlite` is built into Node 24 (dum-e's `better-sqlite3` failed to install on this machine) |
| Foreign websites cannot call it | ✅ any request with an `Origin` header gets 403 (dum-e accepted writes from any site) |
| Tab name + rename history | ✅ read from the `custom-title` records in `transcript_path`: this tab is `DEVOPS/SRE`, previously `MAG/HARDCODED` and `AI PROVIDER FAILOVER - MAG (fork)`. 108 MB transcript read in 0.6 s, so it must be cached, not read on every hook |
| Git stages | ✅ `git merge-base --is-ancestor <sha> origin/dev` / `origin/main` gives In progress / Testing / Done |

## Does the agent keep the board?

| Run | Request | Nudge | Task registered? |
|---|---|---|---|
| dum-e | small (add a function) | none | ❌ ignored "mandatory" rules |
| 1 | small (function + test) | off | ❌ none (arguably correct: small edit) |
| 2 | small (function + test) | on | ❌ nudge fired; agent answered "small edit, nothing further" (correct by our own rule) |
| 3 | feature (CLI, validation, tests, README) | off | ✅ by itself: `feature`, closed as done |
| 4 | same feature | on | ✅ only after the nudge |

Four runs is not a measurement, but the direction is clear: a rule alone is not reliable, and the
end-of-turn nudge recovers what the rule misses. The nudge mechanics work: the Stop hook holds the
turn once, the agent reads the reason and decides, and `stop_hook_active` prevents a loop.

## Changes to the plan

1. **Match commits by change, not only by SHA.** `d0cee0d87` reached `origin/dev` as `a2599b1f6`
   after a rebase; checking the SHA alone would show it "in progress" forever. Use `git patch-id`,
   with the commit subject as a fallback.
2. **Cache tab names.** Reading a 108 MB transcript takes 0.6 s. Read it incrementally (remember the
   byte offset) or only when the board asks, never on the hook path.

## Still open

- Hook payload inside the VS Code extension was not dumped directly (only inferred). One message in a
  VS Code tab opened on the sandbox folder confirms it.
- The nudge text and the protocol need the Conus-style scenarios (MIT) to be tuned: 4 runs is too few.
- 70 MB idle is acceptable; a hand-written MCP endpoint (no SDK) could cut it further if needed.
