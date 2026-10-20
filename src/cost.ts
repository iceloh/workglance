// What the work cost, at API list prices. On a subscription this is not the bill: it is a measure of
// how much model work a task took, comparable across tasks and tabs.
import type { Db } from "./db.ts";
import { loadConfig } from "./config.ts";

/** $ per million tokens. Cached 2026-10-06 from the Claude API model table; override in config `prices`. */
export const DEFAULT_PRICES: Record<string, { input: number; output: number; cacheRead?: number }> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};
export const PRICES_AS_OF = "2026-10-06";

/** The built-in table with `prices` from config.json on top (re-read at most once a minute). */
let cached: { at: number; prices: typeof DEFAULT_PRICES } | null = null;
export function activePrices(now = Date.now()): typeof DEFAULT_PRICES {
  if (!cached || now - cached.at > 60_000) cached = { at: now, prices: { ...DEFAULT_PRICES, ...loadConfig().prices } };
  return cached.prices;
}

export type Usage = { model: string; input: number; output: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number };

/** `claude-opus-5[1m]`, `claude-haiku-4-5-20251001` -> the table key. Unknown models have no price (not a guess). */
export function priceFor(model: string, prices = activePrices()) {
  const m = model.replace(/\[.*\]$/, "").replace(/-\d{8}$/, "");
  return prices[m] ?? null;
}

/** Pure: dollars for one response. Cache writes 1.25x input (5 min) / 2x (1 h); reads 0.1x unless the model lists its own. */
export function costOf(u: Usage, prices = activePrices()): number | null {
  const p = priceFor(u.model, prices);
  if (!p) return null;
  const read = p.cacheRead ?? p.input * 0.1;
  return (u.input * p.input + u.output * p.output + u.cacheWrite5m * p.input * 1.25 + u.cacheWrite1h * p.input * 2 + u.cacheRead * read) / 1_000_000;
}

export type CostSummary = { usd: number; responses: number; outputTokens: number; unpriced: number };

/** Usage of the given tabs between two instants (a task's open window). Subagent usage counts for its tab. */
export function costBetween(db: Db, sessionIds: string[], from: string, to: string, prices = activePrices()): CostSummary {
  const out: CostSummary = { usd: 0, responses: 0, outputTokens: 0, unpriced: 0 };
  if (!sessionIds.length) return out;
  const rows = db.prepare(`SELECT model, input, output, cache_write_5m, cache_write_1h, cache_read FROM usage
    WHERE session_id IN (${sessionIds.map(() => "?").join(",")}) AND at >= ? AND at <= ?`).all(...sessionIds, from, to) as any[];
  for (const r of rows) {
    const c = costOf({ model: r.model, input: r.input, output: r.output, cacheWrite5m: r.cache_write_5m, cacheWrite1h: r.cache_write_1h, cacheRead: r.cache_read }, prices);
    out.responses++;
    out.outputTokens += r.output;
    if (c === null) out.unpriced++; else out.usd += c;
  }
  return out;
}

export function taskCost(db: Db, taskId: number, prices = activePrices()): CostSummary {
  const t = db.prepare("SELECT created_at, started_at, closed_at FROM tasks WHERE id = ?").get(taskId) as any;
  if (!t) return { usd: 0, responses: 0, outputTokens: 0, unpriced: 0 };
  const tabs = (db.prepare("SELECT session_id FROM task_sessions WHERE task_id = ?").all(taskId) as { session_id: string }[]).map((r) => r.session_id);
  return costBetween(db, tabs, t.started_at ?? t.created_at, t.closed_at ?? "9999", prices);
}
