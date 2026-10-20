// Things that went quiet and need a decision: pushed to you instead of waiting for you to look.
import type { Db } from "./db.ts";
import type { Config } from "./config.ts";
import { isIgnored } from "./config.ts";
import type { TabState } from "./state.ts";

/**
 * `key` identifies the situation, not just the thing: dismissing "W-3 in testing" does not hide W-3 when it
 * later goes stale in another way, and a worktree comes back when its uncommitted/unpushed counts change.
 * `path` is set for worktree items (so the screen can offer "untrack this repo").
 */
export type Attention = { kind: "idle_task" | "long_testing" | "unmerged_done" | "stale_worktree" | "waiting_long"; text: string; href: string; ageMs: number; key: string; path?: string };

export const LIMITS = {
  idleTaskMs: 2 * 86400_000,      // in progress, nothing happened for 2 days
  testingMs: 3 * 86400_000,       // in testing for 3 days
  unmergedMs: 86400_000,          // declared done a day ago, commits still not in main
  staleWorktreeMs: 3 * 86400_000, // uncommitted/unpushed work nobody touched for 3 days
  waitingMs: 30 * 60_000,         // a tab has been waiting for you for 30 minutes
};

const days = (ms: number) => { const n = Math.max(1, Math.round(ms / 86400_000)); return `${n} day${n === 1 ? "" : "s"}`; };

/** Pure decision over prepared facts, so the rules are testable without a database. */
export function attentionItems(now: number, f: {
  tasks: { id: number; title: string; status: string; lastActivityAt: string; testingSince: string | null; closedAt: string | null; unmerged: boolean }[];
  worktrees: { path: string; branch: string | null; dirty: number; ahead: number; lastTouchedAt: string | null }[];
  waiting: { id: string; title: string | null; live: string; since: string }[];
}): Attention[] {
  const out: Attention[] = [];
  for (const t of f.tasks) {
    const idle = now - Date.parse(t.lastActivityAt);
    if (t.status === "in_progress" && idle > LIMITS.idleTaskMs) out.push({ kind: "idle_task", text: `W-${t.id} ${t.title}: in progress, untouched for ${days(idle)}`, href: `/task/${t.id}`, ageMs: idle, key: `idle_task:${t.id}` });
    if (t.status === "testing" && t.testingSince && now - Date.parse(t.testingSince) > LIMITS.testingMs) {
      const a = now - Date.parse(t.testingSince);
      out.push({ kind: "long_testing", text: `W-${t.id} ${t.title}: in testing for ${days(a)}`, href: `/task/${t.id}`, ageMs: a, key: `long_testing:${t.id}` });
    }
    if (t.status === "done" && t.unmerged && t.closedAt && now - Date.parse(t.closedAt) > LIMITS.unmergedMs) {
      const a = now - Date.parse(t.closedAt);
      out.push({ kind: "unmerged_done", text: `W-${t.id} ${t.title}: declared done ${days(a)} ago, commits not in main`, href: `/task/${t.id}`, ageMs: a, key: `unmerged_done:${t.id}` });
    }
  }
  for (const w of f.worktrees) {
    if (!w.dirty && !w.ahead) continue;
    const a = w.lastTouchedAt ? now - Date.parse(w.lastTouchedAt) : Number.POSITIVE_INFINITY;
    if (a <= LIMITS.staleWorktreeMs) continue;
    const what = [w.dirty ? `${w.dirty} uncommitted` : "", w.ahead ? `${w.ahead} unpushed` : ""].filter(Boolean).join(", ");
    out.push({ kind: "stale_worktree", text: `${w.path}${w.branch ? ` (${w.branch})` : ""}: ${what}, ${Number.isFinite(a) ? `untouched for ${days(a)}` : "no tab ever worked here"}`, href: "/#undone", ageMs: Number.isFinite(a) ? a : 1e15,
      key: `stale_worktree:${w.path.toLowerCase()}:${w.dirty}:${w.ahead}`, path: w.path });
  }
  for (const t of f.waiting) {
    const a = now - Date.parse(t.since);
    if ((t.live === "question" || t.live === "permission") && a > LIMITS.waitingMs) {
      out.push({ kind: "waiting_long", text: `${t.title ?? t.id.slice(0, 8)} has been waiting for you for ${Math.round(a / 60_000)} min`, href: `vscode://anthropic.claude-code/open?session=${t.id}`, ageMs: a, key: `waiting_long:${t.id}:${t.since}` });
    }
  }
  return out.sort((a, b) => b.ageMs - a.ageMs);
}

export function attention(db: Db, cfg: Config, states: Map<string, TabState>, now = Date.now()): Attention[] {
  const tasks = (db.prepare(`SELECT t.id, t.title, t.status, t.closed_at AS closedAt,
      max(t.updated_at, COALESCE((SELECT max(e.at) FROM edits e JOIN task_sessions ts ON ts.session_id = e.session_id WHERE ts.task_id = t.id AND e.at >= COALESCE(t.started_at, t.created_at)), '')) AS lastActivityAt,
      (SELECT max(at) FROM task_events WHERE task_id = t.id AND to_status = 'testing') AS testingSince,
      EXISTS (SELECT 1 FROM commits c WHERE c.task_id = t.id AND c.in_main = 0) AS unmerged
    FROM tasks t WHERE t.status IN ('in_progress','testing') OR (t.status = 'done' AND t.closed_at >= ?)`).all(new Date(now - 14 * 86400_000).toISOString()) as any[])
    .map((t) => ({ ...t, unmerged: !!t.unmerged }));
  const worktrees = (db.prepare(`SELECT w.path, w.branch, w.dirty, w.ahead,
      (SELECT max(l.last_at) FROM locations l JOIN dirs d ON d.path = l.cwd WHERE d.worktree = w.path) AS lastTouchedAt
    FROM worktrees w WHERE w.exists_now = 1 AND (w.dirty > 0 OR w.ahead > 0)`).all() as any[]).filter((w) => !isIgnored(cfg, w.path));
  const title = db.prepare("SELECT title FROM sessions WHERE id = ?");
  const waiting = [...states].filter(([, s]) => s.active && s.liveAt && (s.live === "question" || s.live === "permission"))
    .map(([id, s]) => ({ id, title: (title.get(id) as { title: string | null } | undefined)?.title ?? null, live: s.live!, since: s.liveAt! }));
  const dismissed = new Set((db.prepare("SELECT key FROM dismissed WHERE until IS NULL OR until > ?").all(new Date(now).toISOString()) as { key: string }[]).map((r) => r.key));
  return attentionItems(now, { tasks, worktrees, waiting }).filter((a) => !dismissed.has(a.key));
}

/** Dismiss one item: for good (days = null) or snoozed. Its key changes when the situation changes. */
export function dismiss(db: Db, key: string, days: number | null, now = Date.now()): void {
  if (!/^[a-z_]+:/.test(key) || key.length > 500) throw new Error("bad key");
  db.prepare("INSERT OR REPLACE INTO dismissed(key, until, at) VALUES (?, ?, ?)")
    .run(key, days ? new Date(now + days * 86400_000).toISOString() : null, new Date(now).toISOString());
}
