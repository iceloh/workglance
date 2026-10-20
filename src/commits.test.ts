import test from "node:test";
import assert from "node:assert/strict";
import { attribute, COMMIT_WINDOW_AFTER_SEC } from "./commits.ts";

const T = 1_760_000_000;

test("attribute: each commit goes to the closest git commit that ran before it", () => {
  const actions = [
    { id: "a1", sessionId: "CHECKOUT", atSec: T },
    { id: "a2", sessionId: "DEVOPS", atSec: T + 600 },
  ];
  const commits = [
    { sha: "c1", authorAt: T + 30, subject: "fix: signer" },       // right after a1
    { sha: "c2", authorAt: T + 900, subject: "feat: gallery" },    // after a2, so a2 wins
    { sha: "c3", authorAt: T + 610, subject: "chore: amend" },     // a2 is closer than a1
  ];
  const r = attribute(actions, commits);
  assert.equal(r.get("c1")?.sessionId, "CHECKOUT");
  assert.equal(r.get("c2")?.sessionId, "DEVOPS");
  assert.equal(r.get("c3")?.sessionId, "DEVOPS");
});

test("attribute: a slow pre-commit hook still lands on the tab; a commit typed much later by hand does not", () => {
  const actions = [{ id: "a1", sessionId: "S", atSec: T }];
  const r = attribute(actions, [
    { sha: "slow", authorAt: T + 35 * 60, subject: "x" },
    { sha: "manual", authorAt: T + COMMIT_WINDOW_AFTER_SEC + 60, subject: "y" },
    { sha: "before", authorAt: T - 3600, subject: "z" },
  ]);
  assert.equal(r.get("slow")?.sessionId, "S");
  assert.equal(r.has("manual"), false);
  assert.equal(r.has("before"), false);
});

test("attribute: another tab committing right after does not steal the commit", () => {
  const r = attribute(
    [{ id: "a1", sessionId: "REAL", atSec: T }, { id: "a2", sessionId: "OTHER", atSec: T + 60 }],
    [{ sha: "c", authorAt: T + 45, subject: "x" }],
  );
  assert.equal(r.get("c")?.sessionId, "REAL");
});

test("attribute: a rebased copy keeps the author time, so it lands on the same tab", () => {
  const actions = [{ id: "a1", sessionId: "S", atSec: T }];
  const r = attribute(actions, [{ sha: "orig", authorAt: T + 20, subject: "feat: x" }, { sha: "rebased", authorAt: T + 20, subject: "feat: x" }]);
  assert.equal(r.get("orig")?.sessionId, "S");
  assert.equal(r.get("rebased")?.sessionId, "S");
});
