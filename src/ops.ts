// Operating workglance: doctor (is everything wired?), stop/restart, daily backups, redacted export.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { openDb, type Db } from "./db.ts";
import { appFile, DB_FILE, WORKGLANCE_HOME } from "./paths.ts";
import { HOOK } from "./install.ts";
import { loadConfig } from "./config.ts";
import { githubToken, netrcAuth } from "./pipelines.ts";
import { redact } from "./redact.ts";
import { claudeExtensionHealth, transcriptHealth, unpricedModels } from "./checks.ts";
import { activePrices, priceFor, PRICES_AS_OF } from "./cost.ts";
import { CLAUDE_PROJECTS } from "./paths.ts";

const CLI = appFile("cli");
const base = () => `http://127.0.0.1:${loadConfig().port}`;

export type Check = { name: string; ok: boolean; detail: string };

export async function doctor(): Promise<Check[]> {
  const out: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => out.push({ name, ok, detail });
  const major = Number(process.versions.node.split(".")[0]);
  add("node", major >= 24, `v${process.versions.node}${major >= 24 ? "" : " (needs 24+ for node:sqlite and TypeScript)"}`);
  const cfg = loadConfig();
  add("enabled", cfg.enabled, cfg.enabled ? "hooks active" : "disabled by config/env (kill switch)");
  try {
    const s = JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json"), "utf8"));
    const events = Object.entries(s.hooks ?? {}).filter(([, l]: any) => JSON.stringify(l).includes(HOOK)).map(([e]) => e);
    const want = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "PermissionRequest", "Notification", "SessionEnd"];
    const missing = want.filter((e) => !events.includes(e));
    add("hooks", !missing.length, missing.length ? `missing: ${missing.join(", ")} (run workglance install)` : `${events.length} events → ${HOOK}`);
  } catch (e) { add("hooks", false, `cannot read Claude settings: ${(e as Error).message}`); }
  const mcp = spawnSync("claude", ["mcp", "get", "workglance"], { encoding: "utf8", windowsHide: true });
  add("mcp", mcp.status === 0 && /127\.0\.0\.1/.test(mcp.stdout), mcp.status === 0 ? (mcp.stdout.match(/URL:\s*(\S+)/)?.[1] ?? "registered") : "not registered (run workglance install)");
  try {
    const r = await fetch(`${base()}/api/status`, { signal: AbortSignal.timeout(3000) });
    const j = await r.json() as any;
    add("server", r.ok, `up on ${base()} · ${j.live?.length ?? 0} tracked tabs · ${j.needsYou ?? 0} need you`);
  } catch { add("server", false, `not answering on ${base()} (a tab starting will start it; or: workglance restart)`); }
  try {
    const db = openDb();
    const q = (db.prepare("PRAGMA quick_check").get() as Record<string, string>)["quick_check"];
    const n = (db.prepare("SELECT (SELECT count(*) FROM tasks) t, (SELECT count(*) FROM sessions) s").get() as any);
    add("database", q === "ok", `${q} · ${n.t} tasks · ${n.s} tabs · ${(statSync(join(WORKGLANCE_HOME, DB_FILE)).size / 1048576).toFixed(1)} MB`);
    db.close();
  } catch (e) { add("database", false, (e as Error).message); }
  const backups = listBackups();
  add("backups", backups.length > 0, backups.length ? `${backups.length} kept, newest ${backups.at(-1)}` : "none yet (the server makes one a day)");
  try { const i = JSON.parse(readFileSync(join(WORKGLANCE_HOME, "install.json"), "utf8")); add("install.json", existsSync(i.cli), `${i.cli}`); }
  catch { add("install.json", false, "missing (run workglance install; the VS Code extension needs it)"); }
  const ext = spawnSync("code --list-extensions", { encoding: "utf8", windowsHide: true, shell: true });
  add("vscode extension", /workglance\.workglance/i.test(ext.stdout ?? ""), /workglance\.workglance/i.test(ext.stdout ?? "") ? "installed" : "not installed (optional)");
  // Things Anthropic doesn't document as stable: say so when they change, instead of going quiet.
  const newest = newestTranscript();
  if (newest) {
    const h = transcriptHealth(tailLines(newest, 256 * 1024));
    add("transcripts", h.recognized > 0, h.recognized > 0 ? `format ok (${h.recognized}/${h.total} recent records readable)` : `format changed? none of ${h.total} recent records readable in ${newest} - the board will miss new work`);
  } else add("transcripts", true, "none yet");
  const claudeExt = newestDir(join(homedir(), ".vscode", "extensions"), /^anthropic\.claude-code-/);
  if (claudeExt) {
    let src = "";
    try { src = readFileSync(join(claudeExt, "extension.js"), "utf8"); } catch {}
    const h = claudeExtensionHealth(src);
    add("claude extension", h.uri && h.command, h.uri && h.command ? `open-a-session command present (${basename(claudeExt)})` : `changed: opening a tab from the board may not work (${basename(claudeExt)})`);
  }
  try {
    const db = openDb();
    const models = (db.prepare("SELECT DISTINCT model FROM usage WHERE at >= ?").all(new Date(Date.now() - 30 * 86400_000).toISOString()) as { model: string }[]).map((r) => r.model);
    db.close();
    const missing = unpricedModels(models, (m) => priceFor(m, activePrices()));
    add("prices", missing.length === 0, missing.length ? `no price for ${missing.join(", ")}: their cost is left out (add them under "prices" in config.json)` : `all models priced (table of ${PRICES_AS_OF}${Object.keys(cfg.prices).length ? ` + ${Object.keys(cfg.prices).length} from config` : ""})`);
  } catch {}
  add("github", true, githubToken() ? "token found (GH_TOKEN/GITHUB_TOKEN or gh; not shown)" : "no token: CI status for public repos only, each branch checked every 15 min (set GH_TOKEN or log in with gh)");
  if (cfg.bitbucketNetrc) add("bitbucket", !!netrcAuth(cfg.bitbucketNetrc), netrcAuth(cfg.bitbucketNetrc) ? "credentials found (not shown)" : `no api.bitbucket.org entry in ${cfg.bitbucketNetrc}`);
  return out;
}

export async function stop(): Promise<boolean> {
  try {
    const r = await fetch(`${base()}/api/shutdown`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}

export async function restart(): Promise<void> {
  await stop();
  for (let i = 0; i < 30; i++) {
    try { await fetch(`${base()}/api/status`, { signal: AbortSignal.timeout(500) }); } catch { break; }
    await new Promise((r) => setTimeout(r, 300));
  }
  mkdirSync(WORKGLANCE_HOME, { recursive: true });
  const log = join(WORKGLANCE_HOME, "server.log");
  const { openSync } = await import("node:fs");
  spawn(process.execPath, ["--no-warnings", CLI, "serve"], { detached: true, stdio: ["ignore", openSync(log, "a"), openSync(log, "a")], windowsHide: true }).unref();
}

const BACKUPS = () => join(WORKGLANCE_HOME, "backups");
export const KEEP_BACKUPS = 7;

export function listBackups(): string[] {
  try { return readdirSync(BACKUPS()).filter((f) => /^workglance-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort(); } catch { return []; }
}

/** One consistent copy a day (VACUUM INTO works while the server keeps writing), the last 7 kept. */
export function backupIfDue(db: Db, today: string): string | null {
  const name = `workglance-${today}.db`;
  if (listBackups().includes(name)) return null;
  mkdirSync(BACKUPS(), { recursive: true });
  const target = join(BACKUPS(), name).replace(/'/g, "''");
  db.exec(`VACUUM INTO '${target}'`);
  for (const old of listBackups().slice(0, -KEEP_BACKUPS)) rmSync(join(BACKUPS(), old), { force: true });
  return name;
}

/** Tasks with their history, secrets redacted: something you can attach or share. */
export function exportTasks(db: Db): unknown {
  const tasks = db.prepare("SELECT * FROM tasks ORDER BY id").all() as any[];
  const events = db.prepare("SELECT task_id, at, actor, kind, from_status, to_status, note FROM task_events ORDER BY id").all() as any[];
  const r = (s: unknown) => (typeof s === "string" ? redact(s) : s);
  return {
    exportedAt: new Date().toISOString(),
    tasks: tasks.map((t) => ({ id: t.id, title: r(t.title), type: t.type, status: t.status, description: r(t.description), result: r(t.result),
      branch: t.branch, createdAt: t.created_at, closedAt: t.closed_at,
      history: events.filter((e) => e.task_id === t.id).map((e) => ({ at: e.at, actor: e.actor, kind: e.kind, from: e.from_status, to: e.to_status, note: r(e.note) })) })),
  };
}

/** The most recently written transcript (one folder per project under ~/.claude/projects). */
function newestTranscript(): string | null {
  let best: { f: string; m: number } | null = null;
  try {
    for (const d of readdirSync(CLAUDE_PROJECTS)) {
      const dir = join(CLAUDE_PROJECTS, d);
      let files: string[] = [];
      try { files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
      for (const f of files) { const m = statSync(join(dir, f)).mtimeMs; if (!best || m > best.m) best = { f: join(dir, f), m }; }
    }
  } catch {}
  return best?.f ?? null;
}

function newestDir(parent: string, re: RegExp): string | null {
  try { return readdirSync(parent).filter((d) => re.test(d)).map((d) => join(parent, d)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null; } catch { return null; }
}

/** The last complete lines of a file, reading only its end. */
function tailLines(file: string, bytes: number): string[] {
  const size = statSync(file).size;
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(Math.min(bytes, size));
    readSync(fd, buf, 0, buf.length, size - buf.length);
    const lines = buf.toString("utf8").split("\n");
    return size > bytes ? lines.slice(1) : lines;
  } finally { closeSync(fd); }
}
