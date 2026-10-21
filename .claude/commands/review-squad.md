---
description: Multi-specialist review of the current change — architect, security, QA, portability, agent behavior, UX/docs/release — then a lead who verifies the blockers and merges everything into one list.
---

You are coordinating a review of a Workglance change. Six specialists review the same diff in parallel; a lead
then verifies their blockers in the code and merges their findings into one ranked list. Read-only: nobody
fixes, commits or pushes anything.

## Step 1 — Scope

If the user gave a scope in `$ARGUMENTS` (a range like `v0.9.0..HEAD`, a commit, files), use it. Otherwise
pick the first non-empty one:
- staged changes: `git diff --cached` → scope `--cached`
- unstaged changes: `git diff` → scope is the working tree vs HEAD
- commits not pushed yet: `git log @{u}..HEAD` → scope `@{u}..HEAD`
- commits since the last release tag: `git describe --tags --abbrev=0` → scope `<tag>..HEAD`
- nothing: say "nothing to review" and stop.

This repo commits straight to `main`, so "not pushed" and "since the last tag" are the usual scopes.

## Step 2 — The diff

Run `git diff <scope> --stat` and `git diff <scope>`. Over ~2000 lines or ~50 files: say so and ask whether to
narrow it before spending six agents on it.

## Step 3 — Six specialists, in parallel

In ONE message, six Agent calls, each with the scope, the file list and the diff, and its lane:

- `architect` — boundaries from AGENTS.md: hooks never break or slow a tab, nothing leaves the machine,
  don't guess, the user wins, additive schema, two servers at once
- `security` — the 127.0.0.1 server, page escaping, shell and process spawning, redaction, text from agents
  as data, paths from the browser, outbound calls
- `qa` — a test next to every change, the test rules (`:memory:`, pure functions, never the real
  `~/.workglance`/`~/.claude`), missing branches and error paths
- `portability` — Windows / macOS / Linux: paths, case, separators, `.cmd` files, Node 24 type stripping
- `agent-behavior` — what agents are told (protocol, tool descriptions, nudges): eval before/after,
  PARSER_VERSION, caps, MCP errors
- `ux-docs-release` — the board's UI, the docs that must follow a user-visible change (both READMEs),
  config keys, versions, release and Marketplace steps

Each returns:
```
### 🔴 Blocker
- file:line — problem — fix
### 🟡 Medium
- ...
### 🟢 Suggestion
- ...
### ✅ Checked, nothing found
- ...
```

If one fails, note it and go on.

## Step 4 — The lead

`Agent(subagent_type="review-lead")` with the six raw lists. It verifies every blocker in the code, merges
duplicates, resolves disagreements, moves what was already there before this change to a footer, and returns
one list tagged by who raised each item.

## Step 5 — To the user

Show the lead's list as it came, in the user's language. End with "X blockers, Y medium, Z suggestions — which
one first?" and offer the raw list of any specialist. Fix nothing unless asked.

## Rules

- Git is read-only for you and every agent: diff, log, show, ls-tree, fetch. Never stash, clean, checkout,
  restore or reset (a reviewer agent once stashed a user's untracked files away).
- Never run `workglance eval` or anything that costs money or opens windows: say it should be run instead.
- The user asks for only some lanes ("just security and qa")? Run those; the lead still merges when 2+ ran.
