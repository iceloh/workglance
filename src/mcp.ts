// The agent's tools, served over MCP/HTTP by the same process as the board (one process for all tabs).
// Thin: argument schemas here, behavior in tools.ts (shared with the replay of failed calls).
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Db } from "./db.ts";
import { STATUSES, TaskError, TYPES, type Stamp } from "./tasks.ts";
import { runTool, type ToolName } from "./tools.ts";
import { searchHistory } from "./history.ts";
import { repoCosts } from "./cost.ts";

// Filled by the PreToolUse hook from the session itself. The agent is told to leave it empty.
const stampArg = z.object({ session_id: z.string(), cwd: z.string(), call_id: z.string() }).partial().optional()
  .describe("Filled automatically by workglance. Leave empty.");

const reply = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o) }] });
const fail = (msg: string) => ({ isError: true, content: [{ type: "text" as const, text: msg }] });
const NO_STAMP = "Workglance is not active in this session (no hook stamp). Continue your work without task tracking.";

function handler(db: Db, tool: ToolName) {
  return async (a: Record<string, any>) => {
    const w = a._workglance as { session_id?: string; cwd?: string; call_id?: string } | undefined;
    if (!w?.session_id || !w.cwd) return fail(NO_STAMP);
    const stamp: Stamp = { session_id: w.session_id, cwd: w.cwd };
    const { _workglance, ...args } = a;
    try { return reply(runTool(db, tool, args, stamp, w.call_id ?? null)); } catch (e) {
      if (e instanceof TaskError) return fail(e.message);
      throw e;
    }
  };
}

const COMMITS = z.array(z.string().regex(/^[0-9a-fA-F]{7,40}$/)).max(20).optional()
  .describe("SHAs of commits that belong to this task when timing can't tell: you committed before creating the card, or under another card");

function build(db: Db): McpServer {
  const s = new McpServer({ name: "workglance", version: "0.9.2" });
  s.tool("create_task", "Register a MAIN piece of work (feature, notable fix, important bug, agreed work, an investigation that produces findings). Not for questions or small edits.",
    {
      title: z.string().min(3).max(200).describe("Imperative, in the language of the conversation"),
      type: z.enum(TYPES),
      description: z.string().max(4000).optional(),
      start_now: z.boolean().default(true).describe("false = agreed or planned, not started now"),
      parent_id: z.number().int().optional().describe("For large separable work found inside another task"),
      commits: COMMITS,
      _workglance: stampArg,
    }, handler(db, "create_task"));
  s.tool("update_task", "On the user's workglance board (cards W-1, W-2, …): move a task (status needs a note), rename it, fix its type, or record its result.",
    {
      id: z.number().int(),
      status: z.enum(STATUSES).optional(),
      note: z.string().max(2000).optional().describe("Required when the status changes: what was done or why"),
      result: z.string().max(4000).optional().describe("When done: what changed, where, how it was verified, what is left. For an investigation: the findings (required to close it as done)."),
      title: z.string().min(3).max(200).optional(),
      type: z.enum(TYPES).optional(),
      commits: COMMITS,
      _workglance: stampArg,
    }, handler(db, "update_task"));
  s.tool("take_task", "Start working on an existing open task (for example one planned earlier or by another tab).",
    { id: z.number().int(), _workglance: stampArg }, handler(db, "take_task"));
  s.tool("search_history", "Search what every tab on this machine already did: cards with their results and findings, notes, commits (and whether they reached dev/main), and the user's prompts. Use it before starting work that may have been done or investigated before, or when the user refers to past work.",
    {
      query: z.string().min(2).max(200).describe("Words to look for, any language; accents don't matter"),
      limit: z.number().int().min(1).max(20).default(8).describe("How many cards (and prompts) at most"),
      _workglance: stampArg,
    }, async (a: Record<string, any>) => {
      const w = a._workglance as { session_id?: string } | undefined;
      return reply(searchHistory(db, String(a.query), Number(a.limit ?? 8), w?.session_id ?? null));
    });
  s.tool("cost_by_repo", "Estimated AI cost per repo over the last days, from this machine's Claude Code usage at API list prices (on a subscription it is a measure of model work, not the bill).",
    {
      days: z.number().int().min(1).max(365).default(30).describe("How many days back from now"),
      _workglance: stampArg,
    }, async (a: Record<string, any>) => reply(repoCosts(db, Number(a.days ?? 30), Date.now())));
  s.tool("list_tasks", "The user's workglance board (the cards, W-1, W-2, …): open tasks of this tab, and open tasks in this worktree that you could take. With all=true: the open tasks of every repo, grouped by repo, with the folder of each (which projects are active, work to do in another repo).",
    {
      all: z.boolean().default(false).describe("true = every repo on this machine, not just this tab and worktree"),
      _workglance: stampArg,
    }, handler(db, "list_tasks"));
  return s;
}

/** Stateless MCP: a fresh server per request, nothing kept between calls. */
export async function handleMcp(db: Db, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body = "";
  for await (const c of req) body += c;
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = build(db);
  res.on("close", () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
}
