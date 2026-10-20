// The day in one page: what got done, what moved, what got committed, where the model work went.
// Computed from data (no model call). An optional one-paragraph summary runs `claude -p` on request.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "./db.ts";
import { costBetween, type CostSummary } from "./cost.ts";

/** A card in a digest, with the repo it belongs to (its name; "other" when the card has no repo). */
export type DigestCard = { id: number; title: string; repo: string };

export type Digest = {
  /** "2026-10-20" for a calendar day; null for a scheduled digest (previous slot -> this slot). */
  date: string | null; from: string; to: string;
  closed: (DigestCard & { type: string; result: string | null })[];
  toTesting: DigestCard[];
  started: DigestCard[];
  created: (DigestCard & { status: string })[];
  commits: { repo: string; n: number }[];
  tabs: { id: string; title: string | null; prompts: number; cost: CostSummary }[];
  total: CostSummary;
  /** Cards waiting in testing right now: what needs your eyes. */
  testingNow: DigestCard[];
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

// The repo a card belongs to, by name: the repos table, else the folder's last part, else "other".
const REPO = `COALESCE((SELECT r.name FROM repos r WHERE r.id = t.repo), NULLIF(replace(replace(t.repo, rtrim(t.repo, replace(replace(t.repo, '\\', ''), '/', '')), ''), '/', ''), ''), 'other')`;

export function digestBetween(db: Db, from: string, to: string, date: string | null): Digest {
  const ev = (cond: string) => db.prepare(`SELECT DISTINCT t.id, t.title, ${REPO} AS repo FROM task_events e JOIN tasks t ON t.id = e.task_id
    WHERE e.at >= ? AND e.at < ? AND ${cond} ORDER BY t.id`).all(from, to) as DigestCard[];
  const tabs = db.prepare(`SELECT s.id, s.title, count(p.uuid) AS prompts FROM prompts p JOIN sessions s ON s.id = p.session_id
    WHERE p.at >= ? AND p.at < ? GROUP BY s.id ORDER BY prompts DESC`).all(from, to) as { id: string; title: string | null; prompts: number }[];
  const withCost = tabs.map((t) => ({ ...t, cost: costBetween(db, [t.id], from, to) }));
  const allTabs = (db.prepare("SELECT DISTINCT session_id FROM usage WHERE at >= ? AND at < ?").all(from, to) as { session_id: string }[]).map((r) => r.session_id);
  return {
    date, from, to,
    closed: db.prepare(`SELECT t.id, t.title, t.type, t.result, ${REPO} AS repo FROM tasks t WHERE t.status = 'done' AND t.closed_at >= ? AND t.closed_at < ? ORDER BY t.closed_at`).all(from, to) as any[],
    toTesting: ev("e.to_status = 'testing'"),
    started: ev("e.to_status = 'in_progress' AND e.from_status = 'planned'"),
    created: db.prepare(`SELECT t.id, t.title, t.status, ${REPO} AS repo FROM tasks t WHERE t.created_at >= ? AND t.created_at < ? ORDER BY t.id`).all(from, to) as any[],
    commits: db.prepare(`SELECT COALESCE(r.name, c.repo) AS repo, count(*) AS n FROM commits c LEFT JOIN repos r ON r.id = c.repo
      WHERE c.at >= ? AND c.at < ? GROUP BY 1 ORDER BY n DESC`).all(from, to) as any[],
    tabs: withCost,
    total: costBetween(db, allTabs, from, to),
    testingNow: db.prepare(`SELECT t.id, t.title, ${REPO} AS repo FROM tasks t WHERE t.status = 'testing' ORDER BY t.updated_at`).all() as DigestCard[],
  };
}

export type RepoGroup = {
  repo: string; closed: Digest["closed"]; toTesting: DigestCard[]; started: DigestCard[]; created: Digest["created"]; commits: number;
};

/** Pure: the digest per repo, most active first. A card shows once: done > moved to testing > started > new. */
export function byRepo(d: Digest): RepoGroup[] {
  const groups = new Map<string, RepoGroup>();
  const g = (repo: string) => groups.get(repo) ?? groups.set(repo, { repo, closed: [], toTesting: [], started: [], created: [], commits: 0 }).get(repo)!;
  const seen = new Set<number>();
  for (const t of d.closed) { g(t.repo).closed.push(t); seen.add(t.id); }
  for (const t of d.toTesting) if (!seen.has(t.id)) { g(t.repo).toTesting.push(t); seen.add(t.id); }
  for (const t of d.started) if (!seen.has(t.id)) { g(t.repo).started.push(t); seen.add(t.id); }
  for (const t of d.created) if (!seen.has(t.id)) { g(t.repo).created.push(t); seen.add(t.id); }
  for (const c of d.commits) g(c.repo).commits += c.n;
  const weight = (x: RepoGroup) => x.closed.length * 3 + x.toTesting.length * 2 + x.started.length + x.created.length + x.commits / 5;
  return [...groups.values()].sort((a, b) => weight(b) - weight(a) || a.repo.localeCompare(b.repo));
}

/** Plain text of the digest, by repo: what the summary is written from (and what a share/export would carry). */
export function digestText(d: Digest): string {
  const l: string[] = [d.date ? `Day ${d.date}` : `Since ${new Date(d.from).toLocaleString("en-GB")}`];
  if (d.testingNow.length) l.push("", "Waiting for the user to verify (in testing now):", ...d.testingNow.map((t) => `- [${t.repo}] W-${t.id} ${t.title}`));
  for (const g of byRepo(d)) {
    l.push("", `== Repo ${g.repo}${g.commits ? ` (${g.commits} commits)` : ""}`);
    if (g.closed.length) l.push("Done:", ...g.closed.map((t) => `- W-${t.id} (${t.type}) ${t.title}${t.result ? ` — ${t.result.replace(/\s+/g, " ").slice(0, 300)}` : ""}`));
    if (g.toTesting.length) l.push("Moved to testing:", ...g.toTesting.map((t) => `- W-${t.id} ${t.title}`));
    if (g.started.length) l.push("Started:", ...g.started.map((t) => `- W-${t.id} ${t.title}`));
    if (g.created.length) l.push("New cards:", ...g.created.map((t) => `- W-${t.id} ${t.title} (${t.status})`));
  }
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

/** The summary's shape: one line overall, one short paragraph per repo, then what needs the user. */
export const SUMMARY_SHAPE = `Write a digest of this developer's work in this period, in the language most task titles use. Plain text, no markdown, no bullet symbols. Exactly this shape, with a blank line between parts:
1. One sentence: the period in a nutshell.
2. For each repo with activity, most active first: the repo name, a colon, then one or two sentences on what was done and what moved. Name cards as W-<number>.
3. A last part starting with "Needs you:" (translated to the same language), then one or two sentences: what waits for the user's verification and the most urgent open issue.
Be concrete and short; no filler.

`;

export function summarize(text: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const prompt = SUMMARY_SHAPE + text;
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
