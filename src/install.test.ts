import test from "node:test";
import assert from "node:assert/strict";
import { withoutWorkglanceHooks, withWorkglanceHooks } from "./install.ts";

const HOOK = "C:/projects/workglance/src/hook.ts";
const othertool = { hooks: [{ type: "command", command: "node", args: ["C:/Users/x/.othertool/bin/hook.js", "stop"], async: true }] };
const pixel = { matcher: "", hooks: [{ type: "command", command: 'node "C:\\Users\\x\\.pixel-agents\\hooks\\claude-hook.js"', timeout: 5 }] };
const settings = { permissions: { allow: ["Bash(ls)"] }, model: "opus", hooks: { Stop: [othertool, pixel], PreToolUse: [pixel] } };

test("install adds ours next to existing hooks and leaves the rest of settings alone", () => {
  const s = withWorkglanceHooks(settings, HOOK) as any;
  assert.deepEqual(s.permissions, settings.permissions);
  assert.equal(s.model, "opus");
  assert.deepEqual(s.hooks.Stop.slice(0, 2), [othertool, pixel], "existing Stop hooks kept, in order");
  assert.equal(s.hooks.Stop.length, 3);
  assert.equal(s.hooks.PreToolUse.at(-1).matcher, "mcp__workglance__.*|AskUserQuestion");
  assert.equal(s.hooks.PostToolUse.at(-1).hooks[0].async, true, "the per-edit hook never blocks the tab");
  for (const e of ["PermissionRequest", "Notification", "SessionEnd"]) assert.equal(s.hooks[e].at(-1).hooks[0].async, true, `${e} never blocks`);
  for (const e of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "PermissionRequest", "Notification", "SessionEnd"]) assert.ok(s.hooks[e].some((x: any) => x.hooks[0].args?.includes(HOOK)), e);
});

test("install twice = install once; uninstall restores exactly what was there", () => {
  const once = withWorkglanceHooks(settings, HOOK);
  assert.deepEqual(withWorkglanceHooks(once, HOOK), once);
  assert.deepEqual(withoutWorkglanceHooks(once, HOOK), settings);
});
