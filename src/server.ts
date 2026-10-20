// The board: one small HTTP server on 127.0.0.1. Every page load reads new transcript lines (~0.3 s);
// git is refreshed in a short-lived worker, at most every 2 minutes and only while someone is looking.
import http from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { openDb, WORKGLANCE_HOME } from "./db.ts";
import { appFile } from "./paths.ts";
import { iconSvg } from "./icon.ts";
import { allStates } from "./state.ts";
import { TaskError, userComment, userMove, type TaskStatus } from "./tasks.ts";
import { scan } from "./scan.ts";
import { replayFailedCalls } from "./replay.ts";
import { loadConfig } from "./config.ts";
import { boardStats, liveTabs, taskCards, taskDetail, tabs, undone } from "./report.ts";
import { openTabUrl, renderDigestPage, renderPage, renderSearchPage, renderTaskPage, setDigestUnread } from "./page.ts";
import { attention } from "./attention.ts";
import { search } from "./search.ts";
import { digest, digestBetween, digestText, summarize, todayLocal } from "./digest.ts";
import { getRun, latestRun, markRunRead, neighbours, parseTimes, runDueDigest, setRunSummary, type DigestRun } from "./daily.ts";
import { redact } from "./redact.ts";
import { backupIfDue } from "./ops.ts";
import { metrics } from "./metrics.ts";
import { renderMetricsPage, renderSettingsPage } from "./page.ts";
import { dismiss } from "./attention.ts";
import { retrack, untrack } from "./untrack.ts";
import { setConfig, untrackedFolders } from "./config.ts";

/** The latest eval run (from `workglance eval`), if any. */
function latestEvals(): { at: string; model: string; results: { name: string; pass: boolean; failures: string[]; warnings: string[]; costUsd: number }[] } | null {
  try {
    const dir = join(WORKGLANCE_HOME, "evals");
    const last = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().at(-1);
    return last ? JSON.parse(readFileSync(join(dir, last), "utf8")) : null;
  } catch { return null; }
}
import { handleMcp } from "./mcp.ts";
import { WindowRegistry } from "./windows.ts";
import { spawn } from "node:child_process";

/** Hands a vscode:// link to the OS (what the browser does, minus its prompt). */
function openUrl(url: string): void {
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(cmd as string, args as string[], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}
import { reviewMessage, taskDiff } from "./diff.ts";

const cfg = loadConfig();
const db = openDb();
const GIT_EVERY_MS = 2 * 60 * 1000;
const windows = new WindowRegistry();
/** Where a tab was started: its window is the one with that folder open. */
const sessionCwd = db.prepare("SELECT cwd FROM locations WHERE session_id = ? ORDER BY first_at LIMIT 1");

let gitAt = 0, gitRunning = false, gitError: string | null = null, version = 0;
const newestGitAction = db.prepare("SELECT max(at) AS at FROM git_actions");

/** New transcript lines, then any workglance call that failed while this server was down. */
function catchUp(): void {
  const s = scan(db);
  const replayed = replayFailedCalls(db);
  for (const r of replayed) console.log(`replay ${r.tool} ${r.id}: ${r.outcome}`);
  if (s.facts || replayed.length) version++;
}

function refreshGit(): void {
  // The demo board (scripts/demo.ts) describes folders that don't exist: checking git would erase it.
  if (gitRunning || process.env.WORKGLANCE_DEMO === "1") return;
  // A tab just committed/pushed: don't make the board wait for the next 2-minute slot.
  const latest = (newestGitAction.get() as { at: string | null }).at;
  const fresh = latest !== null && Date.parse(latest) > gitAt;
  if (!fresh && Date.now() - gitAt < GIT_EVERY_MS) return;
  gitRunning = true;
  gitAt = Date.now();
  const w = new Worker(appFile("refresh-worker"));
  w.once("message", (m: { error: string | null }) => { gitError = m.error; });
  // gitAt stays at the START of the run: an action that happened during it triggers the next one.
  w.once("exit", () => { gitRunning = false; version++; });
}

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

/** The Digest page: a scheduled digest (the latest by default, ?id= for another), or a calendar day (?date=). */
function digestPage(url: URL): string {
  const dateParam = url.searchParams.get("date") ?? "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    const date = dateParam;
    const shift = (days: number) => { const [y, m, d] = date.split("-").map(Number); return todayLocal(new Date(y!, m! - 1, d! + days)); };
    const summary = (db.prepare("SELECT value FROM meta WHERE key = ?").get(`digest_summary:${date}`) as { value: string } | undefined)?.value ?? null;
    return renderDigestPage(digest(db, date), summary, { heading: `Day ${date}`, window: "calendar day, midnight to midnight",
      prev: `/digest?date=${shift(-1)}`, next: date < todayLocal() ? `/digest?date=${shift(1)}` : null, summarize: { date } });
  }
  const run = url.searchParams.get("id") ? getRun(db, url.searchParams.get("id")!) : latestRun(db);
  if (!run) {
    // Before the first scheduled digest: a preview of the last 24 hours, and when the first one comes.
    const now = new Date(), from = new Date(now.getTime() - 86400_000).toISOString();
    const times = loadConfig().digestTimes;
    const next = times.map((t) => { const [h, m] = t.split(":").map(Number); const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h!, m!); if (d <= now) d.setDate(d.getDate() + 1); return d; }).sort((a, b) => +a - +b)[0]!;
    return renderDigestPage(digestBetween(db, from, now.toISOString(), null), null, { heading: "Digest preview", window: `last 24 hours`,
      note: `the first scheduled digest comes ${when(next.toISOString())}`, prev: null, next: null, summarize: { date: todayLocal() } });
  }
  markRunRead(db, run.id);
  setDigestUnread(false);
  const n = neighbours(db, run);
  return renderDigestPage(digestBetween(db, run.from, run.to, null), run.summary, { heading: `Digest · ${when(run.to)}`,
    window: `${when(run.from)} → ${when(run.to)}`, prev: n.prev ? `/digest?id=${encodeURIComponent(n.prev)}` : null,
    next: n.next ? `/digest?id=${encodeURIComponent(n.next)}` : null, summarize: { id: run.id } });
}

/** The written paragraph for a scheduled digest (claude -p, redacted input), stored with it. */
async function writeRunSummary(run: DigestRun): Promise<string> {
  const text = await summarize(redact(digestText(digestBetween(db, run.from, run.to, null))));
  setRunSummary(db, run.id, text);
  version++;
  return text;
}

/** At each configured time: write the digest since the previous one (config is re-read: Settings apply at once). */
function digestTick(): void {
  const cfg = loadConfig();
  const run = runDueDigest(db, cfg.digestTimes);
  if (!run) return;
  console.log(`digest ${run.id}`);
  version++;
  if (cfg.digestSummary) writeRunSummary(run).catch((e) => console.error("digest summary:", e instanceof Error ? e.message : e));
}

/** From the hooks' per-session state files: how many tabs are tracked and how many nudges were sent. */
function hookHealth(): { tracked: number; nudges: number } {
  let tracked = 0, nudges = 0;
  for (const s of allStates().values()) {
    if (s.active) tracked++;
    nudges += Number(s.nudges ?? 0);
  }
  return { tracked, nudges };
}

function readJson(req: http.IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 16_384) { reject(new Error("too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

const RANGES: Record<string, number | null> = { today: 1, "7d": 7, "30d": 30, all: null };

function sinceIso(range: string): string | undefined {
  const days = RANGES[range];
  if (!days) return undefined;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (days - 1));
  return d.toISOString();
}

const server = http.createServer((req, res) => {
  // Only this machine, by name: blocks DNS-rebinding pages and any cross-site caller.
  const host = (req.headers.host ?? "").replace(/:\d+$/, "");
  if (!["127.0.0.1", "localhost"].includes(host) || (req.headers.origin && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(req.headers.origin))) {
    res.writeHead(403).end();
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  setDigestUnread(!!latestRun(db) && !latestRun(db)!.readAt);
  if (url.pathname === "/mcp") {
    handleMcp(db, req, res).catch((e) => {
      console.error("mcp:", e instanceof Error ? e.message : e);
      if (!res.headersSent) res.writeHead(400).end();
    });
    version++;
    return;
  }
  const diffReq = url.pathname.match(/^\/api\/tasks\/(\d+)\/diff$/);
  if (diffReq && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(taskDiff(db, Number(diffReq[1]))));
    return;
  }
  const write = url.pathname.match(/^\/api\/tasks\/(\d+)\/(move|comment|review)$/);
  if (write) {
    // JSON only: a plain HTML form from another site cannot send it without a preflight we never answer.
    if (req.method !== "POST" || !String(req.headers["content-type"] ?? "").startsWith("application/json")) { res.writeHead(405).end(); return; }
    readJson(req).then((body) => {
      const id = Number(write[1]);
      const t = write[2] === "move" ? userMove(db, id, String(body.status ?? "") as TaskStatus, body.note)
        : write[2] === "review" ? userComment(db, id, reviewMessage(Array.isArray(body.comments) ? body.comments.slice(0, 200) : []))
        : userComment(db, id, String(body.note ?? ""));
      version++;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, status: t.status }));
    }).catch((e) => {
      const msg = e instanceof TaskError ? e.message : "bad request";
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: msg }));
    });
    return;
  }
  if (["/api/attention/dismiss", "/api/untrack", "/api/retrack"].includes(url.pathname)) {
    if (req.method !== "POST" || !String(req.headers["content-type"] ?? "").startsWith("application/json")) { res.writeHead(405).end(); return; }
    readJson(req).then((body) => {
      let result: unknown = { ok: true };
      if (url.pathname === "/api/attention/dismiss") dismiss(db, String(body.key ?? ""), body.days ? Number(body.days) : null);
      else {
        const path = String(body.path ?? "").trim();
        if (!/^[a-zA-Z]:[\\/]|^\//.test(path)) throw new TaskError("absolute folder path expected");
        result = url.pathname === "/api/untrack" ? untrack(db, path) : { untracked: retrack(path) };
      }
      version++;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    }).catch((e) => res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: e instanceof Error ? e.message : "bad request" })));
    return;
  }
  if (url.pathname === "/api/shutdown") {
    // `workglance stop/restart`. Same-origin JSON POST only (the checks above), so no web page can do it.
    if (req.method !== "POST" || !String(req.headers["content-type"] ?? "").startsWith("application/json")) { res.writeHead(405).end(); return; }
    res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    console.log("shutdown requested");
    setTimeout(() => { server.close(); db.close(); process.exit(0); }, 200);
    return;
  }
  if (url.pathname === "/api/digest/summary") {
    if (req.method !== "POST" || !String(req.headers["content-type"] ?? "").startsWith("application/json")) { res.writeHead(405).end(); return; }
    readJson(req).then(async (body) => {
      if (body.id !== undefined) {
        const run = getRun(db, String(body.id));
        if (!run) throw new TaskError("no such digest");
        const text = await writeRunSummary(run);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ summary: text }));
        return;
      }
      const date = String(body.date ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new TaskError("bad date");
      const text = await summarize(redact(digestText(digest(db, date))));
      db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run(`digest_summary:${date}`, text);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ summary: text }));
    }).catch((e) => res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: e instanceof Error ? e.message : "failed" })));
    return;
  }
  if (url.pathname === "/api/settings/digest") {
    if (req.method !== "POST" || !String(req.headers["content-type"] ?? "").startsWith("application/json")) { res.writeHead(405).end(); return; }
    readJson(req).then((body) => {
      const times = parseTimes(body.times);
      setConfig({ digestTimes: times, digestSummary: body.summary !== false });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ times, summary: body.summary !== false }));
    }).catch(() => res.writeHead(400).end());
    return;
  }
  if (url.pathname === "/api/windows/wait" || url.pathname === "/api/open") {
    // The VS Code extension's long poll, and "open this tab in the window that has it".
    if (req.method !== "POST" || !String(req.headers["content-type"] ?? "").startsWith("application/json")) { res.writeHead(405).end(); return; }
    readJson(req).then((body) => {
      if (url.pathname === "/api/windows/wait") { windows.wait(body, res); return; }
      const session = String(body.session ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(session)) throw new Error("bad session");
      const cwd = (sessionCwd.get(session) as { cwd: string } | undefined)?.cwd ?? null;
      // force: the user chose "open in the last window". The OS opens the link (no browser prompt).
      const result = body.force ? (openUrl(openTabUrl(session)), { ok: true as const }) : windows.open(session, cwd);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    }).catch(() => { if (!res.headersSent) res.writeHead(400).end(); });
    return;
  }
  if (req.method !== "GET") { res.writeHead(405).end(); return; }

  if (url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico") {
    res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "max-age=300" }).end(iconSvg(url.searchParams.get("needs") === "1"));
    return;
  }
  if (url.pathname === "/settings") {
    const c = loadConfig();
    const html = renderSettingsPage(untrackedFolders(), { times: c.digestTimes, summary: c.digestSummary });
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" }).end(html);
    return;
  }
  if (url.pathname === "/metrics") {
    catchUp();
    const range = url.searchParams.get("range") ?? "7d";
    const html = renderMetricsPage(metrics(db, allStates(), sinceIso(range) ?? "0000"), latestEvals(), range, Object.keys(RANGES));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" }).end(html);
    return;
  }
  if (url.pathname === "/search" || url.pathname === "/digest") {
    catchUp();
    let html: string;
    if (url.pathname === "/search") {
      const q = (url.searchParams.get("q") ?? "").slice(0, 200);
      const titles = new Map((db.prepare("SELECT id, title FROM sessions").all() as { id: string; title: string | null }[]).map((s) => [s.id, s.title]));
      html = renderSearchPage(q, search(db, q), titles);
    } else {
      html = digestPage(url);
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" }).end(html);
    return;
  }

  if (url.pathname === "/api/status") {
    // For the VS Code extension: who needs you, and counts for the status bar. Cheap: no scan, no git.
    const live = liveTabs(db, allStates());
    const count = (s: string) => db.prepare("SELECT count(*) AS n FROM tasks WHERE status = ?").get(s) as { n: number };
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({
      version,
      windows: windows.live().map((w) => w.folders),
      live: live.map((t) => ({ ...t, openUrl: openTabUrl(t.id) })),
      needsYou: live.filter((t) => t.live === "question" || t.live === "permission").length,
      working: live.filter((t) => t.live === "working").length,
      tasks: { in_progress: count("in_progress").n, testing: count("testing").n, planned: count("planned").n },
      attention: attention(db, cfg, allStates()).length,
      digest: (() => { const r = latestRun(db); return r ? { id: r.id, to: r.to, unread: !r.readAt } : null; })(),
    }));
    return;
  }
  if (url.pathname === "/api/version") {
    catchUp();
    refreshGit();
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ version, gitRunning }));
    return;
  }
  const task = url.pathname.match(/^\/task\/(\d+)$/);
  if (url.pathname === "/" || task) {
    catchUp();
    refreshGit();
    let html: string | null;
    if (task) {
      const d = taskDetail(db, Number(task[1]), allStates());
      html = d ? renderTaskPage(d) : null;
    } else {
      const range = url.searchParams.get("range") ?? "7d";
      const showNoise = url.searchParams.get("noise") === "1";
      html = renderPage({
        stats: boardStats(db, sinceIso(range)),
        live: liveTabs(db, allStates()),
        attention: attention(db, cfg, allStates()),
        tasks: taskCards(db, { sinceIso: sinceIso(range), seen: allStates() }),
        tabs: tabs(db, cfg, { sinceIso: sinceIso(range), showNoise }),
        undone: undone(db, cfg),
        range, ranges: Object.keys(RANGES), version,
        git: { at: gitAt, running: gitRunning, error: gitError },
        health: { ...hookHealth(), noiseHidden: !showNoise },
      });
    }
    if (!html) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" }).end(html);
    return;
  }
  res.writeHead(404).end();
});

server.listen(cfg.port, "127.0.0.1", () => {
  console.log(`workglance on http://127.0.0.1:${cfg.port}  (rss ${Math.round(process.memoryUsage().rss / 1048576)} MB)`);
  // Most traffic is MCP calls with nobody looking at the board: catch up on our own, at startup
  // (calls that failed while we were down) and every minute.
  const tick = () => {
    try { catchUp(); } catch (e) { console.error("catch-up:", e instanceof Error ? e.message : e); }
    try { const b = backupIfDue(db, todayLocal()); if (b) console.log(`backup ${b}`); } catch (e) { console.error("backup:", e instanceof Error ? e.message : e); }
    try { digestTick(); } catch (e) { console.error("digest:", e instanceof Error ? e.message : e); }
  };
  tick();
  setInterval(tick, 60_000).unref();
});
