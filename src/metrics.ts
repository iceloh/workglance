// How the protocol is doing on real work (no extra model calls): measured from what is already stored.
import type { Db } from "./db.ts";
import type { TabState } from "./state.ts";

/** After a nudge, an agent that links its work calls workglance within this window; otherwise it declined. */
export const NUDGE_RESPONSE_MS = 15 * 60_000;

export type Metrics = {
  since: string;
  commits: { total: number; linked: number };
  nudges: { total: number; linked: number; declined: number; pending: number };
  tasks: { created: number; done: number; doneWithoutResult: { id: number; title: string }[]; thinInvestigations: { id: number; title: string }[]; quickEmpty: { id: number; title: string }[] };
  perTab: { id: string; title: string | null; tasks: number; commits: number; linkedCommits: number }[];
};

/** Pure: each nudge is linked (a workglance call followed within the window), declined, or still pending. */
export function nudgeOutcomes(nudges: { sid: string; at: string }[], calls: { sid: string; at: string }[], now: number) {
  let linked = 0, declined = 0, pending = 0;
  for (const n of nudges) {
    const t = Date.parse(n.at);
    if (calls.some((c) => c.sid === n.sid && Date.parse(c.at) >= t && Date.parse(c.at) <= t + NUDGE_RESPONSE_MS)) linked++;
    else if (now - t < NUDGE_RESPONSE_MS) pending++;
    else declined++;
  }
  return { total: nudges.length, linked, declined, pending };
}

export function metrics(db: Db, states: Map<string, TabState>, sinceIso: string, now = Date.now()): Metrics {
  const commits = db.prepare(`SELECT count(*) AS total, sum(task_id IS NOT NULL) AS linked FROM commits WHERE session_id IS NOT NULL AND at >= ?`).get(sinceIso) as { total: number; linked: number | null };
  const nudges = [...states].flatMap(([sid, s]) => (s.nudgeLog ?? []).filter((at) => at >= sinceIso).map((at) => ({ sid, at })));
  const calls = (db.prepare(`SELECT session_id AS sid, at FROM wt_calls WHERE tool IN ('create_task','take_task','update_task') AND at >= ?`).all(sinceIso) as { sid: string; at: string }[]);
  // Live calls are stamped on events too (call_id); include them in case the transcript was not scanned yet.
  const liveCalls = db.prepare(`SELECT session_id AS sid, at FROM task_events WHERE actor = 'agent' AND at >= ? AND session_id IS NOT NULL`).all(sinceIso) as { sid: string; at: string }[];
  const done = db.prepare(`SELECT id, title, type, result, created_at, closed_at FROM tasks WHERE status = 'done' AND closed_at >= ?`).all(sinceIso) as any[];
  const work = db.prepare(`SELECT (SELECT count(*) FROM commits WHERE task_id = ?) + (SELECT count(*) FROM edits e JOIN task_sessions ts ON ts.session_id = e.session_id
    WHERE ts.task_id = ? AND e.at >= ? AND e.at <= ?) AS n`);
  return {
    since: sinceIso,
    commits: { total: commits.total, linked: commits.linked ?? 0 },
    nudges: nudgeOutcomes(nudges, [...calls, ...liveCalls], now),
    tasks: {
      created: (db.prepare("SELECT count(*) AS n FROM tasks WHERE created_at >= ?").get(sinceIso) as { n: number }).n,
      done: done.length,
      doneWithoutResult: done.filter((t) => !t.result?.trim()).map(({ id, title }) => ({ id, title })),
      // An investigation's result IS its findings: a line saying "done" is not findings.
      thinInvestigations: done.filter((t) => t.type === "investigation" && (t.result ?? "").trim().length < 80).map(({ id, title }) => ({ id, title })),
      // Closed within 10 minutes with no edit and no commit: probably not a main task (or registered after the fact).
      quickEmpty: done.filter((t) => Date.parse(t.closed_at) - Date.parse(t.created_at) < 10 * 60_000
        && (work.get(t.id, t.id, t.created_at, t.closed_at) as { n: number }).n === 0).map(({ id, title }) => ({ id, title })),
    },
    perTab: db.prepare(`SELECT s.id, s.title,
        (SELECT count(*) FROM tasks t WHERE t.created_by = s.id AND t.created_at >= ?) AS tasks,
        (SELECT count(*) FROM commits c WHERE c.session_id = s.id AND c.at >= ?) AS commits,
        (SELECT count(*) FROM commits c WHERE c.session_id = s.id AND c.at >= ? AND c.task_id IS NOT NULL) AS linkedCommits
      FROM sessions s WHERE s.last_at >= ? ORDER BY commits DESC, tasks DESC`).all(sinceIso, sinceIso, sinceIso, sinceIso)
      .filter((r: any) => r.tasks || r.commits) as Metrics["perTab"],
  };
}
