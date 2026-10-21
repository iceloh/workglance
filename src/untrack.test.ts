import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.ts";
import { knownFolders, purgeFolder } from "./untrack.ts";
import { createTask } from "./tasks.ts";
import { normalizeDir } from "./transcript.ts";

test("knownFolders: one row per checkout (subfolders fold in), folders outside repos as themselves, ignored ones left out", () => {
  const db = openDb(":memory:");
  const [shop, shopSrc, dev, junk] = ["C:\\dev\\shop", "C:\\dev\\shop\\src", "C:\\dev", "C:\\tmp\\junk"].map(normalizeDir);
  const loc = db.prepare("INSERT INTO locations(session_id, cwd, branch, first_at, last_at) VALUES (?, ?, '', 'a', ?)");
  loc.run("t1", shop, "2026-10-20T10:00:00Z");
  loc.run("t2", shopSrc, "2026-10-21T10:00:00Z");
  loc.run("t3", dev, "2026-10-19T10:00:00Z");
  loc.run("t4", junk, "2026-10-21T12:00:00Z");
  const dir = db.prepare("INSERT INTO dirs(path, worktree, repo, checked_at) VALUES (?, ?, ?, 'x')");
  dir.run(shop, shop, shop); dir.run(shopSrc, shop, shop); dir.run(dev, null, null);
  db.prepare("INSERT INTO repos(id, name) VALUES (?, 'shop')").run(shop);
  db.prepare("INSERT INTO worktrees(path, repo) VALUES (?, ?)").run(shop, shop);
  const fix = normalizeDir("C:\\dev\\shop\\.claude\\worktrees\\fix-cart");
  loc.run("t5", fix, "2026-10-20T09:00:00Z");
  dir.run(fix, fix, shop);
  db.prepare("INSERT INTO worktrees(path, repo) VALUES (?, ?)").run(fix, shop);
  const f = knownFolders(db, (p) => p === junk);
  assert.deepEqual(f.map((x) => [x.name, x.path, x.repo, x.tabs, x.lastAt]), [
    ["shop", shop, true, 2, "2026-10-21T10:00:00Z"],
    ["shop · fix-cart", fix, true, 1, "2026-10-20T09:00:00Z"],
    ["dev", dev, false, 1, "2026-10-19T10:00:00Z"],
  ]);
});

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
