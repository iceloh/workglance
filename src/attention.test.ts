import test from "node:test";
import assert from "node:assert/strict";
import { attentionItems } from "./attention.ts";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const ago = (h: number) => new Date(NOW - h * 3600_000).toISOString();

test("dismiss: for good or snoozed; a changed situation comes back", async () => {
  const { openDb } = await import("./db.ts");
  const { attention, dismiss } = await import("./attention.ts");
  const db = openDb(":memory:");
  db.prepare("INSERT INTO worktrees(path, repo, dirty, ahead, exists_now) VALUES ('C:\\dev\\x', 'C:\\dev\\x', 2, 0, 1)").run();
  const cfg = { enabled: true, port: 1, ignore: [], bitbucketNetrc: null, prices: {}, digestTimes: ["08:00"], digestSummary: false, digestLanguage: "" };
  const items = () => attention(db, cfg, new Map(), NOW);
  assert.equal(items().length, 1);
  const key = items()[0]!.key;
  dismiss(db, key, 7, NOW);
  assert.equal(items().length, 0, "snoozed");
  assert.equal(attention(db, cfg, new Map(), NOW + 8 * 86400_000).length, 1, "snooze over");
  dismiss(db, key, null, NOW);
  assert.equal(attention(db, cfg, new Map(), NOW + 30 * 86400_000).length, 0, "dismissed for good");
  db.prepare("UPDATE worktrees SET dirty = 5").run();
  assert.equal(items().length, 1, "3 more uncommitted files: a new situation, it comes back");
});

test("attention: quiet work is surfaced, fresh work is not", () => {
  const items = attentionItems(NOW, {
    tasks: [
      { id: 1, title: "Old feature", status: "in_progress", lastActivityAt: ago(72), testingSince: null, closedAt: null, unmerged: false },
      { id: 2, title: "Fresh feature", status: "in_progress", lastActivityAt: ago(5), testingSince: null, closedAt: null, unmerged: false },
      { id: 3, title: "Stuck in QA", status: "testing", lastActivityAt: ago(1), testingSince: ago(100), closedAt: null, unmerged: false },
      { id: 4, title: "Said done", status: "done", lastActivityAt: ago(30), testingSince: null, closedAt: ago(30), unmerged: true },
      { id: 5, title: "Done and merged", status: "done", lastActivityAt: ago(30), testingSince: null, closedAt: ago(30), unmerged: false },
    ],
    worktrees: [
      { path: "C:\\dev\\x", branch: "feat/x", dirty: 8, ahead: 0, lastTouchedAt: ago(24 * 5) },
      { path: "C:\\dev\\y", branch: "main", dirty: 2, ahead: 0, lastTouchedAt: ago(2) },
      { path: "C:\\dev\\z", branch: "main", dirty: 0, ahead: 2, lastTouchedAt: null },
    ],
    waiting: [
      { id: "aaaaaaaa-1", title: "PROFILE PAGE", live: "question", since: ago(1) },
      { id: "bbbbbbbb-2", title: "BACKEND", live: "question", since: new Date(NOW - 10 * 60_000).toISOString() },
    ],
  });
  const kinds = items.map((i) => i.kind);
  assert.deepEqual(kinds.filter((k) => k === "idle_task").length, 1);
  assert.ok(items.some((i) => i.text.startsWith("W-3 Stuck in QA: in testing for 4 days")));
  assert.ok(items.some((i) => i.text.startsWith("W-4 Said done: declared done 1 day ago")));
  assert.ok(!items.some((i) => i.text.includes("Done and merged")));
  assert.ok(items.some((i) => i.text.includes("C:\\dev\\x (feat/x): 8 uncommitted, untouched for 5 days")));
  assert.ok(items.some((i) => i.text.includes("C:\\dev\\z (main): 2 unpushed, no tab ever worked here")));
  assert.ok(!items.some((i) => i.text.includes("C:\\dev\\y")));
  assert.ok(items.some((i) => i.text === "PROFILE PAGE has been waiting for you for 60 min"));
  assert.ok(!items.some((i) => i.text.includes("BACKEND")), "10 minutes is not long");
  assert.equal(items[0]!.text.includes("C:\\dev\\z"), true, "oldest first; never-touched counts as oldest");
});
