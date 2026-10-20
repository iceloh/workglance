import test from "node:test";
import assert from "node:assert/strict";
import { gitActions, parseRecord, promptText, resolveDir } from "./transcript.ts";

const base = { timestamp: "2026-10-19T12:00:00.000Z", cwd: "C:\\dev\\shop", gitBranch: "dev", sessionId: "s1", entrypoint: "claude-vscode" };

test("prompt: the person's text, not tool results, reminders, summaries or interruptions", () => {
  assert.equal(promptText("fix the signer bug"), "fix the signer bug");
  assert.equal(promptText([{ type: "text", text: "look at this" }, { type: "image" }]), "look at this");
  assert.equal(promptText([{ type: "tool_result", content: "ok" }]), null);
  assert.equal(promptText("<command-name>/compact</command-name>"), null);
  assert.equal(promptText("[Request interrupted by user]"), null);
  assert.equal(parseRecord({ ...base, type: "user", uuid: "u", isCompactSummary: true, message: { content: "summary" } }).filter((f) => f.kind === "prompt").length, 0);
  assert.equal(parseRecord({ ...base, type: "user", uuid: "u", isMeta: true, message: { content: "meta" } }).filter((f) => f.kind === "prompt").length, 0);
  const [loc, prompt] = parseRecord({ ...base, type: "user", uuid: "u1", message: { content: "ship it" } });
  assert.deepEqual(loc, { kind: "loc", at: base.timestamp, cwd: base.cwd, branch: "dev", entrypoint: "claude-vscode" });
  assert.deepEqual(prompt, { kind: "prompt", at: base.timestamp, uuid: "u1", text: "ship it", cwd: base.cwd, branch: "dev" });
});

test("title: renames come through as title facts", () => {
  assert.deepEqual(parseRecord({ type: "custom-title", customTitle: " DEVOPS/SRE ", sessionId: "s1" }), [{ kind: "title", at: "", title: "DEVOPS/SRE" }]);
});

test("git: follows cd and -C, in bash and PowerShell paths", () => {
  assert.deepEqual(gitActions('cd "C:/dev/shop/.claude/worktrees/x" && git add -A && git commit -F msg.txt', "C:\\dev\\shop"),
    [{ action: "commit", dir: "C:\\dev\\shop\\.claude\\worktrees\\x" }]);
  assert.deepEqual(gitActions("git -C /c/dev/workglance commit -m 'feat: x' && git push origin dev", "C:\\tmp"),
    [{ action: "commit", dir: "C:\\dev\\workglance" }, { action: "push", dir: "C:\\tmp" }]);
  assert.deepEqual(gitActions("cd apps/api && git rebase origin/dev", "C:\\dev\\shop"), [{ action: "rebase", dir: "C:\\dev\\shop\\apps\\api" }]);
});

test("git: a commit message that mentions git push is not a push", () => {
  const cmd = "git commit -F - <<'EOF'\nfix: x\n\nthen git push origin dev\nEOF\n";
  assert.deepEqual(gitActions(cmd, "C:\\r"), [{ action: "commit", dir: "C:\\r" }]);
  assert.deepEqual(gitActions('git commit -m "remember to git push later"', "C:\\r"), [{ action: "commit", dir: "C:\\r" }]);
});

test("git: read-only commands are not actions", () => {
  assert.deepEqual(gitActions("git log --oneline && git status && git diff --cached", "C:\\r"), []);
  assert.deepEqual(gitActions("echo git commit", "C:\\r"), []);
  assert.deepEqual(gitActions("CI_WAIT=1 timeout 600 git commit -F m.txt", "C:\\r"), [{ action: "commit", dir: "C:\\r" }]);
});

test("edits: a file written by absolute path counts as working in that file's folder", () => {
  const facts = parseRecord({ ...base, type: "assistant", message: { content: [
    { type: "tool_use", id: "t1", name: "Write", input: { file_path: "C:\\projects\\workglance\\src\\page.ts", content: "x" } },
    { type: "tool_use", id: "t2", name: "Read", input: { file_path: "C:\\elsewhere\\a.ts" } },
  ] } });
  assert.deepEqual(facts.filter((f) => f.kind === "loc").map((f) => f.kind === "loc" && f.cwd), ["C:\\dev\\shop", "C:\\projects\\workglance\\src"]);
  assert.deepEqual(facts.filter((f) => f.kind === "edit"), [{ kind: "edit", at: base.timestamp, id: "t1", dir: "C:\\projects\\workglance\\src" }]);
});

test("workglance calls and their connection failures are facts; validation errors are not failures to replay", () => {
  const [, call] = parseRecord({ ...base, type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_9", name: "mcp__workglance__create_task", input: { title: "Audit", type: "investigation" } }] } });
  assert.deepEqual(call, { kind: "wtcall", at: base.timestamp, id: "toolu_9", tool: "create_task", input: { title: "Audit", type: "investigation" }, cwd: base.cwd });
  const result = (text: string, is_error = true) => parseRecord({ ...base, type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_9", is_error, content: text }] } }).filter((f) => f.kind === "wtfail");
  assert.deepEqual(result('MCP server "workglance" is not connected'), [{ kind: "wtfail", id: "toolu_9" }]);
  assert.deepEqual(result("a note is required when the status changes"), [], "a refused call is the agent's to fix, not ours to replay");
  assert.deepEqual(result("ECONNREFUSED", false), []);
});

test("paths: msys, forward slashes, relative and .. all normalize to one form", () => {
  assert.equal(resolveDir("C:\\x", "/c/dev/shop"), "C:\\dev\\shop");
  assert.equal(resolveDir("C:\\x", "c:/dev/shop/"), "C:\\dev\\shop");
  assert.equal(resolveDir("C:\\dev\\shop\\apps", ".."), "C:\\dev\\shop");
});
