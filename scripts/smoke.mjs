// End-to-end check of the published package, as a new user gets it: install the tarball, run
// `workglance install`, fire a hook, see the server start on its own, then uninstall. Everything lives in
// a temp folder (its own Claude config, data folder and port), so it never touches the real setup.
// Usage: node scripts/smoke.mjs workglance-0.1.0.tgz
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const tgz = resolve(process.argv[2] ?? "");
assert.ok(existsSync(tgz), "usage: node scripts/smoke.mjs <workglance-x.y.z.tgz>");
const win = process.platform === "win32";
const root = mkdtempSync(join(tmpdir(), "wt-smoke-"));
const prefix = join(root, "prefix"), claudeDir = join(root, "claude"), home = join(root, "home");
mkdirSync(claudeDir, { recursive: true });
const other = { hooks: [{ type: "command", command: "echo other-tool" }] };
writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ theme: "dark", hooks: { Stop: [other] } }, null, 2));
const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, WORKGLANCE_HOME: home, WORKGLANCE_PORT: "4599", WORKGLANCE_CLAUDE_PROJECTS: join(root, "projects") };
const step = (name) => console.log(`\n== ${name}`);
const settings = () => JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
// What the last steps printed: on failure it goes into a GitHub annotation (public; job logs need a login).
const trail = [];
const keep = (label, text) => { if (text) trail.push(`${label}: ${String(text).replace(/\s+/g, " ").slice(0, 400)}`); };

try {
  step("npm install -g --prefix (the package alone, no dependencies)");
  execFileSync(win ? "npm.cmd" : "npm", ["install", "-g", "--prefix", prefix, tgz], { stdio: "inherit", shell: win });
  const bin = win ? join(prefix, "workglance.cmd") : join(prefix, "bin", "workglance");
  const wt = (...args) => spawnSync(bin, args, { env, encoding: "utf8", shell: win });

  step("workglance install");
  const inst = wt("install");
  console.log(inst.stdout, inst.stderr);
  keep("install", inst.stdout + inst.stderr);
  const app = join(home, "app");
  for (const f of ["cli.js", "hook.js", "refresh-worker.js"]) assert.ok(existsSync(join(app, f)), `app/${f} copied`);
  const s = settings();
  assert.equal(s.theme, "dark", "other settings kept");
  assert.ok(JSON.stringify(s.hooks.Stop).includes("other-tool"), "other tools' hooks kept");
  for (const e of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]) {
    assert.ok(JSON.stringify(s.hooks[e] ?? []).includes("app/hook.js") || JSON.stringify(s.hooks[e] ?? []).includes("app\\\\hook.js"), `${e} hook points at the app copy`);
  }

  step("a SessionStart hook: protocol out, server started by itself");
  const payload = JSON.stringify({ session_id: "00000000-0000-0000-0000-000000000001", cwd: process.cwd(), hook_event_name: "SessionStart" }); // a real project folder: temp folders are ignored on purpose
  const hook = spawnSync(process.execPath, ["--no-warnings", join(app, "hook.js"), "SessionStart"], { env, input: payload, encoding: "utf8" });
  keep("hook", (hook.stdout || "").slice(0, 200) + " " + (hook.stderr || "") + " exit " + hook.status);
  assert.match(hook.stdout, /Workglance \(task tracking/, "the hook printed the protocol");
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try { up = (await fetch("http://127.0.0.1:4599/api/status")).ok; } catch {}
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(up, "server answered on its own port");
  const board = await (await fetch("http://127.0.0.1:4599/")).text();
  assert.match(board, /Workglance/, "board renders");

  step("workglance doctor");
  const doc = wt("doctor");
  console.log(doc.stdout);
  keep("doctor", doc.stdout + doc.stderr);
  assert.match(doc.stdout, /✓ hooks/, "doctor sees the hooks");
  assert.match(doc.stdout, /✓ server/, "doctor sees the server");

  step("workglance stop, uninstall");
  wt("stop");
  const un = wt("uninstall");
  console.log(un.stdout);
  const after = settings();
  assert.ok(!JSON.stringify(after).includes("hook.js"), "no workglance hook left");
  assert.ok(JSON.stringify(after.hooks.Stop).includes("other-tool"), "other tools' hooks still there");
  console.log("\nSMOKE OK");
} catch (e) {
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=smoke failed (${process.platform})::${String(e?.message ?? e).replace(/\s+/g, " ")} || ${trail.join(" || ").slice(0, 1500)}`);
  throw e;
} finally {
  try { await fetch("http://127.0.0.1:4599/api/shutdown", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); } catch {}
  await new Promise((r) => setTimeout(r, 500));
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
