import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.ts";
import { purgeFolder } from "./untrack.ts";
import { createTask } from "./tasks.ts";

test("purgeFolder: everything gathered in the folder (and below) goes; siblings, prefixes-alike and tasks stay", () => {
  const db = openDb(":memory:");
  const add = (cwd: string, id: string) => {
    db.prepare("INSERT INTO locations(session_id, cwd, branch, first_at, last_at) VALUES ('s',?,'', 'a','b')").run(cwd);
    db.prepare("INSERT INTO edits(id, session_id, at, dir) VALUES (?, 's', 'a', ?)").run(id, cwd);
  };
  add("C:\\dev\\billing", "e1");
  add("C:\\dev\\billing\\src\\api", "e2");
  add("C:\\dev\\billing2", "e3");          // a different repo whose name starts the same
  add("C:\\dev\\shop", "e4");
  db.prepare("INSERT INTO worktrees(path, repo, dirty) VALUES ('C:\\dev\\billing', 'C:\\dev\\billing', 2)").run();
  const t = createTask(db, { session_id: "s", cwd: "C:\\dev\\billing" }, { repo: "C:\\dev\\billing", worktree: "C:\\dev\\billing", branch: "main" }, { title: "Old work", type: "chore" });
  const r = purgeFolder(db, "C:/dev/BILLING/");
  assert.deepEqual([r.locations, r.edits, r.worktrees], [2, 2, 1]);
  assert.deepEqual(db.prepare("SELECT id FROM edits ORDER BY id").all().map((x: any) => x.id), ["e3", "e4"]);
  assert.ok(db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(t.id), "tasks are history: kept");
});
