// Scheduled digests: at the times the user picked (default 08:00; several allowed, e.g. 08:00, 13:00, 18:00),
// Workglance writes a digest of everything since the previous one. Each digest covers previous slot -> this
// slot. Missed slots (the computer was off) produce ONE digest covering the whole gap, never a flood.
import type { Db } from "./db.ts";

export type DigestRun = { id: string; from: string; to: string; summary: string | null; createdAt: string; readAt: string | null };

/** "08:00, 13:00" or ["8:00", "13:00"] -> ["08:00", "13:00"]: valid, sorted, unique, at most 6. Default 08:00. */
export function parseTimes(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\s]+/) : [];
  const out = new Set<string>();
  for (const t of raw) {
    const m = String(t).trim().match(/^(\d{1,2}):(\d{2})$/);
    if (m && Number(m[1]) < 24 && Number(m[2]) < 60) out.add(`${m[1]!.padStart(2, "0")}:${m[2]}`);
  }
  const list = [...out].sort().slice(0, 6);
  return list.length ? list : ["08:00"];
}

/** A run's id: its slot in local time, "2026-10-21 08:00". */
export function slotId(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The most recent scheduled moment at or before `now` (local time; looks back up to two days). */
export function latestSlot(now: Date, times: string[]): Date {
  let best: Date | null = null;
  for (let back = 0; back <= 2 && !best; back++) {
    for (const t of times) {
      const [h, m] = t.split(":").map(Number);
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, h!, m!, 0, 0);
      if (d <= now && (!best || d > best)) best = d;
    }
  }
  return best!;
}

/** Pure: the digest that is due now, if any. The first one ever covers the 24 hours before its slot. */
export function dueRun(now: Date, times: string[], lastTo: string | null): { id: string; from: string; to: string } | null {
  const slot = latestSlot(now, times);
  if (lastTo && Date.parse(lastTo) >= slot.getTime()) return null;
  const from = lastTo ?? new Date(slot.getTime() - 86400_000).toISOString();
  return { id: slotId(slot), from, to: slot.toISOString() };
}

const row = (r: any): DigestRun => ({ id: r.id, from: r.from_at, to: r.to_at, summary: r.summary, createdAt: r.created_at, readAt: r.read_at });

export function ensureDigestTable(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS digests (id TEXT PRIMARY KEY, from_at TEXT NOT NULL, to_at TEXT NOT NULL,
    summary TEXT, created_at TEXT NOT NULL, read_at TEXT)`);
}

export function latestRun(db: Db): DigestRun | null {
  const r = db.prepare("SELECT * FROM digests ORDER BY to_at DESC LIMIT 1").get();
  return r ? row(r) : null;
}

export function getRun(db: Db, id: string): DigestRun | null {
  const r = db.prepare("SELECT * FROM digests WHERE id = ?").get(id);
  return r ? row(r) : null;
}

/** The runs before and after one, for the page's ← previous / next → links. */
export function neighbours(db: Db, run: DigestRun): { prev: string | null; next: string | null } {
  const prev = db.prepare("SELECT id FROM digests WHERE to_at < ? ORDER BY to_at DESC LIMIT 1").get(run.to) as { id: string } | undefined;
  const next = db.prepare("SELECT id FROM digests WHERE to_at > ? ORDER BY to_at LIMIT 1").get(run.to) as { id: string } | undefined;
  return { prev: prev?.id ?? null, next: next?.id ?? null };
}

/** Creates the due digest, if any. Returns it so the caller can ask for the written summary. */
export function runDueDigest(db: Db, times: string[], now = new Date()): DigestRun | null {
  const due = dueRun(now, times, latestRun(db)?.to ?? null);
  if (!due) return null;
  db.prepare("INSERT OR IGNORE INTO digests(id, from_at, to_at, created_at) VALUES (?, ?, ?, ?)").run(due.id, due.from, due.to, now.toISOString());
  return getRun(db, due.id);
}

export function setRunSummary(db: Db, id: string, summary: string): void {
  db.prepare("UPDATE digests SET summary = ? WHERE id = ?").run(summary, id);
}

export function markRunRead(db: Db, id: string, now = new Date()): void {
  db.prepare("UPDATE digests SET read_at = COALESCE(read_at, ?) WHERE id = ?").run(now.toISOString(), id);
}
