// SQLite in one file (node:sqlite, built into Node 24: no native build, no database server).
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { WORKGLANCE_HOME, CLAUDE_PROJECTS, DB_FILE } from "./paths.ts";

export { WORKGLANCE_HOME, CLAUDE_PROJECTS };

export type Db = DatabaseSync;

export function openDb(file = join(WORKGLANCE_HOME, DB_FILE)): Db {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // 30 s: one big transcript is read in one transaction and can hold the write lock for seconds.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 30000; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  addColumn(db, "commits", "task_id", "INTEGER");
  // Where the task's place came from: 'cwd' (the tab's folder at creation) or 'activity' (its edits/commits).
  addColumn(db, "tasks", "place_source", "TEXT NOT NULL DEFAULT 'cwd'");
  // A subagent log is never a tab's transcript (older versions stored one when the subagent was read first).
  db.exec("UPDATE sessions SET transcript = NULL WHERE transcript LIKE '%\\subagents\\%' OR transcript LIKE '%/subagents/%'");
  addColumn(db, "task_events", "call_id", "TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS task_events_call ON task_events(call_id)");
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  // Which parser read each file (see PARSER_VERSION in transcript.ts). A scanner re-reads files read by
  // an older parser than its own. No global "migrate" flag: twice an old server's worker ran the new
  // migration while the old server re-read everything with the old parser, losing the re-read.
  addColumn(db, "files", "parser_version", "INTEGER NOT NULL DEFAULT 3");
  // "These commits are this task's": the agent's own word, used before any timing rule (see linkCommitsToTasks).
  db.exec("CREATE TABLE IF NOT EXISTS commit_claims (sha TEXT PRIMARY KEY, task_id INTEGER NOT NULL, at TEXT NOT NULL)");
  return db;
}

/** Additive migrations for databases created by an earlier version. */
function addColumn(db: Db, table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (          -- transcript files and how far we have read them
  path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime_ms REAL NOT NULL, offset INTEGER NOT NULL,
  session_id TEXT, subagent INTEGER NOT NULL DEFAULT 0, last_at TEXT);

CREATE TABLE IF NOT EXISTS sessions (       -- one per Claude tab, forever, whatever it is called
  id TEXT PRIMARY KEY, transcript TEXT, entrypoint TEXT, first_at TEXT, last_at TEXT,
  title TEXT, titles TEXT NOT NULL DEFAULT '[]');

CREATE TABLE IF NOT EXISTS prompts (
  uuid TEXT PRIMARY KEY, session_id TEXT NOT NULL, at TEXT NOT NULL, text TEXT NOT NULL, cwd TEXT, branch TEXT);
CREATE INDEX IF NOT EXISTS prompts_session ON prompts(session_id, at);

CREATE TABLE IF NOT EXISTS locations (      -- where a session worked: folder + branch, first/last seen
  session_id TEXT NOT NULL, cwd TEXT NOT NULL, branch TEXT NOT NULL DEFAULT '',
  first_at TEXT NOT NULL, last_at TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, cwd, branch));

CREATE TABLE IF NOT EXISTS git_actions (    -- "this tab ran git commit/push/... in this folder at this time"
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, at TEXT NOT NULL, action TEXT NOT NULL,
  dir TEXT NOT NULL, command TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS git_actions_dir ON git_actions(dir, at);

CREATE TABLE IF NOT EXISTS edits (          -- one row per file edit: when and in which folder
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, at TEXT NOT NULL, dir TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS edits_session ON edits(session_id, at);

CREATE TABLE IF NOT EXISTS wt_calls (       -- every workglance tool call seen in a transcript (the transcript is the outbox)
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, at TEXT NOT NULL, tool TEXT NOT NULL, input TEXT NOT NULL,
  cwd TEXT, failed INTEGER NOT NULL DEFAULT 0, replayed_at TEXT, replay_outcome TEXT);

CREATE TABLE IF NOT EXISTS usage (          -- one row per model response (deduplicated by message id)
  msg_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, at TEXT NOT NULL, model TEXT NOT NULL,
  input INTEGER NOT NULL, output INTEGER NOT NULL, cache_write_5m INTEGER NOT NULL, cache_write_1h INTEGER NOT NULL, cache_read INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS usage_session ON usage(session_id, at);

CREATE TABLE IF NOT EXISTS dismissed (        -- "needs attention" items the user dismissed (until NULL = for good)
  key TEXT PRIMARY KEY, until TEXT, at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS commit_pipelines ( -- the CI pipeline that covered a commit on a branch
  sha TEXT NOT NULL, branch TEXT NOT NULL, number INTEGER, state TEXT, url TEXT, checked_at TEXT,
  PRIMARY KEY (sha, branch));

CREATE TABLE IF NOT EXISTS dirs (           -- folder -> git worktree / repo (cached; folders get deleted)
  path TEXT PRIMARY KEY, worktree TEXT, repo TEXT, checked_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, main_ref TEXT, dev_ref TEXT, checked_at TEXT);

CREATE TABLE IF NOT EXISTS worktrees (
  path TEXT PRIMARY KEY, repo TEXT NOT NULL, branch TEXT, head TEXT, dirty INTEGER, ahead INTEGER,
  upstream TEXT, exists_now INTEGER NOT NULL DEFAULT 1, checked_at TEXT);

CREATE TABLE IF NOT EXISTS commits (
  sha TEXT PRIMARY KEY, repo TEXT NOT NULL, worktree TEXT, at TEXT NOT NULL, subject TEXT NOT NULL,
  session_id TEXT, action_id TEXT, in_dev INTEGER, in_main INTEGER, matched_as TEXT, checked_at TEXT);
CREATE INDEX IF NOT EXISTS commits_session ON commits(session_id);

CREATE TABLE IF NOT EXISTS patch_ids (       -- git patch-id is expensive; a sha's patch never changes
  sha TEXT PRIMARY KEY, pid TEXT);

CREATE TABLE IF NOT EXISTS checks (          -- when each repo's commits were last looked at
  repo TEXT PRIMARY KEY, commits_at TEXT);

CREATE TABLE IF NOT EXISTS tasks (           -- a MAIN piece of work, declared by an agent (or the user)
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL,
  description TEXT, result TEXT, parent_id INTEGER, created_by TEXT,
  repo TEXT, worktree TEXT, branch TEXT, cwd TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, closed_at TEXT);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status, updated_at);

CREATE TABLE IF NOT EXISTS task_sessions (   -- every tab that worked on a task
  task_id INTEGER NOT NULL, session_id TEXT NOT NULL, first_at TEXT NOT NULL, last_at TEXT NOT NULL,
  PRIMARY KEY (task_id, session_id));
CREATE INDEX IF NOT EXISTS task_sessions_session ON task_sessions(session_id, last_at);

CREATE TABLE IF NOT EXISTS task_events (     -- append-only history: who changed what, when, why
  id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL,
  session_id TEXT, kind TEXT NOT NULL, from_status TEXT, to_status TEXT, note TEXT);
CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id, at);
`;
