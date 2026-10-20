// Full-text search over everything: your prompts, tasks (title, description, result), notes and
// comments, commit subjects. "Where did we fix the e-signature signer?" -> the card, the tab, the commit.
// SQLite FTS5, accent-insensitive. The index is derived data, rebuilt when the source tables changed.
import type { Db } from "./db.ts";

export type Hit = { kind: "prompt" | "task" | "note" | "commit"; ref: string; taskId: number | null; sessionId: string | null; at: string; snippet: string };

export function ensureSearchIndex(db: Db): void {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(body, kind UNINDEXED, ref UNINDEXED, task_id UNINDEXED,
    session_id UNINDEXED, at UNINDEXED, tokenize = 'unicode61 remove_diacritics 2')`);
}

/** Rebuilds the index if any source table changed since the last build (cheap: thousands of rows). */
export function refreshSearchIndex(db: Db): boolean {
  ensureSearchIndex(db);
  const stamp = JSON.stringify(db.prepare(`SELECT (SELECT count(*) FROM prompts) p, (SELECT max(updated_at) FROM tasks) t,
    (SELECT max(id) FROM task_events) e, (SELECT count(*) FROM commits) c, (SELECT count(*) FROM tasks) n`).get());
  const prev = (db.prepare("SELECT value FROM meta WHERE key = 'search_stamp'").get() as { value: string } | undefined)?.value;
  if (prev === stamp) return false;
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM search_fts");
    db.exec(`INSERT INTO search_fts(body, kind, ref, task_id, session_id, at)
      SELECT text, 'prompt', uuid, NULL, session_id, at FROM prompts`);
    db.exec(`INSERT INTO search_fts(body, kind, ref, task_id, session_id, at)
      SELECT title || ' ' || COALESCE(description, '') || ' ' || COALESCE(result, ''), 'task', 'W-' || id, id, created_by, updated_at FROM tasks`);
    db.exec(`INSERT INTO search_fts(body, kind, ref, task_id, session_id, at)
      SELECT note, 'note', 'W-' || task_id, task_id, session_id, at FROM task_events WHERE note IS NOT NULL AND note <> 'moved on the board'`);
    db.exec(`INSERT INTO search_fts(body, kind, ref, task_id, session_id, at)
      SELECT subject, 'commit', sha, task_id, session_id, at FROM commits`);
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('search_stamp', ?)").run(stamp);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return true;
}

/** Pure: what the person typed -> an FTS5 query that can't be a syntax error (each word quoted, prefix match). */
export function toFtsQuery(q: string): string | null {
  const words = q.normalize("NFKC").split(/\s+/).map((w) => w.replace(/["*^:()]/g, "")).filter((w) => w.length > 0).slice(0, 12);
  return words.length ? words.map((w) => `"${w}"*`).join(" ") : null;
}

export function search(db: Db, q: string, limit = 60): Hit[] {
  const fts = toFtsQuery(q);
  if (!fts) return [];
  refreshSearchIndex(db);
  return db.prepare(`SELECT kind, ref, task_id AS taskId, session_id AS sessionId, at, snippet(search_fts, 0, '[[', ']]', ' … ', 14) AS snippet
    FROM search_fts WHERE search_fts MATCH ? ORDER BY bm25(search_fts), at DESC LIMIT ?`).all(fts, limit) as Hit[];
}
