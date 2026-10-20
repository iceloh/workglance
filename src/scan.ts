// Reads Claude Code transcripts incrementally: each file from the byte where we stopped last time.
// The first run reads everything once (backfill); later runs read only what was appended.
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parseRecord, PARSER_VERSION, type Fact } from "./transcript.ts";
import { isIgnored, loadConfig, type Config } from "./config.ts";
import { CLAUDE_PROJECTS, type Db } from "./db.ts";

/** A fact that happened in an untracked folder (where the tab was, or the file it edited / the repo it committed in). */
export function untrackedFact(cfg: Config, f: Fact): boolean {
  const where = f.kind === "loc" ? f.cwd : f.kind === "edit" || f.kind === "git" ? f.dir : f.kind === "prompt" ? f.cwd : null;
  return where !== null && isIgnored(cfg, where);
}

const CHUNK = 4 * 1024 * 1024;

export type ScanStats = { files: number; read: number; bytes: number; facts: number; ms: number };

export function listTranscripts(root = CLAUDE_PROJECTS): { path: string; subagent: boolean }[] {
  const out: { path: string; subagent: boolean }[] = [];
  for (const project of safeReaddir(root)) {
    const pdir = join(root, project);
    for (const f of safeReaddir(pdir)) {
      if (f.endsWith(".jsonl")) out.push({ path: join(pdir, f), subagent: false });
      else {
        const sub = join(pdir, f, "subagents");
        for (const s of safeReaddir(sub)) if (s.endsWith(".jsonl")) out.push({ path: join(sub, s), subagent: true });
      }
    }
  }
  return out;
}

export function scan(db: Db, root = CLAUDE_PROJECTS): ScanStats {
  const t0 = Date.now();
  const stats: ScanStats = { files: 0, read: 0, bytes: 0, facts: 0, ms: 0 };
  // One scanner at a time (the server's catch-up, a `workglance scan`, a server just auto-started by a
  // tab): the second one skips instead of fighting for the write lock. A lease, so a crash can't wedge it.
  if (!takeScanLease(db)) return { ...stats, ms: Date.now() - t0 };
  try { return scanFiles(db, root, stats, t0); } finally { db.prepare("DELETE FROM meta WHERE key = 'scan_lease' AND value LIKE ?").run(`${LEASE_OWNER}|%`); }
}

const LEASE_OWNER = `${process.pid}:${Math.random().toString(36).slice(2)}`;
const LEASE_MS = 10 * 60_000;

function takeScanLease(db: Db): boolean {
  const now = Date.now();
  db.exec("BEGIN IMMEDIATE");
  try {
    const cur = db.prepare("SELECT value FROM meta WHERE key = 'scan_lease'").get() as { value: string } | undefined;
    const [owner, until] = (cur?.value ?? "").split("|");
    if (cur && owner !== LEASE_OWNER && Number(until) > now) { db.exec("COMMIT"); return false; }
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('scan_lease', ?)").run(`${LEASE_OWNER}|${now + LEASE_MS}`);
    db.exec("COMMIT");
    return true;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function scanFiles(db: Db, root: string, stats: ScanStats, t0: number): ScanStats {
  const cfg = loadConfig(); // read per scan: a folder untracked on the screen is skipped from the next scan on
  const getFile = db.prepare("SELECT size, mtime_ms, offset, parser_version FROM files WHERE path = ?");
  for (const { path, subagent } of listTranscripts(root)) {
    stats.files++;
    let st;
    try { st = statSync(path); } catch { continue; }
    const prev = getFile.get(path) as { size: number; mtime_ms: number; offset: number; parser_version: number } | undefined;
    // Read by an older parser than this one: read again from the start (facts are idempotent).
    const stale = !!prev && prev.parser_version < PARSER_VERSION;
    if (prev && !stale && prev.size === st.size && prev.mtime_ms === st.mtimeMs) continue;
    // A file that shrank was rewritten: read it again from the start too.
    const from = prev && !stale && st.size >= prev.offset ? prev.offset : 0;
    const r = readFrom(db, path, from, subagent, cfg);
    stats.read++; stats.bytes += r.offset - from; stats.facts += r.facts;
    db.prepare(`INSERT INTO files(path, size, mtime_ms, offset, session_id, subagent, last_at, parser_version) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime_ms=excluded.mtime_ms, offset=excluded.offset, parser_version=excluded.parser_version,
        session_id=COALESCE(excluded.session_id, files.session_id), last_at=COALESCE(excluded.last_at, files.last_at)`)
      .run(path, st.size, st.mtimeMs, r.offset, r.sessionId, subagent ? 1 : 0, r.lastAt, PARSER_VERSION);
  }
  stats.ms = Date.now() - t0;
  return stats;
}

/** Reads complete lines from `from` to the end. Returns the offset after the last complete line. */
function readFrom(db: Db, path: string, from: number, subagent: boolean, cfg: Config) {
  const fd = openSync(path, "r");
  const buf = Buffer.alloc(CHUNK);
  let offset = from, carry = Buffer.alloc(0), facts = 0;
  let sessionId: string | null = subagent ? null : basename(path, ".jsonl");
  let lastAt: string | null = null;
  const w = writers(db);
  db.exec("BEGIN");
  try {
    // Reading a session's own transcript from the start rebuilds its rename history (no duplicates).
    if (from === 0 && sessionId) db.prepare("UPDATE sessions SET titles = '[]' WHERE id = ?").run(sessionId);
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK, offset + carry.length);
      if (n <= 0) break;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      let start = 0;
      for (let i = data.indexOf(10, start); i !== -1; i = data.indexOf(10, start)) {
        const line = data.subarray(start, i).toString("utf8");
        start = i + 1;
        if (!line.trim()) continue;
        let rec: Record<string, any>;
        try { rec = JSON.parse(line); } catch { continue; }
        // Subagent logs carry the parent session id: their git actions belong to the tab that started them.
        const sid = typeof rec.sessionId === "string" ? rec.sessionId : sessionId;
        if (!sid) continue;
        sessionId ??= sid;
        if (typeof rec.timestamp === "string") lastAt = rec.timestamp;
        for (const f of parseRecord(rec)) {
          if (subagent && (f.kind === "prompt" || f.kind === "title")) continue;
          facts++;
          // A subagent log is never the tab's transcript (tab names are read from the transcript).
          // Untracked folders are not looked at: nothing from them is stored.
          if (untrackedFact(cfg, f)) continue;
          w.fact(sid, f, subagent ? null : path, lastAt);
        }
      }
      offset += start;
      carry = Buffer.from(data.subarray(start));
      if (n < CHUNK) break;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    closeSync(fd);
  }
  return { offset, facts, sessionId, lastAt };
}

function writers(db: Db) {
  const session = db.prepare(`INSERT INTO sessions(id, transcript, entrypoint, first_at, last_at) VALUES (?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      transcript = COALESCE(excluded.transcript, sessions.transcript),
      entrypoint = COALESCE(excluded.entrypoint, sessions.entrypoint),
      first_at = CASE WHEN excluded.first_at IS NULL THEN sessions.first_at
        WHEN sessions.first_at IS NULL OR excluded.first_at < sessions.first_at THEN excluded.first_at ELSE sessions.first_at END,
      last_at = CASE WHEN excluded.last_at IS NULL THEN sessions.last_at
        WHEN sessions.last_at IS NULL OR excluded.last_at > sessions.last_at THEN excluded.last_at ELSE sessions.last_at END`);
  const title = db.prepare("SELECT title, titles FROM sessions WHERE id = ?");
  const setTitle = db.prepare("UPDATE sessions SET title = ?, titles = ? WHERE id = ?");
  const prompt = db.prepare("INSERT OR IGNORE INTO prompts(uuid, session_id, at, text, cwd, branch) VALUES (?,?,?,?,?,?)");
  const loc = db.prepare(`INSERT INTO locations(session_id, cwd, branch, first_at, last_at, hits) VALUES (?,?,?,?,?,1)
    ON CONFLICT(session_id, cwd, branch) DO UPDATE SET first_at = MIN(first_at, excluded.first_at),
      last_at = MAX(last_at, excluded.last_at), hits = hits + 1`);
  const git = db.prepare("INSERT OR IGNORE INTO git_actions(id, session_id, at, action, dir, command) VALUES (?,?,?,?,?,?)");
  const edit = db.prepare("INSERT OR IGNORE INTO edits(id, session_id, at, dir) VALUES (?,?,?,?)");
  const wtcall = db.prepare("INSERT OR IGNORE INTO wt_calls(id, session_id, at, tool, input, cwd) VALUES (?,?,?,?,?,?)");
  const wtfail = db.prepare("UPDATE wt_calls SET failed = 1 WHERE id = ?");
  const usage = db.prepare(`INSERT OR IGNORE INTO usage(msg_id, session_id, at, model, input, output, cache_write_5m, cache_write_1h, cache_read)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  return {
    fact(sid: string, f: ReturnType<typeof parseRecord>[number], transcript: string | null, lastAt: string | null) {
      if (f.kind === "title") {
        session.run(sid, transcript, null, lastAt, lastAt);
        const row = title.get(sid) as { title: string | null; titles: string };
        const titles: { title: string; at: string | null }[] = JSON.parse(row.titles);
        if (titles.at(-1)?.title !== f.title) {
          titles.push({ title: f.title, at: lastAt });
          setTitle.run(f.title, JSON.stringify(titles), sid);
        }
        return;
      }
      // A failure carries no time of its own: it only marks the call it belongs to.
      if (f.kind === "wtfail") { wtfail.run(f.id); return; }
      session.run(sid, transcript, f.kind === "loc" ? f.entrypoint : null, f.at, f.at);
      if (f.kind === "prompt") prompt.run(f.uuid, sid, f.at, f.text, f.cwd, f.branch);
      else if (f.kind === "loc") loc.run(sid, f.cwd, f.branch ?? "", f.at, f.at);
      else if (f.kind === "git") git.run(f.id, sid, f.at, f.action, f.dir, f.command);
      else if (f.kind === "edit") edit.run(f.id, sid, f.at, f.dir);
      else if (f.kind === "wtcall") wtcall.run(f.id, sid, f.at, f.tool, JSON.stringify(f.input), f.cwd);
      else if (f.kind === "usage") usage.run(f.id, sid, f.at, f.model, f.input, f.output, f.cacheWrite5m, f.cacheWrite1h, f.cacheRead);
    },
  };
}

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}
