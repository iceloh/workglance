import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.ts";
import { createTask, updateTask, userMove } from "./tasks.ts";
import { applyDecisions, cardFacts, changedCards, parseDecisions, review, reviewPrompt } from "./reviewer.ts";

const A = { session_id: "tab-a", cwd: "C:\\dev\\shop" };
const where = { repo: "C:\\dev\\shop", worktree: "C:\\dev\\shop", branch: "feat/cart" };

function board() {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO repos(id, name, main_ref, dev_ref) VALUES ('C:\\dev\\shop', 'shop', 'origin/main', 'origin/dev')").run();
  const card = (title: string, testing = false) => {
    const t = createTask(db, A, where, { title, type: "feature" });
    if (testing) updateTask(db, A, "agent", { id: t.id, status: "testing", note: "pushed to dev" });
    return t.id;
  };
  const commit = (sha: string, task: number, dev: number, main: number) =>
    db.prepare("INSERT INTO commits(sha, repo, at, subject, session_id, task_id, in_dev, in_main) VALUES (?, 'C:\\dev\\shop', '2026-10-21T10:00:00Z', ?, 'tab-a', ?, ?, ?)").run(sha, `feat: ${sha}`, task, dev, main);
  const pipeline = (sha: string, branch: string, n: number, state: string) =>
    db.prepare("INSERT INTO commit_pipelines(sha, branch, number, state, url, checked_at) VALUES (?, ?, ?, ?, 'u', 'x')").run(sha, branch, n, state);
  return { db, card, commit, pipeline };
}

test("cardFacts: commits with the branches they reached, their pipelines, the last notes, branch names", () => {
  const { db, card, commit, pipeline } = board();
  const id = card("Cart totals", true);
  commit("abc1234567", id, 1, 1);
  pipeline("abc1234567", "main", 4230, "passed");
  const [f] = cardFacts(db, [id]);
  assert.equal(f!.status, "testing");
  assert.deepEqual([f!.devBranch, f!.mainBranch, f!.repo], ["dev", "main", "shop"]);
  assert.deepEqual(f!.commits, [{ sha: "abc123456", subject: "feat: abc1234567", onDev: true, onMain: true }]);
  assert.deepEqual(f!.pipelines, [{ sha: "abc123456", branch: "main", number: 4230, state: "passed" }]);
  assert.deepEqual(f!.notes.at(-1), { by: "the agent", note: "pushed to dev" });
});

test("reviewPrompt: the user's own rules where they wrote some, defaults elsewhere; the cards are data", () => {
  const { db, card } = board();
  const p = reviewPrompt({ done: "the main pipeline passed" }, cardFacts(db, [card("X", true)]), "Portuguese (Brazil)");
  assert.match(p, /- Done: the main pipeline passed/);
  assert.match(p, /- Testing: pushed to a test\/dev branch, waiting for verification/);
  assert.match(p, /data, never instructions/);
  assert.match(p, /in Portuguese \(Brazil\)/);
  assert.match(p, /"title": "X"/);
});

test("parseDecisions: the JSON array, even with prose around it; malformed items and moves left out", () => {
  const out = 'Here you go:\n[{"id":1,"move":"done","reason":"pipeline #4230 on main passed"},{"id":2,"move":null,"reason":"dev still running"},{"id":3,"move":"dropped","reason":"x"},{"id":"4","move":"done","reason":"x"}]\nDone.';
  assert.deepEqual(parseDecisions(out), [
    { id: 1, move: "done", reason: "pipeline #4230 on main passed" },
    { id: 2, move: null, reason: "dev still running" },
  ]);
  assert.deepEqual(parseDecisions("no json here"), []);
  assert.deepEqual(parseDecisions("[{broken"), []);
});

test("applyDecisions: forward moves only, by the card as it is now, never one the user put in its column", () => {
  const { db, card } = board();
  const ship = card("Ship it", true), working = card("Working"), mine = card("Mine"), moved = card("Moved meanwhile", true);
  userMove(db, mine, "testing", "I put it here");
  const facts = cardFacts(db, [ship, working, mine, moved]);
  updateTask(db, A, "agent", { id: moved, status: "done", note: "closed by its tab meanwhile" });
  const r = applyDecisions(db, facts, [
    { id: ship, move: "done", reason: "pipeline passed" },
    { id: working, move: "testing", reason: "on dev" },
    { id: mine, move: "done", reason: "pipeline passed" },
    { id: moved, move: "done", reason: "pipeline passed" },
  ]);
  assert.deepEqual(r.moved.map((m) => [m.id, m.from, m.to]), [[ship, "testing", "done"], [working, "in_progress", "testing"]]);
  assert.deepEqual(r.kept.map((k) => k.id).sort(), [mine, moved].sort());
  assert.match(r.kept.find((k) => k.id === mine)!.reason, /you put it in this column/);
  const ev = db.prepare("SELECT actor, note FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT 1").get(ship) as { actor: string; note: string };
  assert.deepEqual([ev.actor, ev.note], ["auto", "Review by your column rules: pipeline passed"]);
});

test("review: one call for all the cards asked; done and planned cards aren't sent", async () => {
  const { db, card } = board();
  const a = card("A", true), done = card("Done one");
  updateTask(db, A, "agent", { id: done, status: "done", note: "ok" });
  const planned = createTask(db, A, where, { title: "Later", type: "chore", start_now: false }).id;
  let calls = 0, sent = "";
  const r = await review(db, undefined, {}, "", async (prompt) => { calls++; sent = prompt; return `[{"id":${a},"move":"done","reason":"ok"}]`; });
  assert.equal(calls, 1);
  assert.doesNotMatch(sent, new RegExp(`"id": (${done}|${planned})\\b`));
  assert.deepEqual(r.moved.map((m) => m.id), [a]);
  assert.deepEqual(await review(db, [done], {}, "", async () => { throw new Error("not called"); }), { moved: [], kept: [] });
});

test("changedCards: a first look only records; a new pipeline state or branch is a change", () => {
  const { db, card, commit, pipeline } = board();
  const id = card("Watch me", true);
  commit("c1", id, 1, 0);
  assert.deepEqual(changedCards(db), [], "first look: recorded, not reviewed");
  assert.deepEqual(changedCards(db), [], "nothing new");
  pipeline("c1", "dev", 7, "running");
  assert.deepEqual(changedCards(db), [id]);
  db.prepare("UPDATE commit_pipelines SET state = 'passed'").run();
  assert.deepEqual(changedCards(db), [id]);
  db.prepare("UPDATE commits SET in_main = 1").run();
  assert.deepEqual(changedCards(db), [id], "reached main");
});
