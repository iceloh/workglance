// Workglance calls that failed because the server was down are replayed from the transcripts: the
// transcript already holds every call and its result, so it is the outbox. Found on 19/10/2026: a tab's
// create_task failed with "MCP server is not connected" during a server restart and the task was lost.
import type { Db } from "./db.ts";
import { TaskError } from "./tasks.ts";
import { runTool, TOOL_NAMES, type ToolName } from "./tools.ts";

/** Calls this old may still be in flight (the result line not written yet): wait before judging them. */
const SETTLE_MS = 30_000;
/** A retry by the agent after the failure: same tab, same title, close in time. */
const RETRY_WINDOW_MS = 15 * 60_000;

export type ReplayOutcome = { id: string; tool: string; outcome: string };

export function replayFailedCalls(db: Db, now = Date.now()): ReplayOutcome[] {
  const pending = db.prepare(`SELECT c.* FROM wt_calls c WHERE c.failed = 1 AND c.replayed_at IS NULL AND c.at <= ?
    AND NOT EXISTS (SELECT 1 FROM task_events e WHERE e.call_id = c.id) ORDER BY c.at`).all(new Date(now - SETTLE_MS).toISOString()) as any[];
  const mark = db.prepare("UPDATE wt_calls SET replayed_at = ?, replay_outcome = ? WHERE id = ?");
  const out: ReplayOutcome[] = [];
  for (const c of pending) {
    let outcome: string;
    const tool = c.tool as ToolName;
    const args = JSON.parse(c.input) as Record<string, any>;
    delete args._workglance;
    if (!TOOL_NAMES.includes(tool) || tool === "list_tasks" || !c.cwd) outcome = "skipped: nothing to apply";
    else if (tool === "create_task" && retried(db, c, args)) outcome = "skipped: the tab retried and succeeded";
    else {
      try {
        db.exec("BEGIN");
        const r = runTool(db, tool, args, { session_id: c.session_id, cwd: c.cwd }, c.id) as { ref?: string };
        db.exec("COMMIT");
        outcome = `replayed${r?.ref ? `: ${r.ref}` : ""}`;
      } catch (e) {
        db.exec("ROLLBACK");
        if (!(e instanceof TaskError)) throw e;
        outcome = `refused: ${e.message}`;
      }
    }
    mark.run(new Date(now).toISOString(), outcome, c.id);
    out.push({ id: c.id, tool, outcome });
  }
  return out;
}

function retried(db: Db, c: { session_id: string; at: string }, args: Record<string, any>): boolean {
  const t = Date.parse(c.at);
  return !!db.prepare(`SELECT 1 FROM tasks WHERE created_by = ? AND lower(title) = lower(?) AND created_at BETWEEN ? AND ?`)
    .get(c.session_id, String(args.title ?? "").trim(), new Date(t - RETRY_WINDOW_MS).toISOString(), new Date(t + RETRY_WINDOW_MS).toISOString());
}
