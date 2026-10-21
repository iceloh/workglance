// One `claude -p` call on the user's own subscription: the digest summary and the card reviewer.
// Runs in a temp folder with workglance's hooks off, so the call never shows up as a tab or a task.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `system` is appended to Claude Code's system prompt; it must be our own constant text (it goes on the
 * command line). Everything else, including anything from cards or the user, goes in `prompt`, through stdin.
 */
export function askClaude(prompt: string, system: string, timeoutMs = 120_000): Promise<string> {
  if (/["%!^&|<>\r\n]/.test(system)) throw new Error("system text must be plain: it goes on a command line");
  return new Promise((resolve, reject) => {
    const cwd = mkdtempSync(join(tmpdir(), "wt-claude-"));
    // The prompt goes in through stdin, never on the command line: on Windows `claude` is a .cmd run by
    // cmd.exe, which would read a prompt's & or | as its own syntax.
    // --setting-sources without "user": none of the user's hooks (ours or other tools') run on this call;
    // another tool's hook once appended its own lines to the summary.
    const p = spawn(`claude -p --max-turns 1 --setting-sources project,local --append-system-prompt "${system}"`, { cwd, env: { ...process.env, WORKGLANCE_DISABLED: "1" }, shell: true, windowsHide: true });
    // When claude isn't installed the shell exits before reading the prompt: the write fails with EPIPE, and
    // unhandled, that error took the whole server down (its scheduled digest runs at start).
    p.stdin.on("error", () => {});
    p.on("error", (e) => reject(e));
    p.stdin.end(prompt);
    let out = "", err = "";
    const timer = setTimeout(() => { p.kill(); reject(new Error("claude -p timed out")); }, timeoutMs);
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("close", (code) => { clearTimeout(timer); code === 0 && out.trim() ? resolve(out) : reject(new Error(err.trim().slice(0, 300) || `exit ${code}`)); });
  });
}
