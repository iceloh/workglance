// Untracking a folder from the screen: workglance stops looking at it, and forgets what it stored about it.
// Tasks stay (they are your history and you may want them); everything gathered from the folder goes.
import type { Db } from "./db.ts";
import { setUntracked } from "./config.ts";
import { normalizeDir, pathKey } from "./transcript.ts";

/**
 * Rows whose path is the folder or anything inside it, `_` and `%` taken literally. Case-folded exactly
 * when pathKey folds it (Windows and macOS, and any drive-letter path): the column is lowered too, since
 * SQLite's LIKE only ignores ASCII case.
 */
function under(path: string): { sql: (col: string) => string; args: [string, string] } {
  const p = pathKey(path);
  const fold = pathKey("A", "linux") !== pathKey("A") || /^[a-z]:/i.test(p); // same rule as pathKey
  const sep = /^[a-z]:\\/i.test(p) ? "\\" : "/";
  return {
    sql: (col) => { const c = fold ? `lower(${col})` : col; return `(${c} = ? OR ${c} LIKE ? ESCAPE '!')`; },
    args: [p, p.replace(/[!%_]/g, "!$&") + sep + "%"],
  };
}

export function purgeFolder(db: Db, path: string): Record<string, number> {
  const { sql: underSql, args } = under(path);
  const out: Record<string, number> = {};
  db.exec("BEGIN");
  try {
    for (const [table, col] of [["locations", "cwd"], ["edits", "dir"], ["git_actions", "dir"], ["prompts", "cwd"], ["worktrees", "path"], ["dirs", "path"]] as const) {
      out[table] = Number(db.prepare(`DELETE FROM ${table} WHERE ${underSql(col)}`).run(...args).changes);
    }
    // Commits made in its worktrees (task links are cleared, the tasks themselves stay).
    out.commits = Number(db.prepare(`DELETE FROM commits WHERE ${underSql("COALESCE(worktree, repo)")}`).run(...args).changes);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return out;
}

export type KnownFolder = { path: string; name: string; repo: boolean; lastAt: string; tabs: number };

/**
 * The folders tabs worked in, most recent first: what the untrack search offers. A folder inside a repo's
 * checkout shows as that checkout (one row per worktree, not per subfolder); one outside any repo, as itself.
 * Folders already ignored are left out.
 */
export function knownFolders(db: Db, ignored: (path: string) => boolean, limit = 300): KnownFolder[] {
  const root = new Map((db.prepare("SELECT path, worktree FROM dirs WHERE worktree IS NOT NULL").all() as { path: string; worktree: string }[]).map((r) => [r.path, r.worktree]));
  // A repo's extra worktrees by repo and worktree name ("shop · fix-cart"): they all share the repo's name.
  const names = new Map((db.prepare("SELECT w.path, w.repo, r.name FROM worktrees w JOIN repos r ON r.id = w.repo").all() as { path: string; repo: string; name: string }[])
    .map((r) => [pathKey(r.path), pathKey(r.path) === pathKey(r.repo) ? r.name : `${r.name} · ${r.path.split(/[\\/]/).filter(Boolean).at(-1)}`]));
  const rows = db.prepare("SELECT cwd, session_id, max(last_at) AS last FROM locations GROUP BY cwd, session_id").all() as { cwd: string; session_id: string; last: string }[];
  const by = new Map<string, { path: string; repo: boolean; lastAt: string; tabs: Set<string> }>();
  for (const r of rows) {
    const wt = root.get(normalizeDir(r.cwd));
    const path = wt ?? normalizeDir(r.cwd), key = pathKey(path);
    if (ignored(path)) continue;
    const g = by.get(key) ?? by.set(key, { path, repo: !!wt, lastAt: r.last, tabs: new Set() }).get(key)!;
    if (r.last > g.lastAt) g.lastAt = r.last;
    g.tabs.add(r.session_id);
  }
  return [...by.entries()].map(([key, g]) => ({ path: g.path, name: names.get(key) ?? g.path.split(/[\\/]/).filter(Boolean).at(-1) ?? g.path,
    repo: g.repo, lastAt: g.lastAt, tabs: g.tabs.size })).sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, limit);
}

export function untrack(db: Db, path: string): { untracked: string[]; purged: Record<string, number> } {
  return { untracked: setUntracked(path, true), purged: purgeFolder(db, path) };
}

export function retrack(path: string): string[] {
  return setUntracked(path, false);
}
