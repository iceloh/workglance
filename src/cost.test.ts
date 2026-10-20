import test from "node:test";
import assert from "node:assert/strict";
import { costByRepo, costOf, priceFor, repoCosts, repoOfDir } from "./cost.ts";
import { openDb } from "./db.ts";
import { normalizeDir, parseRecord } from "./transcript.ts";

test("repoOfDir: a deleted worktree inside a repo counts for it; a nested repo keeps its own; no repo above: none", () => {
  const [shop, lib, dev] = ["C:\\dev\\shop", "C:\\dev\\shop\\vendor\\lib", "C:\\dev"].map(normalizeDir);
  const m = new Map([[shop, "shop"], [lib, "lib"]]);
  assert.equal(repoOfDir(m, normalizeDir("C:\\dev\\shop\\.claude\\worktrees\\fix-cart\\src")), "shop");
  assert.equal(repoOfDir(m, normalizeDir("C:\\dev\\shop\\vendor\\lib\\src")), "lib");
  assert.equal(repoOfDir(m, dev), undefined);
  // Either separator, on any platform: CI runs these Windows paths on Linux too.
  assert.equal(repoOfDir(new Map([["/home/me/shop", "shop"]]), "/home/me/shop/.claude/worktrees/x"), "shop");
  assert.equal(repoOfDir(new Map([["/home/me/shop", "shop"]]), "/home/me"), undefined);
});

test("costByRepo: each response goes to the repo of the folder its prompt came from", () => {
  const db = openDb(":memory:");
  const [shop, api, notes] = ["C:\\dev\\shop", "C:\\dev\\api", "C:\\notes"].map(normalizeDir);
  db.prepare("INSERT INTO repos(id, name) VALUES (?, 'shop')").run(shop);
  const dir = db.prepare("INSERT INTO dirs(path, worktree, repo, checked_at) VALUES (?, ?, ?, 'x')");
  dir.run(shop, shop, shop); dir.run(api, api, api); dir.run(notes, null, null);
  const prompt = db.prepare("INSERT INTO prompts(uuid, session_id, at, text, cwd) VALUES (?, ?, ?, 'p', ?)");
  prompt.run("p1", "tab1", "2026-10-10T10:00:00Z", "C:\\dev\\shop");
  prompt.run("p2", "tab1", "2026-10-10T12:00:00Z", "C:\\dev\\api");
  prompt.run("p3", "tab2", "2026-10-10T10:00:00Z", "C:\\notes");
  const use = db.prepare("INSERT INTO usage VALUES (?, ?, ?, ?, 0, ?, 0, 0, 0)");
  use.run("m1", "tab1", "2026-10-10T10:05:00Z", "claude-opus-5-5", 1e6); // shop: $20
  use.run("m2", "tab1", "2026-10-10T12:05:00Z", "claude-opus-5-5", 5e5); // api (the tab moved): $10
  use.run("m3", "tab2", "2026-10-10T10:05:00Z", "<synthetic>", 1);      // no repo, no price
  use.run("m4", "tab1", "2026-10-01T10:05:00Z", "claude-opus-5-5", 1e6); // before the period
  assert.deepEqual(costByRepo(db, "2026-10-09T00:00:00Z", "2026-10-11T00:00:00Z"), [
    { repo: "shop", usd: 20, responses: 1, unpriced: 0 },
    { repo: "api", usd: 10, responses: 1, unpriced: 0 },
    { repo: `${notes} (no repo)`, usd: 0, responses: 1, unpriced: 1 },
  ]);
  const r = repoCosts(db, 2, Date.parse("2026-10-11T00:00:00Z"));
  assert.equal(r.total_usd, 30);
  assert.match(r.note, /not the bill/);
});

test("priceFor: context and date suffixes map to the table; unknown models are not guessed", () => {
  assert.deepEqual(priceFor("claude-opus-5[1m]"), priceFor("claude-opus-5"));
  assert.deepEqual(priceFor("claude-haiku-4-5-20251001"), { input: 1, output: 5 });
  assert.equal(priceFor("<synthetic>"), null);
});

test("costOf: input, output, both cache writes and reads, with the model's own read price when listed", () => {
  // Opus 5.5: 4/20, read 0.20 listed. 1M of each kind:
  const u = { model: "claude-opus-5-5", input: 1e6, output: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6, cacheRead: 1e6 };
  assert.equal(costOf(u), 4 + 20 + 5 + 8 + 0.2);
  // Opus 5: read defaults to 0.1x input
  assert.equal(costOf({ ...u, model: "claude-opus-5", input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0 }), 0.5);
  assert.equal(costOf({ ...u, model: "<synthetic>" }), null);
});

test("usage facts: one per response (the transcript repeats it on every block of the same message)", () => {
  const rec = { type: "assistant", timestamp: "2026-10-19T12:00:00Z", sessionId: "s", message: { id: "msg_1", model: "claude-opus-5-5",
    usage: { input_tokens: 2, output_tokens: 806, cache_read_input_tokens: 673322, cache_creation_input_tokens: 1245, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1245 } }, content: [{ type: "text", text: "hi" }] } };
  const f = parseRecord(rec).filter((x) => x.kind === "usage");
  assert.deepEqual(f, [{ kind: "usage", at: rec.timestamp, id: "msg_1", model: "claude-opus-5-5", input: 2, output: 806, cacheWrite5m: 0, cacheWrite1h: 1245, cacheRead: 673322 }]);
  // Without the 5m/1h breakdown, all writes count as 5-minute writes.
  const g = parseRecord({ ...rec, message: { ...rec.message, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 50 } } }).find((x) => x.kind === "usage") as any;
  assert.deepEqual([g.cacheWrite5m, g.cacheWrite1h], [50, 0]);
});
