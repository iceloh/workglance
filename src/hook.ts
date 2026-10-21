// `node src/hook.ts <Event>` — registered in ~/.claude/settings.json by `workglance install`.
// Rules: never throw, never print anything but the hook's JSON answer, finish fast, and do nothing
// when workglance is disabled or the session works in an ignored folder.
import { existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { connect } from "node:net";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { appFile, DB_FILE, mcpTool, WORKGLANCE_HOME } from "./paths.ts";
import { isIgnored, loadConfig, tempDirs } from "./config.ts";
import { gitActions, isUnder } from "./transcript.ts";
import { snapshotText, userChanges, userChangesText, type Task, type UserChange } from "./tasks.ts";
import { endOfTurnStatus, loadState, saveState, type LiveStatus } from "./state.ts";
import { closeNudge, NUDGE, protocolFor } from "./protocol.ts";

const MAX_NUDGES_PER_SESSION = 8;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

type Payload = Record<string, any>;

const event = process.argv[2] ?? "";
// Synchronous on purpose: on Windows, stdout to a pipe is async and process.exit() can drop it.
const out = (o: unknown) => writeSync(1, JSON.stringify(o));

function readStdin(): Payload {
  try { return JSON.parse(readFileSync(0, "utf8")); } catch { return {}; }
}

/**
 * Read-only look at the board: this tab's open tasks and the user's changes it was not told yet.
 * SQLite is loaded here, on demand: most hook calls (after an edit, a permission prompt) never need it.
 */
async function readBoard(sid: string, seenEventId: number): Promise<{ tasks: Task[]; changes: UserChange[] }> {
  const file = join(WORKGLANCE_HOME, DB_FILE);
  if (!existsSync(file)) return { tasks: [], changes: [] };
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tasks = db.prepare(`SELECT t.* FROM tasks t JOIN task_sessions s ON s.task_id = t.id
      WHERE s.session_id = ? AND t.status IN ('planned','in_progress','testing') ORDER BY s.last_at DESC`).all(sid) as Task[];
    return { tasks, changes: userChanges(db, sid, seenEventId) };
  } catch { return { tasks: [], changes: [] }; } finally { db.close(); }
}

/** Investigations still in progress that this tab's agent created or took since `since`. */
async function openedThisTurn(sid: string, since: string): Promise<number[]> {
  const file = join(WORKGLANCE_HOME, DB_FILE);
  if (!existsSync(file)) return [];
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare(`SELECT t.id FROM tasks t WHERE t.type = 'investigation' AND t.status = 'in_progress' AND EXISTS (
      SELECT 1 FROM task_events e WHERE e.task_id = t.id AND e.session_id = ? AND e.actor = 'agent' AND e.at >= ?
        AND (e.kind IN ('created','taken') OR (e.kind = 'status' AND e.to_status = 'in_progress'))) ORDER BY t.id`).all(sid, since) as { id: number }[]).map((r) => r.id);
  } catch { return []; } finally { db.close(); }
}

/** Snapshot + the user's board changes, marking the changes as delivered. */
async function contextFor(sid: string): Promise<string | null> {
  const st = loadState(sid);
  const { tasks, changes } = await readBoard(sid, st.seenEventId ?? 0);
  if (changes.length) saveState(sid, { ...st, seenEventId: Math.max(...changes.map((c) => c.eventId)) });
  return [userChangesText(changes), snapshotText(tasks)].filter(Boolean).join("\n\n") || null;
}

/**
 * Edits that are not work: the tab's scratchpad and any temp folder (debug scripts), Claude's own
 * files (~/.claude: memory, settings) and ignored folders. Measured on real history: 1,078 scratch
 * edits and 133 memory edits, and the first real nudge (PROFILE PAGE) fired on scratchpad scripts only.
 */
export function isScratch(file: string, p: Payload, cfg: ReturnType<typeof loadConfig>): boolean {
  if (!file) return true;
  const scratch = String(p.scratchpad_dir ?? "");
  return (scratch !== "" && isUnder(file, scratch))
    // Any temp folder is scratch, except in an eval run: its throwaway repos live in temp, and treating them
    // as scratch silently disabled the nudge there (two "agent forgot the card" failures were this).
    || (process.env.WORKGLANCE_EVAL !== "1" && (tempDirs().some((t) => isUnder(file, t)) || /[\\/]appdata[\\/]local[\\/]temp[\\/]/i.test(file)))
    // Claude's own files (memory, settings): ~/.claude, or wherever CLAUDE_CONFIG_DIR puts them.
    || [join(homedir(), ".claude"), process.env.CLAUDE_CONFIG_DIR].some((d) => !!d && isUnder(file, d))
    || isIgnored(cfg, file);
}

function setLive(sid: string, live: LiveStatus, detail?: string): void {
  saveState(sid, { ...loadState(sid), live, liveAt: new Date().toISOString(), liveDetail: detail });
}

function lastLine(text: string): string {
  return text.trim().split(/\n/).filter((l) => l.trim() && !/^\s*\[[^\]]+\]:\s/.test(l)).at(-1)?.trim().slice(0, 200) ?? "";
}

/** Start the board/MCP server if nothing listens on its port (first session of the day, after a reboot). */
async function ensureServer(port: number): Promise<void> {
  const up = await new Promise<boolean>((resolve) => {
    const s = connect({ port, host: "127.0.0.1" });
    s.setTimeout(300);
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
    s.once("timeout", () => { s.destroy(); resolve(false); });
  });
  if (up || process.env.WORKGLANCE_NO_AUTOSTART === "1") return;
  mkdirSync(WORKGLANCE_HOME, { recursive: true });
  const log = openSync(join(WORKGLANCE_HOME, "server.log"), "a");
  const cli = appFile("cli");
  spawn(process.execPath, ["--no-warnings", cli, "serve"], { detached: true, stdio: ["ignore", log, log], windowsHide: true }).unref();
}

async function main() {
  const p = readStdin();
  const cfg = loadConfig();
  const sid: string | undefined = p.session_id;
  if (!cfg.enabled || !sid || isIgnored(cfg, p.cwd ?? null)) return;

  if (event !== "SessionStart" && !loadState(sid).active) return;

  if (event === "SessionStart") {
    const st = loadState(sid);
    st.active = true;
    if (p.cwd) st.cwd = String(p.cwd);
    saveState(sid, st);
    setLive(sid, "done"); // a fresh or resumed tab is waiting for your first message
    await ensureServer(cfg.port);
    const ctx = await contextFor(sid);
    const protocol = protocolFor(cfg.columnRules);
    out({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ctx ? `${protocol}\n\n${ctx}` : protocol } });
  } else if (event === "UserPromptSubmit") {
    const at = new Date().toISOString();
    saveState(sid, { ...loadState(sid), live: "working", liveAt: at, liveDetail: undefined, turnAt: at });
    const ctx = await contextFor(sid);
    if (ctx) out({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: ctx } });
  } else if (event === "PermissionRequest" || (event === "Notification" && /permission/i.test(String(p.message ?? "")))) {
    setLive(sid, "permission", String(p.tool_name ?? p.message ?? "").slice(0, 200));
  } else if (event === "SessionEnd") {
    setLive(sid, "closed");
  } else if (event === "PreToolUse" && p.tool_name === "AskUserQuestion") {
    const q = p.tool_input?.questions?.[0]?.question ?? p.tool_input?.question ?? "";
    setLive(sid, "question", String(q).slice(0, 200));
  } else if (event === "PreToolUse" && mcpTool(String(p.tool_name ?? "")) !== null) {
    // The identity of the call comes from the session, never from what the agent typed.
    const s = loadState(sid);
    s.changed = 0;
    if (["create_task", "take_task", "update_task"].includes(mcpTool(String(p.tool_name)) ?? "")) s.cardCallAt = new Date().toISOString();
    saveState(sid, s);
    out({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow",
      // call_id lets the server recognize this call later: a call that failed (server down) is replayed
      // from the transcript exactly once, and a call that went through is never replayed.
      updatedInput: { ...(p.tool_input ?? {}), _workglance: { session_id: sid, cwd: p.cwd, call_id: p.tool_use_id } } } });
  } else if (event === "PostToolUse") {
    const tool = String(p.tool_name ?? "");
    // A tool finished: whatever it was waiting on (an answer, a permission) has been given.
    const live = loadState(sid).live;
    if (live === "question" || live === "permission") setLive(sid, "working");
    const command = String(p.tool_input?.command ?? "");
    const file = String(p.tool_input?.file_path ?? p.tool_input?.notebook_path ?? "");
    const changed = (EDIT_TOOLS.has(tool) && !isScratch(file, p, cfg))
      || ((tool === "Bash" || tool === "PowerShell") && gitActions(command, p.cwd ?? "").some((g) => g.action === "commit"));
    if (changed) {
      const s = loadState(sid);
      s.changed++;
      saveState(sid, s);
    }
  } else if (event === "Stop") {
    const last = String(p.last_assistant_message ?? "");
    const end = endOfTurnStatus(last);
    setLive(sid, end, end === "question" ? lastLine(last) : undefined);
    if (p.stop_hook_active) return;
    const s = loadState(sid);
    const nudge = (reason: string, extra: Partial<typeof s> = {}) => {
      const now = new Date().toISOString();
      saveState(sid, { ...s, ...extra, nudges: s.nudges + 1, changed: 0, live: "working", liveAt: now, liveDetail: undefined });
      out({ decision: "block", reason });
    };
    if (s.changed) {
      // Work done while a task is in progress belongs to it: nothing to ask.
      if ((await readBoard(sid, Number.MAX_SAFE_INTEGER)).tasks.some((t) => t.status === "in_progress")) { s.changed = 0; saveState(sid, s); }
      else {
        if (s.nudges < MAX_NUDGES_PER_SESSION) nudge(NUDGE, { nudgeLog: [...(s.nudgeLog ?? []), new Date().toISOString()].slice(-20) });
        return;
      }
    }
    // An investigation this agent opened in this turn, answered in the chat and left in progress: its findings
    // never reach the board (the eval's investigation_with_findings failures were this). Only the turn that
    // opened it: a later note, or the user moving or commenting on it, is no reason to ask for its closing.
    // No turnAt: the turn began before this hook knew about turns, so which cards it opened is unknown.
    // No card call in this turn (most turns): nothing to look up.
    if (end === "question" || s.nudges >= MAX_NUDGES_PER_SESSION || !s.turnAt || !s.cardCallAt || s.cardCallAt < s.turnAt) return;
    const id = (await openedThisTurn(sid, s.turnAt)).find((i) => !(s.closeNudged ?? []).includes(i));
    if (id !== undefined) nudge(closeNudge(id), { closeNudged: [...(s.closeNudged ?? []), id].slice(-50) });
  }
}

// Errors never reach the tab. WORKGLANCE_DEBUG=1 prints them to stderr when debugging the hook by hand.
main().catch((e) => { if (process.env.WORKGLANCE_DEBUG === "1") console.error(e); }).finally(() => process.exit(0));
