import test from "node:test";
import assert from "node:assert/strict";
import { claudeExtensionHealth, transcriptHealth, unpricedModels } from "./checks.ts";
import { priceFor } from "./cost.ts";

test("transcriptHealth: counts the records Workglance can read", () => {
  const ok = JSON.stringify({ type: "user", sessionId: "s", timestamp: "2026-10-20T10:00:00Z", message: {} });
  const other = JSON.stringify({ type: "summary", summary: "x" });
  assert.deepEqual(transcriptHealth([ok, other, "not json", "", ok]), { total: 4, recognized: 2 });
  // A format change (say, sessionId renamed) shows up as nothing recognized.
  assert.equal(transcriptHealth([JSON.stringify({ type: "user", session_id: "s", timestamp: "t" })]).recognized, 0);
});

test("claudeExtensionHealth: the open-session URI path and command", () => {
  const src = 'handleUri(O){switch(O.path){case"/open":{S.commands.executeCommand("claude-vscode.primaryEditor.open",x)}}}';
  assert.deepEqual(claudeExtensionHealth(src), { uri: true, command: true });
  assert.deepEqual(claudeExtensionHealth('case"/launch":executeCommand("claude-vscode.editor.open")'), { uri: false, command: false });
});

test("unpricedModels: known models (dated or with a context suffix) are priced; others are listed once", () => {
  assert.deepEqual(unpricedModels(["claude-opus-5-5", "claude-haiku-4-5-20251001", "claude-opus-5[1m]", "gpt-x", "gpt-x", "<synthetic>"], (m) => priceFor(m)), ["gpt-x"]);
});

test("validPrices: config overrides are used only when well formed", async () => {
  const { validPrices } = await import("./config.ts");
  assert.deepEqual(validPrices({
    "claude-new-6": { input: 3, output: 15 },
    "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
    "typo-1": { input: "3", output: 15 },
    "typo-2": { input: -1, output: 15 },
    "typo-3": null,
  }), { "claude-new-6": { input: 3, output: 15 }, "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 } });
  assert.deepEqual(validPrices("nonsense"), {});
});
