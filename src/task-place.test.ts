import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.ts";
import { createTask, updateTask } from "./tasks.ts";
import { choosePlace, placeTasks } from "./task-place.ts";

test("choosePlace: most weighted evidence wins; a commit outweighs a few stray edits; none = keep the guess", () => {
  assert.equal(choosePlace([]), null);
  assert.equal(choosePlace([{ worktree: "A", edits: 3, commits: 0 }, { worktree: "B", edits: 9, commits: 0 }]), "B");
  assert.equal(choosePlace([{ worktree: "A", edits: 0, commits: 1 }, { worktree: "B", edits: 4, commits: 0 }]), "A");
});

test("placeTasks: the W-1 case — stamped in shop, all edits in workglance, moved to workglance", () => {
  const db = openDb(":memory:");
  const tab = { session_id: "tab", cwd: "C:\\dev\\shop" };
  const t = createTask(db, tab, { repo: "C:\\dev\\shop", worktree: "C:\\dev\\shop", branch: "dev" }, { title: "Build workglance", type: "feature" });
  const at = (s: number) => new Date(Date.parse(t.created_at) + s * 1000).toISOString();
  db.prepare("INSERT INTO dirs(path, worktree, repo, checked_at) VALUES (?,?,?,?)").run("C:\\projects\\workglance\\src", "C:\\projects\\workglance", "C:\\projects\\workglance", at(0));
  db.prepare("INSERT INTO dirs(path, worktree, repo, checked_at) VALUES (?,?,?,?)").run("C:\\dev\\shop", "C:\\dev\\shop", "C:\\dev\\shop", at(0));
  db.prepare("INSERT INTO worktrees(path, repo, branch) VALUES (?,?,?)").run("C:\\projects\\workglance", "C:\\projects\\workglance", "master");
  for (let i = 0; i < 6; i++) db.prepare("INSERT INTO edits(id, session_id, at, dir) VALUES (?,?,?,?)").run(`e${i}`, "tab", at(10 + i), "C:\\projects\\workglance\\src");
  db.prepare("INSERT INTO edits(id, session_id, at, dir) VALUES (?,?,?,?)").run("before", "tab", at(-3600), "C:\\dev\\shop");
  db.prepare("INSERT INTO edits(id, session_id, at, dir) VALUES (?,?,?,?)").run("other-tab", "someone-else", at(20), "C:\\dev\\shop");

  assert.equal(placeTasks(db), 1);
  const moved = db.prepare("SELECT worktree, repo, branch, place_source FROM tasks WHERE id = ?").get(t.id) as any;
  assert.deepEqual({ ...moved }, { worktree: "C:\\projects\\workglance", repo: "C:\\projects\\workglance", branch: "master", place_source: "activity" });
  assert.equal(placeTasks(db), 0, "stable: running again moves nothing");

  // Edits after the task closed don't count for it.
  updateTask(db, tab, "agent", { id: t.id, status: "done", note: "ok" });
  for (let i = 0; i < 20; i++) db.prepare("INSERT INTO edits(id, session_id, at, dir) VALUES (?,?,?,?)").run(`late${i}`, "tab", at(999_999 + i), "C:\\dev\\shop");
  assert.equal(placeTasks(db), 0);
});
