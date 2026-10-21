import test from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL, protocolFor } from "./protocol.ts";
import { parseColumnRules } from "./config.ts";

test("protocolFor: no rules is the default protocol; each rule replaces its column's condition, not what it requires", () => {
  assert.equal(protocolFor(), PROTOCOL);
  const p = protocolFor({ planned: "Only when I say 'later'", testing: 'Deployed to dev, "green" pipeline', done: "Never: leave it in Testing for me" });
  assert.notEqual(p, PROTOCOL);
  // Each replacement happened: if the default lines change, this fails instead of the rules silently not applying.
  assert.match(p, /- Planned, by the user's own rule for this board: "Only when I say 'later'"\. When it applies: create_task with start_now=false\./);
  assert.match(p, /- Testing, by the user's own rule for this board: "Deployed to dev, 'green' pipeline"\. When it is met: update_task status=testing\./);
  assert.match(p, /- Done, by the user's own rule for this board: "Never: leave it in Testing for me"\. When it is met: update_task status=done with a result — what changed/);
  assert.doesNotMatch(p, /Pushed to a test\/dev branch, waiting for verification/);
  assert.equal(p.split("\n").length, PROTOCOL.split("\n").length, "one line each, no structure added");
});

test("parseColumnRules: known columns only, one line, at most 400 characters", () => {
  assert.deepEqual(parseColumnRules({ testing: "  line one\nline two  ", done: "", in_progress: "x", planned: 3 }), { testing: "line one line two" });
  assert.equal(parseColumnRules({ done: "a".repeat(900) }).done!.length, 400);
  assert.deepEqual(parseColumnRules("nope"), {});
});
