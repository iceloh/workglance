// Where workglance keeps its data. Tiny on purpose: hooks import this without loading SQLite.
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const WORKGLANCE_HOME = process.env.WORKGLANCE_HOME ?? defaultHome();
export function defaultHome(): string {
  return join(homedir(), ".workglance");
}
export const DB_FILE = "workglance.db";
const MCP_PREFIX = "mcp__workglance__";
/** A Workglance tool call ("mcp__workglance__create_task") -> its tool name; anything else -> null. */
export const mcpTool = (name: string): string | null => (name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : null);
export const CLAUDE_PROJECTS = process.env.WORKGLANCE_CLAUDE_PROJECTS
  ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");

/** Where `workglance eval` builds its throwaway scenario repos (ignored by the board, removed after each run). */
export const EVAL_RUNS = join(WORKGLANCE_HOME, "eval-runs");

/**
 * Another entry point of this same copy of workglance: `cli`, `hook` or `refresh-worker`. From source that is
 * src/<name>.ts; from the published build every module is bundled into its entry file, so import.meta.url
 * is dist/<entry>.js and its siblings are the other entry points.
 */
const EXT = extname(fileURLToPath(import.meta.url));
export const appFile = (name: "cli" | "hook" | "refresh-worker") => fileURLToPath(new URL(`./${name}${EXT}`, import.meta.url));
/** True when running the published build (not the source tree). */
export const IS_BUILD = EXT === ".js";
