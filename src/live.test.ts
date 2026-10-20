// Live status: what each tab is doing right now, from the real hook process.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { endOfTurnStatus } from "./state.ts";

test("end of turn: a question is a question; hidden reference lines at the end don't count", () => {
  assert.equal(endOfTurnStatus("Done. Committed abc123."), "done");
  assert.equal(endOfTurnStatus("Should I go ahead with the deploy?"), "question");
  assert.equal(endOfTurnStatus("Which one do you want?\n\n[othertool]: # \"empty\""), "question");
  assert.equal(endOfTurnStatus("Shall I commit this first?**"), "question");
  assert.equal(endOfTurnStatus("Is it the same card? No. Here is why.\nAll fixed."), "done");
});

const HOOK = fileURLToPath(new URL("./hook.ts", import.meta.url));

test("a tab's day: working -> asks -> answered -> needs permission -> granted -> done -> closed", () => {
  const home = mkdtempSync(join(tmpdir(), "wt-live-"));
  const env = { ...process.env, WORKGLANCE_HOME: home, WORKGLANCE_NO_AUTOSTART: "1", WORKGLANCE_PORT: "1" };
  const run = (event: string, payload: object = {}) =>
    spawnSync(process.execPath, ["--no-warnings", HOOK, event], { input: JSON.stringify({ session_id: "tab", cwd: "C:\\r", ...payload }), env, encoding: "utf8" });
  const live = () => JSON.parse(readFileSync(join(home, "state", "tab.json"), "utf8")) as { live: string; liveDetail?: string };

  run("SessionStart");
  assert.equal(live().live, "done");
  run("UserPromptSubmit", { prompt: "fix it" });
  assert.equal(live().live, "working");
  run("PreToolUse", { tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Which branch?" }] } });
  assert.deepEqual([live().live, live().liveDetail], ["question", "Which branch?"]);
  run("PostToolUse", { tool_name: "AskUserQuestion", tool_input: {} });
  assert.equal(live().live, "working");
  run("PermissionRequest", { tool_name: "Bash" });
  assert.deepEqual([live().live, live().liveDetail], ["permission", "Bash"]);
  run("PostToolUse", { tool_name: "Bash", tool_input: { command: "npm test" } });
  assert.equal(live().live, "working");
  run("Stop", { last_assistant_message: "All green. Want me to push it?" });
  assert.deepEqual([live().live, live().liveDetail], ["question", "All green. Want me to push it?"]);
  run("SessionEnd", { reason: "exit" });
  assert.equal(live().live, "closed");
});
