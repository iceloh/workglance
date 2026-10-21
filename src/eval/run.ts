// `workglance eval [--only name] [--model sonnet]`: runs the protocol scenarios against an isolated
// workglance (own database, own server port, throwaway repos) with real headless Claude sessions.
// Costs real model usage (shown per scenario). Never part of `npm test`; runs only when asked.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WORKGLANCE_HOME } from "../db.ts";
import { appFile, CLAUDE_PROJECTS, EVAL_RUNS } from "../paths.ts";
import { withWorkglanceHooks } from "../install.ts";
import { SCENARIOS, type Board, type Check, type Scenario } from "./scenarios.ts";

const CLI = appFile("cli");
const TOOLS = ["mcp__workglance__create_task", "mcp__workglance__update_task", "mcp__workglance__take_task", "mcp__workglance__list_tasks",
  "Read", "Edit", "Write", "Glob", "Grep", "Bash(python:*)", "Bash(py:*)", "Bash(pytest:*)", "Bash(python -m pytest:*)", "Bash(git add:*)", "Bash(git commit:*)", "Bash(git status:*)", "Bash(git diff:*)"].join(",");

export type ScenarioResult = { name: string; pass: boolean; failures: string[]; warnings: string[]; costUsd: number; turns: number; ms: number; tasks: Board["tasks"]; error?: string };

function sh(cwd: string, cmd: string, args: string[]) {
  return spawnSync(cmd, args, { cwd, encoding: "utf8", windowsHide: true });
}

async function waitFor(url: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(url)).ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function claudeTurn(repo: string, prompt: string, env: NodeJS.ProcessEnv, settings: string, mcp: string, model: string, resume: string | null): Promise<{ sessionId: string; cost: number }> {
  return new Promise((resolve, reject) => {
    // acceptEdits: a throwaway repo, and a write held for approval in -p mode just ends the run.
    const args = ["-p", "--model", model, "--permission-mode", "acceptEdits", "--setting-sources", "project,local", "--settings", settings, "--mcp-config", mcp, "--strict-mcp-config",
      "--allowedTools", TOOLS, "--max-turns", "30", "--output-format", "json", ...(resume ? ["--resume", resume] : [])];
    const p = spawn("claude", args, { cwd: repo, env, windowsHide: true });
    let out = "", err = "";
    const timer = setTimeout(() => { p.kill(); reject(new Error("turn timed out (10 min)")); }, 10 * 60_000);
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("close", () => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out.trim().split(/\r?\n/).at(-1) ?? "");
        resolve({ sessionId: j.session_id, cost: Number(j.total_cost_usd ?? 0) });
      } catch { reject(new Error(`no JSON from claude: ${(err || out).slice(0, 300)}`)); }
    });
    p.stdin.end(prompt);
  });
}

function readBoard(home: string, repo: string, initSha: string): Board {
  const file = join(home, "workglance.db");
  // No database: the isolated server never got to write (it died, or nothing happened yet). An empty board,
  // not a crash of the whole run.
  const db = existsSync(file) ? new DatabaseSync(file, { readOnly: true }) : null;
  try {
    const tasks = (db?.prepare("SELECT id, title, type, status, result FROM tasks ORDER BY id").all() ?? []) as Board["tasks"];
    let nudges = 0;
    try { for (const f of readdirSync(join(home, "state"))) nudges += Number(JSON.parse(readFileSync(join(home, "state", f), "utf8")).nudges ?? 0); } catch {}
    const changed = new Set([
      ...sh(repo, "git", ["diff", "--name-only", initSha]).stdout.split(/\r?\n/),
      ...sh(repo, "git", ["ls-files", "--others", "--exclude-standard"]).stdout.split(/\r?\n/),
    ].filter((f) => f && !f.startsWith(".pytest_cache") && !f.includes("__pycache__")));
    return { tasks: tasks.map((t) => ({ ...t })), nudges, edits: changed.size };
  } finally { db?.close(); }
}

function judge(checks: Check[] | undefined, b: Board, failures: string[], warnings: string[], label: string) {
  for (const c of checks ?? []) {
    const r = c(b);
    if (r?.fail) failures.push(`${label}${r.fail}`);
    if (r?.warn) warnings.push(`${label}${r.warn}`);
  }
}

/**
 * A scenario's repo, home and transcripts are throwaway: never left behind. Claude keeps each session's log
 * under ~/.claude/projects/<the repo path, encoded>, so that folder goes too.
 */
export function throwawayDirs(root: string, repo: string, projects = CLAUDE_PROJECTS): string[] {
  return [root, join(projects, repo.replace(/[^a-zA-Z0-9]/g, "-"))];
}

export async function runScenario(s: Scenario, port: number, model: string, keep = false): Promise<ScenarioResult> {
  const t0 = Date.now();
  // The long real path: Windows' short form (C:\Users\JANEDO~1\...) made Claude Code hold every write for
  // manual approval, and the agent stopped mid-task (two "failures" of the first baseline were this).
  // Inside workglance's own folder, never the system temp: the board ignores it, and it is removed after the run.
  mkdirSync(EVAL_RUNS, { recursive: true });
  const root = realpathSync.native(mkdtempSync(join(EVAL_RUNS, `${s.name}-`)));
  const repo = join(root, "repo"), home = join(root, "home"), projects = join(root, "projects");
  for (const d of [repo, home, projects]) mkdirSync(d, { recursive: true });
  for (const [f, content] of Object.entries(s.files)) writeFileSync(join(repo, f), content);
  sh(repo, "git", ["init", "-q"]);
  sh(repo, "git", ["add", "-A"]);
  sh(repo, "git", ["-c", "user.email=eval@workglance.local", "-c", "user.name=eval", "commit", "-qm", "chore: init"]);
  const initSha = sh(repo, "git", ["rev-parse", "HEAD"]).stdout.trim();
  writeFileSync(join(root, "settings.json"), JSON.stringify(withWorkglanceHooks({})));
  writeFileSync(join(root, "mcp.json"), JSON.stringify({ mcpServers: { workglance: { type: "http", url: `http://127.0.0.1:${port}/mcp` } } }));
  // Isolated workglance: its own home and port; it never reads the real transcripts.
  const env = { ...process.env, WORKGLANCE_HOME: home, WORKGLANCE_PORT: String(port), WORKGLANCE_EVAL: "1", WORKGLANCE_NO_AUTOSTART: "1", WORKGLANCE_CLAUDE_PROJECTS: projects };
  const server = spawn(process.execPath, ["--no-warnings", CLI, "serve"], { env, stdio: "ignore", windowsHide: true });
  const failures: string[] = [], warnings: string[] = [];
  let cost = 0, turns = 0, sessionId: string | null = null, error: string | undefined;
  try {
    if (!(await waitFor(`http://127.0.0.1:${port}/api/status`, 15_000))) throw new Error("isolated server did not start");
    for (const [i, prompt] of s.turns.entries()) {
      const r = await claudeTurn(repo, prompt, env, join(root, "settings.json"), join(root, "mcp.json"), model, sessionId);
      sessionId = r.sessionId; cost += r.cost; turns++;
      judge(s.after?.[i], readBoard(home, repo, initSha), failures, warnings, `after turn ${i + 1}: `);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    failures.push(`run error: ${error}`);
  } finally {
    server.kill();
  }
  let board: Board = { tasks: [], nudges: 0, edits: 0 };
  try { board = readBoard(home, repo, initSha); } catch (e) { failures.push(`could not read the board: ${(e as Error).message}`); }
  if (!error) judge(s.expect, board, failures, warnings, "");
  // --keep leaves them, to read what the agent did when a scenario fails; the user deletes them afterwards.
  const dirs = throwawayDirs(root, repo);
  if (keep) console.log(`${s.name}: kept (delete them when done) ${dirs.join(" and ")}`);
  else for (const dir of dirs) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch {}
  }
  return { name: s.name, pass: failures.length === 0, failures, warnings, costUsd: cost, turns, ms: Date.now() - t0, tasks: board.tasks, error };
}

/**
 * Default 3 at a time: ~3 min for the suite instead of ~8, at ~700 MB peak (each headless session ≈ 230 MB,
 * plus its isolated server). Sequential (--parallel 1) when memory is tight.
 */
export const DEFAULT_PARALLEL = 3;

export async function runEval(opts: { only?: string; model?: string; parallel?: number; keep?: boolean }): Promise<{ file: string; results: ScenarioResult[] }> {
  const model = opts.model ?? "sonnet";
  const only = opts.only?.split(",").map((s) => s.trim()).filter(Boolean);
  const list = SCENARIOS.filter((s) => !only?.length || only.includes(s.name));
  const parallel = Math.max(1, Math.min(opts.parallel ?? DEFAULT_PARALLEL, list.length || 1));
  const results: ScenarioResult[] = new Array(list.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < list.length; i = next++) {
      const r = await runScenario(list[i]!, 4610 + i, model, opts.keep); // own port per scenario: no clash in parallel
      results[i] = r;
      console.log(`${r.name} … ${r.pass ? "PASS" : "FAIL"}  $${r.costUsd.toFixed(2)}  ${Math.round(r.ms / 1000)}s${r.failures.length ? "\n    " + r.failures.join("\n    ") : ""}${r.warnings.length ? "\n    (warn) " + r.warnings.join("\n    (warn) ") : ""}`);
    }
  };
  const t0 = Date.now();
  await Promise.all(Array.from({ length: parallel }, worker));
  console.log(`(${parallel} at a time, ${Math.round((Date.now() - t0) / 1000)}s wall clock)`);
  const dir = join(WORKGLANCE_HOME, "evals");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), model, results }, null, 2));
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed · $${results.reduce((a, r) => a + r.costUsd, 0).toFixed(2)} · saved ${file}`);
  return { file, results };
}
