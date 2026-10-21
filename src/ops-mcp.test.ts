import "./test-home.ts"; // ops.ts reads WORKGLANCE_HOME at import
import test from "node:test";
import assert from "node:assert/strict";
import { mcpCheck } from "./ops.ts";

test("mcpCheck: registered when the URL is printed, whatever the exit code; a timeout said as such", () => {
  const out = "workglance:\n  Scope: User config (available in all your projects)\n  Status: √ Connected\n  Type: http\n  URL: http://127.0.0.1:4477/mcp\n";
  assert.deepEqual(mcpCheck(out), { ok: true, detail: "http://127.0.0.1:4477/mcp" });
  assert.equal(mcpCheck("No MCP server found with name: workglance").ok, false);
  assert.equal(mcpCheck("  URL: https://example.com/mcp\n").ok, false, "only our local server counts");
  assert.match(mcpCheck("", "spawnSync C:\Windows\system32\cmd.exe ETIMEDOUT").detail, /didn't answer/);
});
