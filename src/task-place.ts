// Where a task really happened. The tab's folder at creation is only a guess: tabs often work in other
// repos by absolute path (the first real task, W-1, was stamped `shop/dev` while all of its work
// was in `workglance`). The evidence is what the task's tabs edited and committed while it was open.
import type { Db } from "./db.ts";

/** A commit is much stronger evidence than one edit (an edit can be a stray note in another repo). */
export const COMMIT_WEIGHT = 5;

export type Evidence = { worktree: string; edits: number; commits: number };

/** Pure: the worktree with the most weighted evidence, or null when there is none at all. */
export function choosePlace(evidence: Evidence[]): string | null {
  let best: Evidence | null = null, bestScore = 0;
  for (const e of evidence) {
    const score = e.edits + e.commits * COMMIT_WEIGHT;
    if (score > bestScore) { best = e; bestScore = score; }
  }
  return best?.worktree ?? null;
}

/** Recomputes the place of open tasks and of tasks closed in the last 2 days. Returns how many moved. */
export function placeTasks(db: Db): number {
  const tasks = db.prepare(`SELECT id, worktree, repo, branch, created_at, started_at, closed_at FROM tasks
    WHERE status IN ('planned','in_progress','testing') OR closed_at >= ?`).all(new Date(Date.now() - 2 * 86400_000).toISOString()) as any[];
  const edits = db.prepare(`SELECT d.worktree, count(*) AS n FROM edits e JOIN task_sessions ts ON ts.session_id = e.session_id
    JOIN dirs d ON d.path = e.dir WHERE ts.task_id = ? AND e.at >= ? AND e.at <= ? AND d.worktree IS NOT NULL GROUP BY d.worktree`);
  const commits = db.prepare("SELECT worktree, count(*) AS n FROM commits WHERE task_id = ? AND worktree IS NOT NULL GROUP BY worktree");
  const wt = db.prepare("SELECT w.path, w.repo, w.branch FROM worktrees w WHERE w.path = ?");
  const move = db.prepare("UPDATE tasks SET worktree = ?, repo = ?, branch = ?, place_source = 'activity' WHERE id = ?");
  let moved = 0;
  for (const t of tasks) {
    const from = t.started_at ?? t.created_at;
    const to = t.closed_at ? new Date(Date.parse(t.closed_at) + 60_000).toISOString() : "9999";
    const byWt = new Map<string, Evidence>();
    for (const r of edits.all(t.id, from, to) as any[]) byWt.set(r.worktree, { worktree: r.worktree, edits: r.n, commits: 0 });
    for (const r of commits.all(t.id) as any[]) {
      const e = byWt.get(r.worktree) ?? { worktree: r.worktree, edits: 0, commits: 0 };
      e.commits = r.n;
      byWt.set(r.worktree, e);
    }
    const place = choosePlace([...byWt.values()]);
    if (!place) continue;
    // A worktree the tab just made is edited before git has looked at it: wait for that, instead of
    // placing the task with no repo (W-55); a task placed that way before is completed here.
    const w = wt.get(place) as { path: string; repo: string; branch: string | null } | undefined;
    if (!w || (place === t.worktree && t.repo)) continue;
    move.run(place, w.repo, w.branch, t.id);
    moved++;
  }
  return moved;
}

/** Per-task activity for the board: edits and the last time anything happened on it. */
export function taskActivity(db: Db, taskId: number): { edits: number; lastAt: string | null } {
  const t = db.prepare("SELECT created_at, started_at, closed_at FROM tasks WHERE id = ?").get(taskId) as any;
  if (!t) return { edits: 0, lastAt: null };
  // Only edits inside a git worktree are work: scratchpad scripts and memory files are not.
  const r = db.prepare(`SELECT count(*) AS n, max(e.at) AS last FROM edits e JOIN task_sessions ts ON ts.session_id = e.session_id
    JOIN dirs d ON d.path = e.dir WHERE ts.task_id = ? AND e.at >= ? AND e.at <= ? AND d.worktree IS NOT NULL`).get(taskId, t.started_at ?? t.created_at, t.closed_at ?? "9999") as any;
  return { edits: r.n, lastAt: r.last };
}
