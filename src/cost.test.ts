import test from "node:test";
import assert from "node:assert/strict";
import { costOf, priceFor } from "./cost.ts";
import { parseRecord } from "./transcript.ts";

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
