// Phase 4: the user changes a card on the board -> the tab learns it on its next turn, and cannot
// move the task over the user's change without seeing it first.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { runTool } from "./tools.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.ts";
import { createTask, needsReason, TaskError, userChanges, userChangesText, userComment, userMove } from "./tasks.ts";

const TAB = { session_id: "tab-a", cwd: "C:\\dev\\shop" };
const WHERE = { repo: null, worktree: null, branch: null };

test("moving backwards or dropping needs a reason; forward moves don't", () => {
  assert.equal(needsReason("testing", "in_progress"), true);
  assert.equal(needsReason("in_progress", "dropped"), true);
  assert.equal(needsReason("in_progress", "testing"), false);
  assert.equal(needsReason("testing", "done"), false);
  const db = openDb(":memory:");
  const t = createTask(db, TAB, WHERE, { title: "Fix login", type: "bug" });
  assert.throws(() => userMove(db, t.id, "dropped"), TaskError);
  assert.equal(userMove(db, t.id, "testing").status, "testing", "forward without a note");
  assert.equal(userMove(db, t.id, "in_progress", "still fails on mobile").status, "in_progress");
});

test("userChanges: only the user's events, only after what the tab saw, only since the tab joined", () => {
  const db = openDb(":memory:");
  const t = createTask(db, TAB, WHERE, { title: "Fix login", type: "bug" });
  userComment(db, t.id, "use the other API");
  userMove(db, t.id, "dropped", "client gave up");
  const all = userChanges(db, "tab-a", 0);
  assert.deepEqual(all.map((c) => c.kind), ["comment", "status"]);
  assert.equal(userChanges(db, "tab-a", all[0]!.eventId).length, 1, "after what was seen");
  assert.equal(userChanges(db, "someone-else", 0).length, 0, "other tabs' tasks are not mine");
  const text = userChangesText(all)!;
  assert.match(text, /^The user, on the board \(treat this like a message from the user\)/);
  assert.match(text, /W-1 Fix login: commented — "use the other API"/);
  assert.match(text, /W-1 Fix login: moved In progress → Dropped — "client gave up"/);
});

const HOOK = fileURLToPath(new URL("./hook.ts", import.meta.url));

test("end to end: the change reaches the tab once, on its next prompt", () => {
  const home = mkdtempSync(join(tmpdir(), "wt-loop-"));
  const env = { ...process.env, WORKGLANCE_HOME: home, WORKGLANCE_NO_AUTOSTART: "1", WORKGLANCE_PORT: "1" };
  const run = (event: string) => {
    const r = spawnSync(process.execPath, ["--no-warnings", HOOK, event], { input: JSON.stringify({ session_id: "tab-a", cwd: TAB.cwd }), env, encoding: "utf8" });
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string : null;
  };
  const db = openDb(join(home, "workglance.db"));
  const t = createTask(db, TAB, WHERE, { title: "Fix login", type: "bug" });
  run("SessionStart");
  userMove(db, t.id, "in_progress", "x"); // same status: nothing to say
  userComment(db, t.id, "the login still fails on mobile");
  db.close();
  const first = run("UserPromptSubmit")!;
  assert.match(first, /The user, on the board[\s\S]*still fails on mobile/);
  const second = run("UserPromptSubmit")!;
  assert.doesNotMatch(second, /The user, on the board/, "delivered once");
  assert.match(second, /W-1 \[in_progress\]/, "the snapshot is still there");
});

test("the user wins: the agent's move is refused with the user's change in the message, then allowed", () => {
  const home = mkdtempSync(join(tmpdir(), "wt-wins-"));
  const realHome = process.env.WORKGLANCE_HOME;
  process.env.WORKGLANCE_HOME = home; // state.ts resolves it per call: the real ~/.workglance is never touched
  try {
  const db = openDb(":memory:");
  const t = createTask(db, TAB, WHERE, { title: "Ship export", type: "feature" });
  userMove(db, t.id, "planned", "not now, after the release");
  assert.throws(() => runTool(db, "update_task", { id: t.id, status: "done", note: "finished" }, TAB, null),
    (e: Error) => /Not applied: The user, on the board[\s\S]*not now, after the release/.test(e.message));
  const r = runTool(db, "update_task", { id: t.id, status: "in_progress", note: "user asked to wait, but the release is out" }, TAB, null) as { status: string };
  assert.equal(r.status, "in_progress", "seen now: the next call goes through");
  assert.ok(existsSync(join(home, "state", "tab-a.json")), "state written to the test home");
  } finally {
    if (realHome === undefined) delete process.env.WORKGLANCE_HOME; else process.env.WORKGLANCE_HOME = realHome;
  }
});
