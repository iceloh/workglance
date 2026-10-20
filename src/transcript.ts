// Turns one Claude Code transcript record (one JSONL line) into the facts Workglance keeps.
// Pure: no I/O. The transcript format is not a documented contract, so every field read here is
// optional and a record we don't understand produces no facts instead of an error.
import { mcpTool } from "./paths.ts";

export type Fact =
  | { kind: "title"; at: string; title: string }
  | { kind: "prompt"; at: string; uuid: string; text: string; cwd: string | null; branch: string | null }
  | { kind: "git"; at: string; id: string; action: GitAction; dir: string; command: string }
  | { kind: "loc"; at: string; cwd: string; branch: string | null; entrypoint: string | null }
  | { kind: "edit"; at: string; id: string; dir: string }
  | { kind: "wtcall"; at: string; id: string; tool: string; input: Record<string, unknown>; cwd: string | null }
  | { kind: "wtfail"; id: string }
  | { kind: "usage"; at: string; id: string; model: string; input: number; output: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number };

/** A workglance call that never reached the server (down, restarting): safe to replay. Validation errors are not. */
export const CONNECTION_FAILURE = /not connected|ECONNREFUSED|fetch failed|Unable to connect|socket hang up|ECONNRESET/i;

export type GitAction = "commit" | "push" | "merge" | "rebase" | "cherry-pick";

/**
 * Bump when the parser learns new facts: files read by an older version are read again once.
 * v2 timed edits · v3 workglance calls and failures · v4 token usage per response.
 */
export const PARSER_VERSION = 4;

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const PROMPT_MAX = 4000;
const COMMAND_MAX = 1000;

type Rec = Record<string, any>;

export function parseRecord(r: Rec): Fact[] {
  const facts: Fact[] = [];
  const at = typeof r.timestamp === "string" ? r.timestamp : null;
  const cwd = typeof r.cwd === "string" ? r.cwd : null;
  const branch = typeof r.gitBranch === "string" && r.gitBranch ? r.gitBranch : null;

  if (r.type === "custom-title" && typeof r.customTitle === "string" && r.customTitle.trim()) {
    // Title records carry no timestamp; the caller stamps them with the last time it saw.
    facts.push({ kind: "title", at: at ?? "", title: r.customTitle.trim() });
    return facts;
  }
  const content = r.message?.content;
  // Failures need no timestamp: they only mark the call they answer.
  if (r.type === "user" && Array.isArray(content)) {
    for (const b of content) {
      if (b?.type !== "tool_result" || !b.is_error || typeof b.tool_use_id !== "string") continue;
      const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
      if (CONNECTION_FAILURE.test(text)) facts.push({ kind: "wtfail", id: b.tool_use_id });
    }
  }
  if (!at) return facts;
  if (cwd) facts.push({ kind: "loc", at, cwd, branch, entrypoint: typeof r.entrypoint === "string" ? r.entrypoint : null });

  if (r.type === "user" && !r.isMeta && !r.isCompactSummary && !r.isSidechain) {
    const text = promptText(content);
    if (text && typeof r.uuid === "string") facts.push({ kind: "prompt", at, uuid: r.uuid, text: text.slice(0, PROMPT_MAX), cwd, branch });
  }
  // Token usage. A response is split into one record per content block, each repeating the same usage:
  // the message id is the key, and the store keeps it once.
  const u = r.message?.usage;
  if (r.type === "assistant" && u && typeof r.message?.id === "string" && typeof r.message?.model === "string") {
    const cc = u.cache_creation ?? {};
    const w1h = Number(cc.ephemeral_1h_input_tokens ?? 0);
    const w5m = cc.ephemeral_5m_input_tokens !== undefined ? Number(cc.ephemeral_5m_input_tokens) : Number(u.cache_creation_input_tokens ?? 0) - w1h;
    facts.push({ kind: "usage", at, id: r.message.id, model: r.message.model, input: Number(u.input_tokens ?? 0), output: Number(u.output_tokens ?? 0),
      cacheWrite5m: Math.max(0, w5m), cacheWrite1h: w1h, cacheRead: Number(u.cache_read_input_tokens ?? 0) });
  }
  if (r.type === "assistant" && Array.isArray(content)) {
    for (const b of content) {
      if (b?.type !== "tool_use") continue;
      const tool = typeof b.name === "string" ? mcpTool(b.name) : null;
      if (tool && typeof b.id === "string") {
        facts.push({ kind: "wtcall", at, id: b.id, tool, input: b.input ?? {}, cwd });
        continue;
      }
      // Editing a file is working in its folder, even when the tab's own folder is elsewhere.
      const file = EDIT_TOOLS.has(b.name) ? (b.input?.file_path ?? b.input?.notebook_path) : null;
      if (typeof file === "string" && file) {
        const dir = resolveDir(cwd ?? "", file).replace(/[\\/][^\\/]*$/, "");
        if (dir) {
          facts.push({ kind: "loc", at, cwd: dir, branch: null, entrypoint: null });
          // Timed, one per edit: where a task's work really happened (Phase 3 place inference).
          if (typeof b.id === "string") facts.push({ kind: "edit", at, id: b.id, dir });
        }
        continue;
      }
      if (b.name !== "Bash" && b.name !== "PowerShell") continue;
      const command = typeof b.input?.command === "string" ? b.input.command : "";
      for (const g of gitActions(command, cwd ?? "")) {
        facts.push({ kind: "git", at, id: `${b.id}:${g.action}:${g.dir}`, action: g.action, dir: g.dir, command: command.slice(0, COMMAND_MAX) });
      }
    }
  }
  return facts;
}

/** What the person typed. Tool results, slash-command echoes, system reminders and interruptions are not prompts. */
export function promptText(content: unknown): string | null {
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    if (content.some((b) => b?.type === "tool_result")) return null;
    text = content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
  }
  text = text.trim();
  if (!text) return null;
  if (text.startsWith("<") || text.startsWith("[Request interrupted") || text.startsWith("Caveat:")) return null;
  return text;
}

/**
 * The git actions a shell command performs, and the directory each runs in. Follows `cd X &&` and
 * `git -C X`. Heredoc bodies and quoted strings are ignored when looking for actions, so a commit
 * message that mentions "git push" is not a push.
 */
export function gitActions(command: string, cwd: string): { action: GitAction; dir: string }[] {
  const out: { action: GitAction; dir: string }[] = [];
  let dir = cwd;
  const withoutHeredocs = command.replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\b/g, "<<heredoc");
  for (const seg of withoutHeredocs.split(/&&|\|\||;|\n/)) {
    const s = seg.trim();
    const cd = s.match(/^(?:cd|Set-Location|pushd)\s+(?:-LiteralPath\s+|-Path\s+)?("([^"]+)"|'([^']+)'|(\S+))\s*$/i);
    if (cd) { dir = resolveDir(dir, cd[2] ?? cd[3] ?? cd[4]!); continue; }
    const bare = s.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, '""');
    // git must be the command itself: optionally after VAR=value assignments and wrappers like `timeout 600`.
    const m = bare.match(/^\(?\s*(?:\w+=\S*\s+)*(?:(?:timeout\s+\S+|nohup|time|env|command)\s+)*(?:\w+=\S*\s+)*git((?:\s+(?:-C\s+\S+|-c\s+\S+|--no-pager|--git-dir=\S+))*)\s+(commit|push|merge|rebase|cherry-pick)\b/);
    if (!m) continue;
    const c = s.match(/\bgit\b[^]*?\s-C\s+("([^"]+)"|'([^']+)'|(\S+))/);
    out.push({ action: m[2] as GitAction, dir: c ? resolveDir(dir, c[2] ?? c[3] ?? c[4]!) : dir });
  }
  return out;
}

/** `/c/dev/x` and `C:/dev/x` and relative paths, all to `C:\dev\x` (Windows) — the form git and cwd use. */
export function resolveDir(base: string, p: string): string {
  let q = p.replace(/^~(?=[\\/]|$)/, process.env.USERPROFILE ?? process.env.HOME ?? "~");
  const msys = q.match(/^\/([a-zA-Z])(\/.*)?$/);
  if (msys) q = `${msys[1]!.toUpperCase()}:${msys[2] ?? "/"}`;
  const absolute = /^[a-zA-Z]:[\\/]/.test(q) || q.startsWith("\\\\") || q.startsWith("/");
  const joined = absolute ? q : `${base}/${q}`;
  return normalizeDir(joined);
}

/**
 * A folder as a comparison key: normalized, and case-folded where the file system ignores case
 * (Windows, macOS). On Linux /Code and /code are different folders.
 */
export function pathKey(p: string, platform: string = process.platform): string {
  const n = normalizeDir(p);
  // A drive-letter path is a Windows path, and Windows ignores case wherever the path is being looked at.
  return platform === "linux" && !/^[a-z]:/i.test(n) ? n : n.toLowerCase();
}

/** `child` is `parent` or inside it (never a sibling that shares a prefix, like /a/shop-sdk under /a/shop). */
export function isUnder(child: string, parent: string, platform: string = process.platform): boolean {
  const c = pathKey(child, platform), p = pathKey(parent, platform).replace(/[\\/]+$/, "");
  const sep = /^[a-z]:\\/i.test(p) ? "\\" : "/";
  return c === p || c.startsWith(p + sep);
}

export function normalizeDir(p: string): string {
  const drive = p.match(/^([a-zA-Z]):/);
  const parts: string[] = [];
  for (const seg of p.replace(/^[a-zA-Z]:/, "").split(/[\\/]+/)) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop(); else parts.push(seg);
  }
  return drive ? `${drive[1]!.toUpperCase()}:\\${parts.join("\\")}` : `/${parts.join("/")}`;
}
