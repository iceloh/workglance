// Read model for the board: plain objects, no HTML.
import type { Db } from "./db.ts";
import { isIgnored, type Config } from "./config.ts";
import { taskActivity } from "./task-place.ts";
import { costOf, taskCost, type CostSummary } from "./cost.ts";

export type Stage = "done" | "testing" | "in_progress" | "local";

export type CommitView = { sha: string; subject: string; at: string; repo: string; stage: Stage; copies: number };
export type PlaceView = { worktree: string; repo: string | null; branch: string; lastAt: string };
export type TabView = {
  id: string; title: string | null; formerTitles: string[]; entrypoint: string | null;
  firstAt: string | null; lastAt: string | null;
  places: PlaceView[]; promptCount: number; prompts: { at: string; text: string }[]; commits: CommitView[];
  tasks: { id: number; title: string; status: string }[];
};

/** A session with no name and at most one prompt: a headless run or a tab opened and abandoned. */
export const isNoise = (t: { title: string | null; promptCount: number; tasks: unknown[] }) => !t.title && t.promptCount <= 1 && !t.tasks.length;
export type UndoneView = { path: string; repo: string; branch: string | null; dirty: number; ahead: number; upstream: string | null; lastTab: { id: string; title: string | null; at: string } | null };

export function stageOf(c: { in_main: number | null; in_dev: number | null }): Stage {
  if (c.in_main === 1) return "done";
  if (c.in_dev === 1) return "testing";
  if (c.in_main === null && c.in_dev === null) return "local";
  return "in_progress";
}

const RANK: Record<Stage, number> = { done: 3, testing: 2, in_progress: 1, local: 0 };

export function tabs(db: Db, cfg: Config, opts: { sinceIso?: string; promptLimit?: number; showNoise?: boolean } = {}): TabView[] {
  const tasksOf = db.prepare(`SELECT t.id, t.title, t.status FROM task_sessions ts JOIN tasks t ON t.id = ts.task_id
    WHERE ts.session_id = ? ORDER BY ts.last_at DESC LIMIT 10`);
  const sessions = db.prepare(`SELECT id, title, titles, entrypoint, first_at, last_at FROM sessions
    WHERE last_at IS NOT NULL ${opts.sinceIso ? "AND last_at >= ?" : ""} ORDER BY last_at DESC`)
    .all(...(opts.sinceIso ? [opts.sinceIso] : [])) as any[];
  // One entry per worktree. Edits carry no branch; take the branch the tab's own folder reported there.
  const places = db.prepare(`SELECT COALESCE(d.worktree, l.cwd) AS worktree, max(d.repo) AS repo,
      COALESCE(max(NULLIF(l.branch, '')), (SELECT w.branch FROM worktrees w WHERE w.path = COALESCE(d.worktree, l.cwd)), '') AS branch,
      max(l.last_at) AS last_at
    FROM locations l LEFT JOIN dirs d ON d.path = l.cwd WHERE l.session_id = ?
    GROUP BY COALESCE(d.worktree, l.cwd) ORDER BY last_at DESC`);
  const promptCount = db.prepare("SELECT count(*) n FROM prompts WHERE session_id = ?");
  const prompts = db.prepare("SELECT at, text FROM prompts WHERE session_id = ? ORDER BY at DESC LIMIT ?");
  const commits = db.prepare(`SELECT c.sha, c.subject, c.at, c.repo, c.in_dev, c.in_main, r.name AS repo_name
    FROM commits c LEFT JOIN repos r ON r.id = c.repo WHERE c.session_id = ? ORDER BY c.at DESC`);

  const out: TabView[] = [];
  for (const s of sessions) {
    const pl = (places.all(s.id) as any[]).map((p) => ({ worktree: p.worktree, repo: p.repo, branch: p.branch, lastAt: p.last_at }));
    if (pl.length && pl.every((p) => isIgnored(cfg, p.worktree))) continue;
    // A rebase leaves two shas for one change: show it once, at the furthest stage any copy reached.
    const merged = new Map<string, CommitView>();
    for (const c of commits.all(s.id) as any[]) {
      const key = `${c.repo}\u0000${c.subject}`;
      const v: CommitView = { sha: c.sha, subject: c.subject, at: c.at, repo: c.repo_name ?? c.repo, stage: stageOf(c), copies: 1 };
      const prev = merged.get(key);
      if (!prev) merged.set(key, v);
      else merged.set(key, { ...(RANK[v.stage] > RANK[prev.stage] ? v : prev), copies: prev.copies + 1 });
    }
    const titles = JSON.parse(s.titles) as { title: string }[];
    const view = {
      id: s.id, title: s.title, formerTitles: titles.slice(0, -1).map((t) => t.title).reverse(), entrypoint: s.entrypoint,
      firstAt: s.first_at, lastAt: s.last_at, places: pl,
      promptCount: (promptCount.get(s.id) as { n: number }).n,
      prompts: prompts.all(s.id, opts.promptLimit ?? 8) as { at: string; text: string }[],
      commits: [...merged.values()],
      tasks: tasksOf.all(s.id) as { id: number; title: string; status: string }[],
    };
    if (opts.showNoise || !isNoise(view)) out.push(view);
  }
  return out;
}

export type TaskCard = {
  id: number; title: string; type: string; status: string; branch: string | null; worktree: string | null; repo: string | null;
  updatedAt: string; tabs: { id: string; title: string | null }[]; commits: Record<Stage, number>; lastNote: string | null;
  warning: string | null; result: string | null; edits: number; lastActivityAt: string | null; placeSource: string;
  /** The user's latest board change on this task has not reached any of its tabs yet. */
  unseen: boolean;
  /** CI for this task: per branch, the pipeline that covered its newest commit there. */
  ci: { branch: string; number: number; state: string; url: string }[];
  /** Model work of its tabs while it was open, at API list prices. */
  cost: CostSummary;
};

/**
 * Pure: per branch, the latest pipeline among the task's commits. An older failure that a later
 * pipeline (with the fix) passed is history, not the task's state.
 */
export function ciSummary(rows: { branch: string; number: number; state: string; url: string }[]): TaskCard["ci"] {
  const by = new Map<string, TaskCard["ci"][number]>();
  for (const r of rows) if (!by.has(r.branch) || r.number > by.get(r.branch)!.number) by.set(r.branch, r);
  return [...by.values()].sort((a, b) => a.branch.localeCompare(b.branch));
}

/** Per tab: the last user board change it was told about (from the hooks' state files). */
export type SeenMap = Map<string, { seenEventId?: number }>;

/**
 * Declared vs verified: the agent's status against what git says about the task's commits.
 * Commits in a repo without main/dev refs ("local") can't be verified either way and never warn.
 */
export function verification(status: string, c: Record<Stage, number>): string | null {
  const verifiable = c.done + c.testing + c.in_progress;
  if (!verifiable) return null;
  if (status === "done" && c.done < verifiable) return c.testing ? "declared done, but commits are only in dev" : "declared done, but commits are not merged";
  if (status === "testing" && c.testing + c.done === 0) return "declared testing, but nothing reached dev yet";
  if ((status === "in_progress" || status === "planned") && c.done === verifiable) return "all commits are already in main: done?";
  return null;
}

/** Open tasks, plus the ones closed in the selected period. */
const TASK_ROW = "SELECT t.*, r.name AS repo_name FROM tasks t LEFT JOIN repos r ON r.id = t.repo";

export function taskCards(db: Db, opts: { sinceIso?: string; seen?: SeenMap } = {}): TaskCard[] {
  const rows = db.prepare(`${TASK_ROW} WHERE t.status IN ('planned','in_progress','testing') OR (t.status = 'done' AND t.updated_at >= ?)
    ORDER BY t.updated_at DESC`).all(opts.sinceIso ?? "") as any[];
  return rows.map((t) => cardOf(db, t, opts.seen));
}

/** One card from one task row (any status). */
function cardOf(db: Db, t: any, seen: SeenMap = new Map()): TaskCard {
  const lastUser = (db.prepare("SELECT max(id) AS id FROM task_events WHERE task_id = ? AND actor = 'user'").get(t.id) as { id: number | null }).id;
  const commits: Record<Stage, number> = { done: 0, testing: 0, in_progress: 0, local: 0 };
  for (const c of db.prepare("SELECT in_dev, in_main FROM commits WHERE task_id = ?").all(t.id) as any[]) commits[stageOf(c)]++;
  const tabs = db.prepare(`SELECT ts.session_id AS id, s.title FROM task_sessions ts LEFT JOIN sessions s ON s.id = ts.session_id
    WHERE ts.task_id = ? ORDER BY ts.last_at DESC`).all(t.id) as { id: string; title: string | null }[];
  const note = db.prepare("SELECT note FROM task_events WHERE task_id = ? AND note IS NOT NULL ORDER BY id DESC LIMIT 1").get(t.id) as { note: string } | undefined;
  const act = taskActivity(db, t.id);
  return {
    id: t.id, title: t.title, type: t.type, status: t.status, branch: t.branch, worktree: t.worktree, repo: t.repo_name ?? null,
    updatedAt: t.updated_at, tabs, commits, lastNote: note?.note ?? null,
    warning: t.status === "dropped" ? null : verification(t.status, commits), result: t.result,
    edits: act.edits, lastActivityAt: [act.lastAt, t.updated_at].filter(Boolean).sort().at(-1) ?? null, placeSource: t.place_source,
    unseen: lastUser !== null && tabs.length > 0 && tabs.every((s) => (seen.get(s.id)?.seenEventId ?? 0) < lastUser),
    cost: taskCost(db, t.id),
    ci: ciSummary(db.prepare(`SELECT p.branch, p.number, p.state, p.url FROM commits c JOIN commit_pipelines p ON p.sha = COALESCE(c.matched_as, c.sha)
      WHERE c.task_id = ?`).all(t.id) as any[]),
  };
}

export type TimelineItem =
  | { at: string; kind: "event"; actor: string; tab: string | null; what: string; from: string | null; to: string | null; note: string | null }
  | { at: string; kind: "commit"; sha: string; subject: string; stage: Stage; repo: string }
  | { at: string; kind: "prompt"; tab: string | null; text: string };

export type TaskDetail = TaskCard & { description: string | null; createdAt: string; closedAt: string | null; timeline: TimelineItem[]; editsByWorktree: { worktree: string; n: number }[] };

/** Everything about one task, as a single timeline: its events, its commits, and what you asked its tabs meanwhile. */
export function taskDetail(db: Db, id: number, seen?: SeenMap): TaskDetail | null {
  const t = db.prepare(`${TASK_ROW} WHERE t.id = ?`).get(id) as any;
  if (!t) return null;
  const card = cardOf(db, t, seen);
  const title = new Map((db.prepare("SELECT id, title FROM sessions").all() as any[]).map((s) => [s.id, s.title as string | null]));
  const from = t.started_at ?? t.created_at, to = t.closed_at ?? "9999";
  const timeline: TimelineItem[] = [];
  for (const e of db.prepare("SELECT * FROM task_events WHERE task_id = ? ORDER BY id").all(id) as any[]) {
    timeline.push({ at: e.at, kind: "event", actor: e.actor, tab: e.session_id ? (title.get(e.session_id) ?? e.session_id.slice(0, 8)) : null, what: e.kind, from: e.from_status, to: e.to_status, note: e.note });
  }
  for (const c of db.prepare("SELECT c.*, r.name AS repo_name FROM commits c LEFT JOIN repos r ON r.id = c.repo WHERE c.task_id = ?").all(id) as any[]) {
    timeline.push({ at: c.at, kind: "commit", sha: c.sha, subject: c.subject, stage: stageOf(c), repo: c.repo_name ?? c.repo });
  }
  for (const p of db.prepare(`SELECT p.at, p.text, p.session_id FROM prompts p JOIN task_sessions ts ON ts.session_id = p.session_id
    WHERE ts.task_id = ? AND p.at >= ? AND p.at <= ? ORDER BY p.at DESC LIMIT 40`).all(id, from, to) as any[]) {
    timeline.push({ at: p.at, kind: "prompt", tab: title.get(p.session_id) ?? p.session_id.slice(0, 8), text: p.text });
  }
  timeline.sort((a, b) => a.at.localeCompare(b.at));
  const editsByWorktree = db.prepare(`SELECT COALESCE(d.worktree, e.dir) AS worktree, count(*) AS n FROM edits e JOIN task_sessions ts ON ts.session_id = e.session_id
    LEFT JOIN dirs d ON d.path = e.dir WHERE ts.task_id = ? AND e.at >= ? AND e.at <= ? GROUP BY 1 ORDER BY n DESC`).all(id, from, to) as any[];
  return { ...card, description: t.description, createdAt: t.created_at, closedAt: t.closed_at, timeline, editsByWorktree };
}

export type LiveTab = { id: string; title: string | null; live: string; since: string | null; detail: string | null; tasks: { id: number; title: string }[] };

/** Every tracked tab's live status; "needs you" first (question, permission), then the rest by recency. */
export function liveTabs(db: Db, states: Map<string, { active?: boolean; live?: string; liveAt?: string; liveDetail?: string }>): LiveTab[] {
  const title = db.prepare("SELECT title FROM sessions WHERE id = ?");
  const open = db.prepare(`SELECT t.id, t.title FROM task_sessions ts JOIN tasks t ON t.id = ts.task_id
    WHERE ts.session_id = ? AND t.status IN ('in_progress','testing') ORDER BY ts.last_at DESC LIMIT 3`);
  const rank = (l: string) => (l === "permission" ? 0 : l === "question" ? 1 : l === "working" ? 2 : l === "done" ? 3 : 4);
  const out: LiveTab[] = [];
  for (const [id, s] of states) {
    if (!s.active || !s.live || s.live === "closed") continue;
    out.push({ id, title: (title.get(id) as { title: string | null } | undefined)?.title ?? null, live: s.live, since: s.liveAt ?? null, detail: s.liveDetail ?? null, tasks: open.all(id) as any[] });
  }
  return out.sort((a, b) => rank(a.live) - rank(b.live) || String(b.since).localeCompare(String(a.since)));
}

export function undone(db: Db, cfg: Config): UndoneView[] {
  const rows = db.prepare(`SELECT w.path, r.name AS repo, w.branch, w.dirty, w.ahead, w.upstream FROM worktrees w JOIN repos r ON r.id = w.repo
    WHERE w.exists_now = 1 AND (w.dirty > 0 OR w.ahead > 0) ORDER BY r.name, w.path`).all() as any[];
  const last = db.prepare(`SELECT s.id, s.title, max(l.last_at) AS at FROM locations l JOIN dirs d ON d.path = l.cwd
    JOIN sessions s ON s.id = l.session_id WHERE d.worktree = ? GROUP BY s.id ORDER BY at DESC LIMIT 1`);
  return rows.filter((r) => !isIgnored(cfg, r.path)).map((r) => ({ ...r, lastTab: (last.get(r.path) as any) ?? null }));
}

/** The tiny dashboard over the board, for the chosen period (since = undefined: everything). */
export type BoardStats = {
  created: number; done: number; inProgress: number; testing: number;
  costUsd: number; unpriced: number; tabs: number; prompts: number; commits: number;
};

export function boardStats(db: Db, since?: string): BoardStats {
  const from = since ?? "";
  const n = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...(args as any[])) as { n: number }).n;
  // Cost is linear in tokens: sum per model in SQL, price each sum once (no row-by-row walk).
  const byModel = db.prepare(`SELECT model, sum(input) i, sum(output) o, sum(cache_write_5m) w5, sum(cache_write_1h) w1, sum(cache_read) cr, count(*) k
    FROM usage WHERE at >= ? GROUP BY model`).all(from) as { model: string; i: number; o: number; w5: number; w1: number; cr: number; k: number }[];
  let costUsd = 0, unpriced = 0;
  for (const m of byModel) {
    const c = costOf({ model: m.model, input: m.i, output: m.o, cacheWrite5m: m.w5, cacheWrite1h: m.w1, cacheRead: m.cr });
    if (c === null) unpriced += m.k; else costUsd += c;
  }
  return {
    created: n("SELECT count(*) n FROM tasks WHERE created_at >= ?", from),
    done: n("SELECT count(*) n FROM tasks WHERE status = 'done' AND closed_at >= ?", from),
    inProgress: n("SELECT count(*) n FROM tasks WHERE status = 'in_progress'"),
    testing: n("SELECT count(*) n FROM tasks WHERE status = 'testing'"),
    costUsd, unpriced,
    tabs: n("SELECT count(DISTINCT session_id) n FROM prompts WHERE at >= ?", from),
    prompts: n("SELECT count(*) n FROM prompts WHERE at >= ?", from),
    commits: n("SELECT count(*) n FROM commits WHERE at >= ?", from),
  };
}
