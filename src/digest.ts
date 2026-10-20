// The day in one page: what got done, what moved, what got committed, where the model work went.
// Computed from data (no model call). An optional one-paragraph summary runs `claude -p` on request.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "./db.ts";
import { costBetween, type CostSummary } from "./cost.ts";

export type Digest = {
  /** "2026-10-20" for a calendar day; null for a scheduled digest (previous slot -> this slot). */
  date: string | null; from: string; to: string;
  closed: { id: number; title: string; type: string; result: string | null }[];
  toTesting: { id: number; title: string }[];
  started: { id: number; title: string }[];
  created: { id: number; title: string; status: string }[];
  commits: { repo: string; n: number }[];
  tabs: { id: string; title: string | null; prompts: number; cost: CostSummary }[];
  total: CostSummary;
  /** Cards waiting in testing right now: what needs your eyes. */
  testingNow: { id: number; title: string }[];
};

/** Local-day bounds as ISO instants (the day the user lives in, not UTC). */
export function dayBounds(date: string): { from: string; to: string } {
  const [y, m, d] = date.split("-").map(Number);
  const start = new Date(y!, m! - 1, d!, 0, 0, 0, 0);
  const end = new Date(y!, m! - 1, d! + 1, 0, 0, 0, 0);
  return { from: start.toISOString(), to: end.toISOString() };
}

export function todayLocal(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function digest(db: Db, date: string): Digest {
  const { from, to } = dayBounds(date);
  return digestBetween(db, from, to, date);
}

export function digestBetween(db: Db, from: string, to: string, date: string | null): Digest {
  const ev = (cond: string) => db.prepare(`SELECT DISTINCT t.id, t.title FROM task_events e JOIN tasks t ON t.id = e.task_id
    WHERE e.at >= ? AND e.at < ? AND ${cond} ORDER BY t.id`).all(from, to) as { id: number; title: string }[];
  const tabs = db.prepare(`SELECT s.id, s.title, count(p.uuid) AS prompts FROM prompts p JOIN sessions s ON s.id = p.session_id
    WHERE p.at >= ? AND p.at < ? GROUP BY s.id ORDER BY prompts DESC`).all(from, to) as { id: string; title: string | null; prompts: number }[];
  const withCost = tabs.map((t) => ({ ...t, cost: costBetween(db, [t.id], from, to) }));
  const allTabs = (db.prepare("SELECT DISTINCT session_id FROM usage WHERE at >= ? AND at < ?").all(from, to) as { session_id: string }[]).map((r) => r.session_id);
  return {
    date, from, to,
    closed: db.prepare(`SELECT id, title, type, result FROM tasks WHERE status = 'done' AND closed_at >= ? AND closed_at < ? ORDER BY closed_at`).all(from, to) as any[],
    toTesting: ev("e.to_status = 'testing'"),
    started: ev("e.to_status = 'in_progress' AND e.from_status = 'planned'"),
    created: db.prepare("SELECT id, title, status FROM tasks WHERE created_at >= ? AND created_at < ? ORDER BY id").all(from, to) as any[],
    commits: db.prepare(`SELECT COALESCE(r.name, c.repo) AS repo, count(*) AS n FROM commits c LEFT JOIN repos r ON r.id = c.repo
      WHERE c.at >= ? AND c.at < ? GROUP BY 1 ORDER BY n DESC`).all(from, to) as any[],
    tabs: withCost,
    total: costBetween(db, allTabs, from, to),
    testingNow: db.prepare("SELECT id, title FROM tasks WHERE status = 'testing' ORDER BY updated_at").all() as { id: number; title: string }[],
  };
}

/** Plain text of the digest: what the optional summary is written from (and what a share/export would carry). */
export function digestText(d: Digest): string {
  const l: string[] = [d.date ? `Day ${d.date}` : `Since ${new Date(d.from).toLocaleString("en-GB")}`];
  if (d.closed.length) l.push("Done:", ...d.closed.map((t) => `- W-${t.id} (${t.type}) ${t.title}${t.result ? ` — ${t.result.replace(/\s+/g, " ").slice(0, 300)}` : ""}`));
  if (d.toTesting.length) l.push("Moved to testing:", ...d.toTesting.map((t) => `- W-${t.id} ${t.title}`));
  if (d.started.length) l.push("Started:", ...d.started.map((t) => `- W-${t.id} ${t.title}`));
  if (d.commits.length) l.push(`Commits: ${d.commits.map((c) => `${c.repo} ${c.n}`).join(", ")}`);
  if (d.testingNow.length) l.push("Waiting for the user to verify (in testing):", ...d.testingNow.map((t) => `- W-${t.id} ${t.title}`));
  if (d.tabs.length) l.push("Tabs:", ...d.tabs.map((t) => `- ${t.title ?? t.id.slice(0, 8)}: ${t.prompts} prompts, ~$${t.cost.usd.toFixed(2)}`));
  return l.join("\n");
}

/**
 * One paragraph from `claude -p` (the user's own subscription). Runs with workglance's hooks disabled and
 * in a temp folder, so the summary run never shows up as a tab or a task.
 */
const ONLY_SUMMARY = "Reply with the summary paragraph only. No headings, lists, notes, corrections or anything after it.";

/** Pure: the summary's prose, up to the first heading, bold label or link-reference line someone's rules added. */
export function proseOnly(out: string): string {
  const lines = out.trim().split(/\r?\n/);
  const end = lines.findIndex((l) => /^\s*(#|\*\*|\[[^\]]+\]:\s)/.test(l));
  return (end === -1 ? lines : lines.slice(0, end)).join("\n").trim();
}

export function summarize(text: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const prompt = `Summarize this developer's work in this period in 4-6 sentences: what shipped, what is waiting for verification, and what deserves attention next. Use the same language the task titles mostly use. Plain text, no headings.\n\n${text}`;
    const cwd = mkdtempSync(join(tmpdir(), "wt-digest-"));
    // The text goes in through stdin, never on the command line: on Windows `claude` is a .cmd run by
    // cmd.exe, which would read a prompt's & or | as its own syntax.
    // --setting-sources without "user": none of the user's hooks (ours or other tools') run on this call;
    // another tool's hook once appended its own lines to the summary.
    // CLAUDE.md files can't be switched off on a subscription (--bare needs an API key), so say what we
    // want and keep only the prose: a personal "add a corrections section" rule once landed in the digest.
    const p = spawn(`claude -p --max-turns 1 --setting-sources project,local --append-system-prompt "${ONLY_SUMMARY}"`, { cwd, env: { ...process.env, WORKGLANCE_DISABLED: "1" }, shell: true, windowsHide: true });
    p.stdin.end(prompt);
    let out = "", err = "";
    const timer = setTimeout(() => { p.kill(); reject(new Error("summary timed out")); }, timeoutMs);
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("close", (code) => { clearTimeout(timer); const text = proseOnly(out); code === 0 && text ? resolve(text) : reject(new Error(err.trim().slice(0, 300) || `exit ${code}`)); });
  });
}
