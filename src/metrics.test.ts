import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.ts";
import { createTask, updateTask } from "./tasks.ts";
import { metrics, nudgeOutcomes } from "./metrics.ts";

const T = Date.parse("2026-10-19T12:00:00Z");
const at = (min: number) => new Date(T + min * 60_000).toISOString();

test("nudgeOutcomes: linked if a workglance call followed within 15 min; declined after; pending while the window is open", () => {
  const r = nudgeOutcomes(
    [{ sid: "a", at: at(0) }, { sid: "b", at: at(0) }, { sid: "c", at: at(50) }],
    [{ sid: "a", at: at(3) }, { sid: "b", at: at(40) }],
    T + 55 * 60_000,
  );
  assert.deepEqual(r, { total: 3, linked: 1, declined: 1, pending: 1 });
});

test("metrics: linked commits, done without result, thin investigations, quick empty cards", () => {
  const db = openDb(":memory:");
  const tab = { session_id: "tab", cwd: "C:\\r" };
  const w = { repo: null, worktree: null, branch: null };
  const since = new Date(Date.now() - 3600_000).toISOString();
  const a = createTask(db, tab, w, { title: "Real feature", type: "feature" });
  db.prepare("INSERT INTO commits(sha, repo, at, subject, session_id, task_id) VALUES ('c1','r',?, 's','tab',?)").run(new Date().toISOString(), a.id);
  db.prepare("INSERT INTO commits(sha, repo, at, subject, session_id) VALUES ('c2','r',?, 's','tab')").run(new Date().toISOString());
  updateTask(db, tab, "agent", { id: a.id, status: "done", note: "ok", result: "Added X in y.ts, verified by tests; nothing left." });
  const b = createTask(db, tab, w, { title: "Audit", type: "investigation" });
  updateTask(db, tab, "agent", { id: b.id, status: "done", note: "ok", result: "done" });
  const c = createTask(db, tab, w, { title: "Question about X", type: "chore" });
  updateTask(db, tab, "agent", { id: c.id, status: "done", note: "answered" });
  const m = metrics(db, new Map(), since);
  assert.deepEqual(m.commits, { total: 2, linked: 1 });
  assert.deepEqual(m.tasks.doneWithoutResult.map((t) => t.title), ["Question about X"]);
  assert.deepEqual(m.tasks.thinInvestigations.map((t) => t.title), ["Audit"]);
  assert.deepEqual(m.tasks.quickEmpty.map((t) => t.title).sort(), ["Audit", "Question about X"]);
});
