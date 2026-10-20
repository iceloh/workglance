import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.ts";
import { createTask, updateTask } from "./tasks.ts";
import { refreshSearchIndex, search, toFtsQuery } from "./search.ts";

test("toFtsQuery: words are quoted prefixes; FTS syntax in the input can't break the query", () => {
  assert.equal(toFtsQuery("signer signature"), '"signer"* "signature"*');
  assert.equal(toFtsQuery('foo" OR (bar* ^x'), '"foo"* "OR"* "bar"* "x"*');
  assert.equal(toFtsQuery("   "), null);
});

test("search: prompts, tasks, notes and commits; accents don't matter; index rebuilds only when data changed", () => {
  const db = openDb(":memory:");
  const tab = { session_id: "tab", cwd: "C:\\r" };
  db.prepare("INSERT INTO prompts(uuid, session_id, at, text) VALUES ('p1','tab','2026-10-19T10:00:00Z','o Felipe aparece como signatário no PDF')").run();
  const t = createTask(db, tab, { repo: null, worktree: null, branch: null }, { title: "Fix signer bug in e-signature", type: "bug" });
  updateTask(db, tab, "agent", { id: t.id, status: "done", note: "author entry filtered", result: "c5dee72db: author no longer counted" });
  db.prepare("INSERT INTO commits(sha, repo, at, subject, session_id, task_id) VALUES ('c5dee72db','r','2026-10-19T11:00:00Z','fix(assinatura): autor nao conta como signatario','tab',?)").run(t.id);

  const kinds = (q: string) => search(db, q).map((h) => h.kind).sort();
  assert.deepEqual(kinds("signatario"), ["commit", "prompt"], "accent-insensitive: signatário = signatario");
  assert.deepEqual(kinds("signature"), ["task"]);
  assert.deepEqual(kinds("author"), ["note", "task"].sort());
  assert.match(search(db, "felipe")[0]!.snippet, /\[\[Felipe\]\]/);
  assert.equal(refreshSearchIndex(db), false, "nothing changed: no rebuild");
  db.prepare("INSERT INTO prompts(uuid, session_id, at, text) VALUES ('p2','tab','2026-10-19T12:00:00Z','deploy to prd')").run();
  assert.equal(refreshSearchIndex(db), true);
});
