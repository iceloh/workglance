import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.ts";
import { createTask, updateTask } from "./tasks.ts";
import { isNoise, liveTabs, onlyUntracked, projectDirName, taskDetail, verification } from "./report.ts";
import { pathKey } from "./transcript.ts";
import { homedir } from "node:os";
import { join } from "node:path";

const untrackedNotes = () => {
  const db = openDb(":memory:");
  const notes = "C:\\dev\\notes", shop = "C:\\dev\\shop";
  const cfg = { enabled: true, port: 1, ignore: [pathKey(notes)], bitbucketNetrc: null, prices: {}, digestTimes: ["08:00"], digestSummary: false, digestLanguage: "", columnRules: {}, autoDoneOnMain: false };
  const session = db.prepare("INSERT INTO sessions(id, transcript, titles) VALUES (?, ?, '[]')");
  const loc = db.prepare("INSERT INTO locations(session_id, cwd, branch, first_at, last_at) VALUES (?, ?, '', 'a', 'b')");
  return { db, cfg, notes, shop, session, loc };
};

test("liveTabs: hidden when the tab was opened in an untracked folder (its hooks don't run: status frozen)", () => {
  const { db, cfg, notes, shop, session, loc } = untrackedNotes();
  session.run("both", null); loc.run("both", shop);                   // opened in shop; worked in notes too
  session.run("hum", null); loc.run("hum", "C:\\tmp\\foda");          // opened in notes, also touched a tracked folder
  session.run("legacy", `C:\\Users\\me\\.claude\\projects\\${projectDirName(notes)}\\legacy.jsonl`); // no cwd in state
  session.run("near", `C:\\Users\\me\\.claude\\projects\\${projectDirName(notes)}-2\\near.jsonl`);  // notes-2: not notes
  session.run("fresh", null);                                         // not scanned yet, folder unknown
  const st = (cwd?: string) => ({ active: true, live: "working", liveAt: "2026-10-21T10:00:00Z", cwd });
  const live = liveTabs(db, cfg, new Map([["both", st(shop)], ["hum", st(notes)], ["legacy", st()], ["near", st()], ["fresh", st()]]));
  assert.deepEqual(live.map((t) => t.id).sort(), ["both", "fresh", "near"]);
});

test("onlyUntracked: a tracked place keeps a tab in the history; Claude Code's own folder doesn't count", () => {
  const { db, cfg, notes, session, loc } = untrackedNotes();
  session.run("a", null); loc.run("a", join(homedir(), ".claude", "projects", "x", "memory"));
  session.run("b", null); loc.run("b", "C:\\tmp\\foda");
  assert.equal(onlyUntracked(db, cfg, "a", notes), true);
  assert.equal(onlyUntracked(db, cfg, "b", notes), false);
});

const z = { done: 0, testing: 0, in_progress: 0, local: 0 };

test("verification: what the agent declared against what git shows", () => {
  assert.equal(verification("done", { ...z, done: 2 }), null);
  assert.match(verification("done", { ...z, done: 1, testing: 1 })!, /only in dev/);
  assert.match(verification("done", { ...z, in_progress: 1 })!, /not merged/);
  assert.match(verification("testing", { ...z, in_progress: 2 })!, /nothing reached dev/);
  assert.match(verification("in_progress", { ...z, done: 3 })!, /already in main/);
  assert.equal(verification("done", { ...z, local: 4 }), null, "local-only repos can't be verified: no warning");
  assert.equal(verification("in_progress", z), null);
});

test("ciSummary: per branch, the latest pipeline; a failure that a later pipeline fixed is history", async () => {
  const { ciSummary } = await import("./report.ts");
  const r = ciSummary([
    { branch: "dev", number: 10, state: "passed", url: "a" },
    { branch: "dev", number: 9, state: "failed", url: "b" },
    { branch: "main", number: 3, state: "running", url: "c" },
    { branch: "main", number: 2, state: "passed", url: "d" },
  ]);
  assert.deepEqual(r.map((x) => [x.branch, x.number, x.state]), [["dev", 10, "passed"], ["main", 3, "running"]]);
});

test("noise: unnamed one-prompt sessions are hidden unless they carry a task", () => {
  assert.equal(isNoise({ title: null, promptCount: 1, tasks: [] }), true);
  assert.equal(isNoise({ title: null, promptCount: 1, tasks: [{}] }), false);
  assert.equal(isNoise({ title: "CHECKOUT", promptCount: 0, tasks: [] }), false);
  assert.equal(isNoise({ title: null, promptCount: 2, tasks: [] }), false);
});

test("unseen: a user change no tab of the task has been told about", async () => {
  const { userComment } = await import("./tasks.ts");
  const { taskCards } = await import("./report.ts");
  const db = openDb(":memory:");
  const tab = { session_id: "tab", cwd: "C:\\r" };
  const t = createTask(db, tab, { repo: null, worktree: null, branch: null }, { title: "X", type: "bug" });
  assert.equal(taskCards(db)[0]!.unseen, false);
  userComment(db, t.id, "check mobile");
  const ev = (db.prepare("SELECT max(id) m FROM task_events").get() as any).m;
  assert.equal(taskCards(db, { seen: new Map() })[0]!.unseen, true);
  assert.equal(taskCards(db, { seen: new Map([["tab", { seenEventId: ev }]]) })[0]!.unseen, false);
});

test("taskDetail: one timeline of events, commits and the prompts asked while the task was open", () => {
  const db = openDb(":memory:");
  const tab = { session_id: "tab", cwd: "C:\\r" };
  db.prepare("INSERT INTO sessions(id, title, titles) VALUES ('tab', 'CHECKOUT', '[]')").run();
  const t = createTask(db, tab, { repo: "C:\\r", worktree: "C:\\r", branch: "dev" }, { title: "Fix signer", type: "bug" });
  // Backdate the task so the prompt and the commit fall between its start and the status change below (now).
  const at = (s: number) => new Date(Date.now() + s * 1000).toISOString();
  db.prepare("UPDATE tasks SET created_at = ?, started_at = ? WHERE id = ?").run(at(-60), at(-60), t.id);
  db.prepare("UPDATE task_events SET at = ? WHERE task_id = ?").run(at(-60), t.id);
  db.prepare("INSERT INTO prompts(uuid, session_id, at, text) VALUES ('p0','tab',?,'before the task')").run(at(-120));
  db.prepare("INSERT INTO prompts(uuid, session_id, at, text) VALUES ('p1','tab',?,'felipe still shows')").run(at(-40));
  db.prepare("INSERT INTO commits(sha, repo, at, subject, session_id, task_id, in_dev, in_main) VALUES ('abc','C:\\r',?,'fix: signer',  'tab', ?, 1, 0)").run(at(-20), t.id);
  updateTask(db, tab, "agent", { id: t.id, status: "testing", note: "pushed to dev" });
  const d = taskDetail(db, t.id)!;
  assert.deepEqual(d.timeline.map((i) => i.kind), ["event", "prompt", "commit", "event"]);
  assert.equal(d.timeline.find((i) => i.kind === "prompt")!.kind === "prompt" && (d.timeline.find((i) => i.kind === "prompt") as any).text, "felipe still shows");
  assert.equal(d.tabs[0]!.title, "CHECKOUT");
  assert.equal(d.warning, null, "testing with a commit in dev is consistent");
  updateTask(db, tab, "agent", { id: t.id, status: "dropped", note: "user gave up" });
  assert.equal(taskDetail(db, t.id)!.status, "dropped", "dropped tasks still open in detail");
  assert.equal(taskDetail(db, 999), null);
});
