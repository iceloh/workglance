// Per-tab state kept by the hooks (one small JSON file per session), read by the server too.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultHome } from "./paths.ts";

export type TabState = {
  changed: number;          // edits/commits since the last task operation (nudge)
  nudges: number;
  active?: boolean;         // our SessionStart ran: the tab has the workglance tools
  seenEventId?: number;     // last board change made by the user that this tab was told about
  live?: LiveStatus;        // what the tab is doing right now
  liveAt?: string;
  liveDetail?: string;      // e.g. the question it asked, the tool it wants permission for
  nudgeLog?: string[];      // when the last nudges were sent (ISO), to measure what the agent did next
};

/**
 * working: you sent a prompt, it is on it. question: it asked you something (AskUserQuestion, or ended its
 * turn with a question). permission: it is blocked on a permission prompt. done: its turn ended, your move.
 * closed: the session ended. The first three are "needs you" only when waiting; "working" never is.
 */
export type LiveStatus = "working" | "question" | "permission" | "done" | "closed";
export const NEEDS_YOU: readonly LiveStatus[] = ["question", "permission"];

/** Pure: the status a turn ends in. A last message that asks something is a question, not just "done". */
export function endOfTurnStatus(lastMessage: string): LiveStatus {
  // Hidden Markdown reference definitions (`[id]: # "..."`) at the end are not what the user reads.
  const tail = lastMessage.trim().split(/\n/).filter((l) => l.trim() && !/^\s*\[[^\]]+\]:\s/.test(l)).slice(-3).join(" ");
  return /\?\s*(\*\*)?\s*$/.test(tail) || /\?\s*["”')\]]?\s*$/.test(tail) ? "question" : "done";
}

// Resolved on every call, not at import: a test can point WORKGLANCE_HOME elsewhere and never touch real state.
const dir = () => join(process.env.WORKGLANCE_HOME ?? defaultHome(), "state");
const file = (sid: string) => join(dir(), `${sid.replace(/[^\w-]/g, "")}.json`);

export function loadState(sid: string): TabState {
  try { return { changed: 0, nudges: 0, ...JSON.parse(readFileSync(file(sid), "utf8")) }; } catch { return { changed: 0, nudges: 0 }; }
}

export function saveState(sid: string, s: TabState): void {
  try { mkdirSync(dir(), { recursive: true }); writeFileSync(file(sid), JSON.stringify(s)); } catch {}
}

export function allStates(): Map<string, TabState> {
  const out = new Map<string, TabState>();
  let names: string[] = [];
  try { names = readdirSync(dir()); } catch {}
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try { out.set(n.slice(0, -5), { changed: 0, nudges: 0, ...JSON.parse(readFileSync(join(dir(), n), "utf8")) }); } catch {}
  }
  return out;
}
