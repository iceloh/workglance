import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.ts";
import { createTask, updateTask } from "./tasks.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dayBounds, digest, digestBetween, digestText, periodLength, summarize, summaryShape, todayLocal } from "./digest.ts";

test("summarize: no claude on the PATH rejects, it doesn't crash on the unread prompt", async () => {
  const empty = mkdtempSync(join(tmpdir(), "wt-nopath-"));
  const path = process.env.PATH;
  process.env.PATH = empty;
  try {
    // A prompt larger than a pipe buffer: the write is still pending when the shell exits.
    await assert.rejects(summarize("x".repeat(1_000_000), "", 20_000));
  } finally {
    process.env.PATH = path;
  }
});

test("the summary prompt: the chosen language, and the period with both ends and its length", () => {
  assert.match(summaryShape("Portuguese"), /in Portuguese\./);
  assert.match(summaryShape(""), /in the language most task titles use/);
  assert.equal(periodLength("2026-10-20T11:00:00Z", "2026-10-21T11:00:00Z"), "about 24 hours");
  assert.equal(periodLength("2026-10-21T11:00:00Z", "2026-10-21T18:10:00Z"), "about 7 hours");
  assert.equal(periodLength("2026-10-18T11:00:00Z", "2026-10-21T11:00:00Z"), "about 3 days");
  const db = openDb(":memory:");
  const text = digestText(digestBetween(db, "2026-10-20T11:00:00Z", "2026-10-21T11:00:00Z", null));
  assert.match(text.split("\n")[0]!, /^Period: .+ to .+ \(about 24 hours\)$/);
});

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
  assert.match(text, /== Repo other/, "cards without a repo are grouped as 'other'");
});

test("proseOnly: keeps the summary, drops sections other rules append", async () => {
  const { proseOnly } = await import("./digest.ts");
  const out = "Shipped W-1 and W-2.\nW-3 waits for review.\n\n**Corrections**\n- x -> y\n\n[othertool]: # \"empty\"";
  assert.equal(proseOnly(out), "Shipped W-1 and W-2.\nW-3 waits for review.");
  assert.equal(proseOnly("Just prose."), "Just prose.");
});

test("byRepo: one section per repo, most active first; a card appears once", async () => {
  const { byRepo } = await import("./digest.ts");
  const card = (id: number, repo: string) => ({ id, title: `t${id}`, repo });
  const groups = byRepo({
    date: null, from: "", to: "", tabs: [], total: { usd: 0, responses: 0, outputTokens: 0, unpriced: 0 }, testingNow: [],
    closed: [{ ...card(1, "shop"), type: "bug", result: null }],
    toTesting: [card(2, "shop"), card(1, "shop")],            // W-1 also closed: shown once, as done
    started: [card(3, "site")],
    created: [{ ...card(4, "site"), status: "planned" }, { ...card(3, "site"), status: "in_progress" }],
    commits: [{ repo: "site", n: 2 }, { repo: "infra", n: 1 }],
  });
  assert.deepEqual(groups.map((g) => g.repo), ["shop", "site", "infra"]);
  assert.deepEqual(groups[0]!.toTesting.map((t) => t.id), [2]);
  assert.deepEqual(groups[1]!.created.map((t) => t.id), [4]);
  assert.equal(groups[2]!.commits, 1);
});

test("summaryHtml: the summary's parts, with repo names and 'Needs you' in bold", async () => {
  const { summaryHtml } = await import("./page.ts");
  const html = summaryHtml("A busy day.\n\nshop: Fixed checkout <b>.\n\nNeeds you: W-3 waits.");
  assert.equal(html, "<p>A busy day.</p><p><b>shop:</b> Fixed checkout &lt;b&gt;.</p><p><b>Needs you:</b> W-3 waits.</p>");
});
