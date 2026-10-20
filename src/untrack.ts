// Untracking a folder from the screen: workglance stops looking at it, and forgets what it stored about it.
// Tasks stay (they are your history and you may want them); everything gathered from the folder goes.
import type { Db } from "./db.ts";
import { setUntracked } from "./config.ts";
import { pathKey } from "./transcript.ts";

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

export function untrack(db: Db, path: string): { untracked: string[]; purged: Record<string, number> } {
  return { untracked: setUntracked(path, true), purged: purgeFolder(db, path) };
}

export function retrack(path: string): string[] {
  return setUntracked(path, false);
}
