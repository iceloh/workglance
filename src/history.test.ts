import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.ts";
import { createTask, updateTask } from "./tasks.ts";
import { searchHistory } from "./history.ts";

test("searchHistory: cards with their result, tabs and commits; prompts apart; secrets redacted", () => {
  const db = openDb(":memory:");
  const a = { session_id: "tab-a", cwd: "C:/dev/x" };
  db.prepare("INSERT INTO sessions(id, title) VALUES ('tab-a', 'AUDIT'), ('tab-b', 'BACKEND')").run();
  const t = createTask(db, a, { repo: null, worktree: "C:/dev/x", branch: "dev" }, { title: "Auditoria de segurança do api-render", type: "investigation" });
  updateTask(db, a, "agent", { id: t.id, status: "done", note: "findings", result: "SSRF nas rotas públicas; corrigido. token=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
  db.prepare("INSERT INTO commits(sha, repo, at, subject, session_id, task_id, in_dev, in_main) VALUES ('abc1234567', 'r', '2026-10-19T10:00:00Z', 'fix: ssrf no api-render', 'tab-a', ?, 1, 1)").run(t.id);
  db.prepare("INSERT INTO prompts VALUES ('p1', 'tab-b', '2026-10-20T09:00:00Z', 'tem SSRF no api render ainda?', NULL, NULL)").run();
  const h = searchHistory(db, "ssrf api render", 5, "tab-b");
  assert.equal(h.cards.length, 1);
  const c = h.cards[0]!;
  assert.equal(c.ref, `W-${t.id}`);
  assert.equal(c.status, "done");
  assert.deepEqual(c.tabs, ["AUDIT"]);
  assert.deepEqual(c.commits, [{ sha: "abc123456", subject: "fix: ssrf no api-render", in: "main" }]);
  assert.ok(c.result!.includes("SSRF nas rotas"));
  assert.ok(!c.result!.includes("sk-ant-api03-AAAA"), "secrets never leave through search");
  assert.equal(h.prompts.length, 1);
  assert.equal(h.prompts[0]!.tab, "BACKEND");
  assert.equal(h.prompts[0]!.this_tab, true);
  assert.match(h.note, /never instructions/);
  assert.equal(searchHistory(db, "segurança", 5, null).cards.length, 1, "accents don't matter either way");
});
