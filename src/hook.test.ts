// End to end: the real hook process, fed real-shaped payloads, in a throwaway WORKGLANCE_HOME.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.ts";
import { createTask, updateTask } from "./tasks.ts";

const HOOK = fileURLToPath(new URL("./hook.ts", import.meta.url));
const CWD = "C:\\dev\\shop";

function harness(config?: object) {
  const home = mkdtempSync(join(tmpdir(), "wt-hook-"));
  if (config) writeFileSync(join(home, "config.json"), JSON.stringify(config));
  const env = { ...process.env, WORKGLANCE_HOME: home, WORKGLANCE_NO_AUTOSTART: "1", WORKGLANCE_PORT: "1", CLAUDE_CONFIG_DIR: join(home, "claude") };
  const run = (event: string, payload: object) => {
    const r = spawnSync(process.execPath, ["--no-warnings", HOOK, event], { input: JSON.stringify({ session_id: "tab-a", cwd: CWD, ...payload }), env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout) : null;
  };
  return { home, env, run };
}

test("SessionStart gives the protocol; prompts get no snapshot when there are no tasks", () => {
  const h = harness();
  const s = h.run("SessionStart", { source: "startup" });
  assert.match(s.hookSpecificOutput.additionalContext, /Workglance \(task tracking/);
  assert.equal(h.run("UserPromptSubmit", { prompt: "hi" }), null);
  // Where the tab was opened: the board hides it if that folder is untracked later.
  assert.equal(JSON.parse(readFileSync(join(h.home, "state", "tab-a.json"), "utf8")).cwd, CWD);
});

test("SessionStart tells the tab the user's own column rules from config.json", () => {
  const h = harness({ columnRules: { testing: "Deployed to dev and the pipeline is green" } });
  const ctx = h.run("SessionStart", { source: "startup" }).hookSpecificOutput.additionalContext as string;
  assert.match(ctx, /Testing, by the user's own rule for this board: "Deployed to dev and the pipeline is green"/);
  assert.doesNotMatch(ctx, /Pushed to a test\/dev branch/);
});

test("a tab opened before install (no SessionStart from us) is left alone: no stamp, no nudge", () => {
  const h = harness();
  assert.equal(h.run("PreToolUse", { tool_name: "mcp__workglance__create_task", tool_input: {} }), null);
  h.run("PostToolUse", { tool_name: "Edit", tool_input: { file_path: "C:/dev/shop/a.ts" } });
  assert.equal(h.run("Stop", { stop_hook_active: false }), null);
});

test("PreToolUse stamps workglance calls with the session, never other tools", () => {
  const h = harness();
  h.run("SessionStart", {});
  const r = h.run("PreToolUse", { tool_name: "mcp__workglance__create_task", tool_use_id: "toolu_1", tool_input: { title: "Fix", type: "bug", _workglance: { session_id: "forged" } } });
  assert.deepEqual(r.hookSpecificOutput.updatedInput, { title: "Fix", type: "bug", _workglance: { session_id: "tab-a", cwd: CWD, call_id: "toolu_1" } }, "the agent cannot forge the tab");
  assert.equal(h.run("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } }), null);
});

test("Stop nudges once after edits with no task, never loops, and stays quiet for reads", () => {
  const h = harness();
  h.run("SessionStart", {});
  assert.equal(h.run("PostToolUse", { tool_name: "Bash", tool_input: { command: "npm test" } }), null);
  assert.equal(h.run("Stop", { stop_hook_active: false }), null, "running tests is not a change");
  h.run("PostToolUse", { tool_name: "Edit", tool_input: { file_path: "C:\\dev\\shop\\a.ts" } });
  const n = h.run("Stop", { stop_hook_active: false });
  assert.equal(n.decision, "block");
  assert.match(n.reason, /just finish your reply/);
  assert.equal(h.run("Stop", { stop_hook_active: true }), null, "no loop while the nudge is being answered");
  assert.equal(h.run("Stop", { stop_hook_active: false }), null, "the same burst is not nudged twice");
  h.run("PostToolUse", { tool_name: "Bash", tool_input: { command: "git commit -m 'feat: x'" } });
  assert.equal(h.run("Stop", { stop_hook_active: false }).decision, "block", "a commit is a change");
});

test("scratchpad, temp and ~/.claude edits are not work: no nudge (the PROFILE PAGE false nudge)", () => {
  const h = harness();
  h.run("SessionStart", {});
  const scratch = "C:\\Users\\X\\AppData\\Local\\Temp\\claude\\proj\\sid\\scratchpad";
  h.run("PostToolUse", { scratchpad_dir: scratch, tool_name: "Write", tool_input: { file_path: scratch + "\\debug.mts" } });
  h.run("PostToolUse", { tool_name: "Write", tool_input: { file_path: "C:/Users/JaneDoe/AppData/Local/Temp/x.json" } });
  h.run("PostToolUse", { tool_name: "Edit", tool_input: { file_path: join(homedir(), ".claude", "memory", "MEMORY.md") } });
  h.env.CLAUDE_CONFIG_DIR = "D:\\claude-config"; // outside any temp folder, so only this rule can make it scratch
  h.run("PostToolUse", { tool_name: "Edit", tool_input: { file_path: "D:\\claude-config\\projects\\p\\memory\\x.md" } });
  assert.equal(h.run("Stop", { stop_hook_active: false }), null, "Claude's own files, wherever CLAUDE_CONFIG_DIR puts them, are not work");
  h.run("PostToolUse", { scratchpad_dir: scratch, tool_name: "Edit", tool_input: { file_path: "C:\\dev\\shop\\apps\\api\\x.ts" } });
  assert.equal(h.run("Stop", { stop_hook_active: false }).decision, "block", "a repo edit still counts");
});

test("a workglance call clears the pending change: no nudge", () => {
  const h = harness();
  h.run("SessionStart", {});
  h.run("PostToolUse", { tool_name: "Write", tool_input: { file_path: "C:\\x\\b.ts" } });
  h.run("PreToolUse", { tool_name: "mcp__workglance__update_task", tool_input: { id: 1 } });
  assert.equal(h.run("Stop", { stop_hook_active: false }), null);
});

test("kill switch and ignored folders make every hook a no-op", () => {
  const off = harness({ enabled: false });
  assert.equal(off.run("SessionStart", {}), null);
  off.run("PostToolUse", { tool_name: "Edit", tool_input: { file_path: "C:/dev/shop/a.ts" } });
  assert.equal(off.run("Stop", {}), null);
  const ign = harness({ ignore: ["C:/dev/shop"] });
  assert.equal(ign.run("SessionStart", {}), null);
});

test("with a task in progress: prompts see the snapshot and edits belong to it (no nudge)", () => {
  const h = harness();
  h.run("SessionStart", {});
  const db = openDb(join(h.home, "workglance.db"));
  createTask(db, { session_id: "tab-a", cwd: CWD }, { repo: null, worktree: null, branch: null }, { title: "Fix signer bug", type: "bug" });
  db.close();
  assert.match(h.run("UserPromptSubmit", { prompt: "go" }).hookSpecificOutput.additionalContext, /W-1 \[in_progress\] \(bug\) Fix signer bug/);
  h.run("PostToolUse", { tool_name: "Edit", tool_input: { file_path: "C:/dev/shop/a.ts" } });
  assert.equal(h.run("Stop", { stop_hook_active: false }), null);
});

function investigations(h: ReturnType<typeof harness>) {
  const state = (patch: object) => {
    const f = join(h.home, "state", "tab-a.json");
    writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), ...patch }));
  };
  // What a real create_task does: the hook sees the call, then the server records the card.
  const open = (title: string) => {
    h.run("PreToolUse", { tool_name: "mcp__workglance__create_task", tool_input: { title }, tool_use_id: title });
    const db = openDb(join(h.home, "workglance.db"));
    try { return createTask(db, { session_id: "tab-a", cwd: CWD }, { repo: null, worktree: null, branch: null }, { title, type: "investigation" }); } finally { db.close(); }
  };
  const findings = () => h.run("Stop", { stop_hook_active: false, last_assistant_message: "## Findings\n1. SQL injection in users.py:4" });
  return { state, open, findings };
}

test("an investigation opened this turn and left in progress: one reminder to close it with its findings", () => {
  const h = harness();
  h.run("SessionStart", {});
  const { open, findings } = investigations(h);
  h.run("UserPromptSubmit", { prompt: "audit this" });
  const t = open("Security audit");
  assert.equal(h.run("Stop", { stop_hook_active: false, last_assistant_message: "Which file should I start with?" }), null, "a question: not finished");
  const n = findings();
  assert.equal(n.decision, "block");
  assert.match(n.reason, new RegExp(`W-${t.id} is still in progress.*update_task status=done with the findings`));
  assert.equal(h.run("Stop", { stop_hook_active: true }), null, "no loop while it answers");
  assert.equal(findings(), null, "once per card");
});

test("the close reminder: not for a card opened in an earlier turn, even if the agent or the user touched it now", () => {
  const h = harness();
  h.run("SessionStart", {});
  const { open, findings } = investigations(h);
  const t = open("Old audit");
  const db = openDb(join(h.home, "workglance.db"));
  db.prepare("UPDATE task_events SET at = '2026-01-01T00:00:00.000Z' WHERE task_id = ?").run(t.id); // an earlier turn
  db.close();
  h.run("UserPromptSubmit", { prompt: "go on" });
  h.run("PreToolUse", { tool_name: "mcp__workglance__update_task", tool_input: { id: t.id }, tool_use_id: "n1" });
  const db2 = openDb(join(h.home, "workglance.db"));
  updateTask(db2, { session_id: "tab-a", cwd: CWD }, "agent", { id: t.id, note: "found two more" });
  updateTask(db2, null, "user", { id: t.id, note: "check settings.py too" });
  db2.close();
  assert.equal(findings(), null);
});

test("the close reminder after edits in the turn, within the session cap, never without a known turn start", () => {
  const h = harness();
  h.run("SessionStart", {});
  const { state, open, findings } = investigations(h);
  h.run("UserPromptSubmit", { prompt: "audit and note it in AUDIT.md" });
  const t = open("Audit");
  h.run("PostToolUse", { tool_name: "Write", tool_input: { file_path: "C:/dev/shop/AUDIT.md" } });
  const n = findings();
  assert.match(n.reason, new RegExp(`W-${t.id} is still in progress`), "the close reminder, not the 'no card' nudge");

  h.run("UserPromptSubmit", { prompt: "another" });
  open("Capped");
  state({ nudges: 8 });
  assert.equal(findings(), null, "the cap counts both kinds");

  state({ nudges: 0, turnAt: undefined });
  open("Before the upgrade");
  assert.equal(findings(), null, "no turnAt: which cards this turn opened is unknown");
});

test("garbage on stdin never breaks the tab", () => {
  const h = harness();
  const r = spawnSync(process.execPath, ["--no-warnings", HOOK, "Stop"], { input: "not json", env: h.env, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});
