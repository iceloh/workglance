---
description: Repo-wide scan for drift from AGENTS.md rules (not a diff) — a ranked debt list and a first batch to fix.
---

Run `Agent(subagent_type="invariant-scanner")` on the current checkout, with `$ARGUMENTS` as an optional
focus (probe numbers or a folder). Show its report as it came, in the user's language, then ask which items
of the first batch to fix. Fix nothing unless asked. Git is read-only.
