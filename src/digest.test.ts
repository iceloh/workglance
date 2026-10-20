import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.ts";
import { createTask, updateTask } from "./tasks.ts";
import { dayBounds, digest, digestText, todayLocal } from "./digest.ts";

test("dayBounds: the local day, as instants", () => {
  const { from, to } = dayBounds("2026-10-19");
  assert.equal(Date.parse(to) - Date.parse(from), 86400_000);
  assert.equal(new Date(from).getHours(), 0, "midnight where the user is");
});

test("digest: done, testing, started, commits and cost for the day, as data and as text", () => {
  const db = openDb(":memory:");
  const tab = { session_id: "tab", cwd: "C:\\r" };
  db.prepare("INSERT INTO sessions(id, title, titles) VALUES ('tab','CHECKOUT','[]')").run();
  const today = todayLocal();
  const a = createTask(db, tab, { repo: null, worktree: null, branch: null }, { title: "Fix signer", type: "bug" });
  updateTask(db, tab, "agent", { id: a.id, status: "done", note: "ok", result: "author filtered" });
  const b = createTask(db, tab, { repo: null, worktree: null, branch: null }, { title: "Rename tab", type: "chore", start_now: false });
  updateTask(db, tab, "agent", { id: b.id, status: "in_progress", note: "go" });
  updateTask(db, tab, "agent", { id: b.id, status: "testing", note: "pushed" });
  const now = new Date().toISOString();
  db.prepare("INSERT INTO prompts(uuid, session_id, at, text) VALUES ('p','tab',?,'fix it')").run(now);
  db.prepare("INSERT INTO usage(msg_id, session_id, at, model, input, output, cache_write_5m, cache_write_1h, cache_read) VALUES ('m','tab',?,'claude-opus-5-5',0,1000000,0,0,0)").run(now);
  db.prepare("INSERT INTO commits(sha, repo, at, subject, session_id) VALUES ('c1','C:\\r',?,'fix: signer','tab')").run(now);
  const d = digest(db, today);
  assert.deepEqual(d.closed.map((t) => t.title), ["Fix signer"]);
  assert.deepEqual(d.toTesting.map((t) => t.title), ["Rename tab"]);
  assert.deepEqual(d.started.map((t) => t.title), ["Rename tab"]);
  assert.equal(d.total.usd, 20);
  assert.deepEqual(d.tabs.map((t) => [t.title, t.prompts, t.cost.usd]), [["CHECKOUT", 1, 20]]);
  const text = digestText(d);
  assert.match(text, /Done:\n- W-1 \(bug\) Fix signer — author filtered/);
  assert.match(text, /CHECKOUT: 1 prompts, ~\$20\.00/);
});

test("proseOnly: keeps the summary, drops sections other rules append", async () => {
  const { proseOnly } = await import("./digest.ts");
  const out = "Shipped W-1 and W-2.\nW-3 waits for review.\n\n**Corrections**\n- x -> y\n\n[othertool]: # \"empty\"";
  assert.equal(proseOnly(out), "Shipped W-1 and W-2.\nW-3 waits for review.");
  assert.equal(proseOnly("Just prose."), "Just prose.");
});
