# Workglance: plan

Know what every AI coding tab did, across every repo: what was planned, what is in progress, testing
and done, what kind of work it was, and which tab did it (even after a rename).

For now: one user, one Windows machine, Claude Code (CLI and VS Code extension). Later, maybe: open
source, other agents.

## Principles

1. **The agent provides meaning, the system provides facts.** The agent writes titles, types, plans and
   status. Session id, tab name, repo, worktree, branch, commits and times are stamped by hooks.
2. **Almost free in memory.** One small server for all tabs (~70 MB measured), no Docker, no database
   server, no process per tab. Hooks write and exit.
3. **Capture never breaks a tab.** Hooks never throw or wait on the network; if the server is down,
   events wait in a file.
4. **The user has the last word.** User moves win over agent moves. Moving a card never commits,
   pushes, merges or deploys.
5. **Declared vs verified.** The agent says "done"; git says whether it is in `dev` / `main`.
6. **Local only.** Everything in `~/.workglance/`. Task text from the board is data, never instructions.

## Architecture

```
Claude tabs (CLI + VS Code)
  ├─ hooks ───────► ~/.workglance/events.jsonl    (append and exit)
  └─ MCP over HTTP ► workglance server (one Node process, 127.0.0.1)
                       ├─ SQLite (node:sqlite, ~/.workglance/workglance.db)
                       ├─ ingests events, reads tab names from transcripts (cached)
                       ├─ git: repos, worktrees, commits, stages (patch-id aware)
                       ├─ web board
                       └─ API ◄── VS Code extension (panel + status bar)
```

## Model

- **Session** (tab): id, current name + rename history.
- **Repo / Worktree**: path, main branch, has `dev`, remote or local only.
- **Plan** (optional parent) → **Task**: title, type (feature / bug / improvement / refactor / docs /
  investigation / ops / chore), status (planned / in progress / testing / done), flags (waiting for you,
  declared-but-not-merged), repo, worktree, branch, sessions that touched it.
- **Event**: prompts, moves, comments, commits, pushes, with who did it (user or tab).
- **Commit**: sha, patch-id, subject, task, in dev?, in main?

## Ideas taken from Conus (MIT, credited)

- Main tasks only: questions, brainstorming, small edits and plan steps are never tasks.
- Snapshot of the session's open tasks on every prompt.
- End-of-turn nudge when files changed or a commit happened without a task: deduplicated, capped per
  session, with "if everything is up to date, just finish" as the way out.
- Scenario-based evals of the protocol.

## Phases

- **Phase 0, verify assumptions:** done, see `docs/phase0.md`.
- **Phase 1, capture and store:** done (19/10/2026). See "Phase 1 decisions" below.
- **Phase 2, tasks from the agent:** done (19/10/2026), except Claude's to-do list as progress
  (moved to Phase 3). See "Phase 2 decisions".
- **Phase 3, the board:** done (19/10/2026), except drag and drop (Phase 4, where moves reach the
  agent). See "Phase 3 decisions".
- **Phase 4, two-way:** done (19/10/2026). See "Phase 4 decisions".
- **Phase 5, VS Code extension:** starts the server, board in a panel, status bar.
- **Phase 6, optional AI help:** summaries and classification via `claude -p`.
- **SOTA round (19/10/2026):** live "needs you", VS Code extension (Phase 5), CI on cards, review,
  cost, search, digest, attention, metrics, evals, lighter hooks, doctor/backups/restart, redaction.
  See "SOTA round decisions".

## Phase 1 decisions

- **History comes from the transcripts, read incrementally.** They already hold every prompt, folder,
  branch, rename and git command, for the CLI and the VS Code extension. Reading them by byte offset
  makes the backfill and the live view the same code (2 GB once in ~45 s; then ~0.3 s per refresh).
  Hooks are needed only from Phase 2 (stamping tasks, nudges), so Phase 1 changes no global setting.
  The parser is one module (`src/transcript.ts`) so a format change is fixed in one place.
- **Commits come from git, not from command output.** Many commits run in the background, and the
  transcript then says "running in background" instead of the hash. A tab's `git commit` (folder +
  time) is matched to my commits in that repo: author = `user.email` (never a teammate's commit),
  closest command before the commit's author time, within 1 h (slow pre-commit hooks).
- **Rebases are followed.** `git log --all --reflog` keeps the pre-rebase sha findable; the stage
  check falls back to subject + `git patch-id`. On real data 54 of 220 commits reached `dev`/`main`
  only as a rebased copy.
- **Working in a folder = its cwd OR a file it edited there.** Tabs often edit by absolute path
  without changing folder.
- **Git refresh is incremental and off the main thread.** Commits already in `main` are final and
  never checked again; patch-ids are cached; the slow part runs in a worker thread that exits.
- **Ignored folders** (`~/.workglance/config.json`, `ignore`) hide throwaway experiments; the OS temp
  folder is always ignored.

Measured: server ~70 MB private memory, page in ~0.25 s.

## Phase 2 decisions

- **The protocol is delivered by the SessionStart hook, not by CLAUDE.md.** It comes back after
  `/compact` and resume, and `uninstall` removes it completely.
- **Identity is stamped by PreToolUse (`updatedInput`)**, overwriting anything the agent sends in
  `_workglance`: a tab cannot register work as another tab.
- **Only tabs our SessionStart ran for are touched.** Tabs opened before `install` may pick up the new
  hooks but not the MCP tools; nudging them to call tools they don't have would be noise.
- **Nudge:** at most once per burst of changes (edits or a commit), never while a task is in progress,
  never in a loop (`stop_hook_active`), at most 8 per session, always with "if it was small, just
  finish" as the way out.
- **Commits are linked by the server**, not by the agent: the task the committing tab had in progress
  at that moment (with 1 h of grace after closing, for "done, now commit it").
- **A new git action triggers a git refresh right away**, so a commit shows on its task without
  waiting for the 2-minute slot.
- **The server starts itself**: SessionStart checks the port and spawns it detached if needed.
- **Windows gotcha:** hook output is written with `writeSync`; `process.stdout.write` to a pipe is
  async on Windows and `process.exit()` can drop it.
- **Kill switch:** `"enabled": false` in `~/.workglance/config.json` (or `WORKGLANCE_DISABLED=1`);
  `WORKGLANCE_DEBUG=1` prints hook errors to stderr.

Measured: each hook call ~190 ms (Node startup); the per-edit hook is async and never blocks.

## Phase 3 decisions

- **A task's place comes from its activity, not from the tab's folder.** The first real task (W-1) was
  stamped `shop/dev` while all its work was in `workglance`. Each file edit is now recorded with its
  time; while a task is open, the worktree with the most edits (a commit weighs 5 edits) becomes its place
  (`place_source = 'activity'`). With no evidence the creation guess stays, and the detail page says so.
- **Scratch edits are not work.** The first real nudge (PROFILE PAGE) fired on scratchpad debug scripts
  only. The hook ignores edits under the tab's scratchpad, any `AppData\Local\Temp`, `~/.claude` (memory,
  settings) and ignored folders; task activity counts only edits inside a git worktree.
- **No to-do-list progress:** your transcripts never use a to-do tool (0 calls in 2 GB) nor plan mode.
  Progress shown is real activity instead: edits, commits by stage, last activity.
- **Card detail page** (`/task/:id`): one timeline of the task's events, its commits with stage, and the
  prompts asked to its tabs while it was open; plus result, description and where the edits happened.
- **Declared vs verified** is a tested pure function and also flags "all commits already in main: done?".
- **Noise hidden:** unnamed sessions with at most one prompt and no task (headless runs) are off by
  default, one click to show.
- **Health line** for tuning: tabs tracked and nudges sent, from the hooks' state files.
- **Parser versioning:** when the transcript parser learns new facts, old transcripts are re-read once.
  Never run an old server while the new code migrates: its refresh worker loads the new `db.ts` from disk
  while its own scan still uses the old parser (that race wiped the first re-read; recovered by re-running).

## Recovery of lost calls (19/10/2026)

- A tab's `create_task` failed with "MCP server is not connected" during a server restart and the card
  was lost. **The transcripts are the outbox:** they already hold every workglance call and its result.
  The scanner records each call; a call that failed with a connection error and whose id (stamped by the
  hook as `call_id`) is on no event is replayed once through the same code as a live call. A create the
  tab already retried (same tab, same title, ±15 min) is skipped. The server catches up at startup and
  every minute, without needing the board open. Recovered the lost card on real data.

## Phase 4 decisions

- **Drag a card** to another column; **moving it backwards or dropping it needs a reason** (that reason
  is what the tab acts on). Forward moves need none. Comments from the detail page.
- **Delivery on the next prompt** (or start/resume), once, marked "The user, on the board (treat this like
  a message from the user)". Only changes since the tab joined the task. No way to wake an idle tab:
  running the same session in the background would conflict with the open tab.
- **The user wins:** an agent move/take on a task with a user change it has not seen is refused, and the
  refusal carries the change itself, so the agent learns it at once; the next call goes through.
- **"Not seen by the tab yet"** badge until any tab of the task has been told.
- **Moves never do anything risky:** no commit, push, merge or deploy; they only inform.
- Board writes: JSON POST only, same-origin only (a plain HTML form from another site cannot send it).
- Per-tab state (`state.ts`) resolves `WORKGLANCE_HOME` per call: a test once wrote into the real state
  folder because the folder was fixed at import time.

## SOTA round decisions

- **Live status from hooks** (working / asked you / needs permission / your turn / closed), written to the
  tab's state file: no extra process. "Asked you" = `AskUserQuestion` or a turn that ends with a question;
  hidden Markdown reference lines at the end of a reply are ignored.
- **Jump to the tab**: the Claude extension's own handler, `vscode://anthropic.claude-code/open?session=<id>`
  (from its code; there is no command that takes a session id). Inside the VS Code panel the link is relayed
  to the extension (an iframe can't open vscode:// links).
- **CI**: per commit, the first GREEN pipeline that contains it; if none passed yet, the latest one that
  contains it. Found on real data: the first main pipeline containing a fix (#412) failed for an
  unrelated reason, a later one (#4083) passed and deployed it. Per task, the latest per branch.
- **Commit → task, no tolerance**: a commit belongs to a task already running when it was made. A 60 s
  margin gave commits to the NEXT task (commit, close, start next within seconds).
- **Cost** at API list prices (cached 2026-10-06, overridable), deduplicated by message id: a response is
  split into one transcript record per content block, each repeating the same usage.
- **Parser version per file**, not a global migration flag, and **one scanner at a time** (lease in `meta`).
  Both born from real incidents: an old server's worker running the new migration, and an auto-started
  server colliding with a manual scan ("database is locked").
- **Evals** run only on demand (`workglance eval`), each scenario in a throwaway repo against an isolated
  workglance (own home, port, no real transcripts), real headless sessions, checks after turns and at the
  end, "soft" checks for debatable behavior. Never edit the code while an eval runs: its isolated servers
  load the code from disk.
- **Hooks are as cheap as Node startup allows**: almost all of a hook's time is Node starting; SQLite is
  now loaded only by the events that read the board.
- **Redaction** before anything leaves the machine (digest summary, export).
- **Eval baseline: 8/8** (19/10/2026, Sonnet, ~$1.30 a full run, ~3 min at 3 in parallel). The first runs
  "failed" 3 times on harness issues, not the protocol: Windows short paths (`JANEDO~1`) made Claude Code
  hold writes for approval; the temp folder counted as scratch so the nudge never fired in eval repos; a
  one-file "audit" was too small to be the real work the protocol asks for.
- **Dismiss / snooze** each "needs attention" item; the key encodes the situation, so a changed situation
  comes back. **Untrack** a folder from the screen: written to config.json `ignore` (hooks read it on every
  call), nothing from it is stored any more (scanner and git refresh skip it), and what was stored is purged.
  Tasks stay. Undo in Settings.
- **Cross-repo view for agents** (20/10/2026): `list_tasks all=true` gives the open cards of every repo,
  grouped by repo, each with its folder, so a tab in one repo can answer "which projects are active?" and
  take work in another. `cost_by_repo` answers the AI cost per repo over the last N days. A response counts
  for the folder its tab was in at the prompt it answers (the tab's own repo, even when it edits another
  one: which repo it worked on is not guessed). A tab opened outside any repo (`C:\dev`) shows as that
  folder. Worktrees Claude Code makes in `<repo>/.claude/worktrees` are often deleted before Workglance
  resolves them; a folder inside a repo's checkout counts for the nearest repo above it (on real data this
  moved ~$2,600 of 30 days from "no repo" to the right repo).
- **Digest on request and its language** (21/10/2026): "New digest" on the latest digest covers from its end
  to now and becomes the run the next scheduled one starts from (a slot already covered makes no second
  digest). "Rewrite summary" stays the same period, and says so: it was taken for "bring in what I did since".
  The summary prompt now carries both ends of the period and its length: given only "Since 08:00" the model
  called one day "a week of shipping". `digestLanguage` (Settings) is letters, spaces, () and - only, since
  it goes into the prompt.
- **Tabs in untracked folders** (21/10/2026): the live rail hides a tab opened in an untracked folder. Its
  hooks never run there (no protocol, no cards, no status), so its status is frozen from before the untrack
  ("working, 17 h"). The opening folder is stored by SessionStart; for older tabs it comes from the
  transcript's folder name, counted only when it is exactly an untracked folder's encoding. A tab opened in
  a tracked folder that also touched an untracked one stays. The tab history hides a tab only when no
  tracked place is left; Claude Code's own folder (`~/.claude`, memory reads) doesn't count as one.
