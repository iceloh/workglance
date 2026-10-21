// `workglance install` / `workglance uninstall`: adds (or removes) ONLY workglance's own entries in
// ~/.claude/settings.json, next to whatever hooks are already there, and registers the MCP server
// for every project (user scope). A backup of settings.json is written before any change.
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { appFile, IS_BUILD } from "./paths.ts";
import { WORKGLANCE_HOME } from "./db.ts";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";

const SETTINGS = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json");
/**
 * Where the hooks run from. From the published build: a copy in ~/.workglance/app, made by install, so the
 * hooks never point into npm's or npx's cache (which gets cleaned). From a source checkout: the source.
 */
const APP = join(WORKGLANCE_HOME, "app");
export const HOOK = (IS_BUILD ? join(APP, "hook.js") : appFile("hook")).replace(/\\/g, "/");

type HookEntry = { matcher?: string; hooks: { type: string; command: string; args?: string[]; timeout?: number; async?: boolean }[] };
type Settings = { hooks?: Record<string, HookEntry[]>; [k: string]: unknown };

const cmd = (hookPath: string, event: string, extra: { timeout?: number; async?: boolean } = {}) =>
  ({ type: "command", command: "node", args: ["--no-warnings", hookPath, event], ...extra });

/** Pure: our hook entries, merged into whatever hooks exist. Running it twice changes nothing. */
export function withWorkglanceHooks(s: Settings, hookPath = HOOK): Settings {
  const clean = withoutWorkglanceHooks(s, hookPath);
  const hooks = { ...(clean.hooks ?? {}) };
  const add = (event: string, entry: HookEntry) => { hooks[event] = [...(hooks[event] ?? []), entry]; };
  add("SessionStart", { hooks: [cmd(hookPath, "SessionStart", { timeout: 10 })] });
  add("UserPromptSubmit", { hooks: [cmd(hookPath, "UserPromptSubmit", { timeout: 5 })] });
  // Sync only where the hook must answer (stamp workglance calls); AskUserQuestion just records "it asked you".
  add("PreToolUse", { matcher: "mcp__workglance__.*|AskUserQuestion", hooks: [cmd(hookPath, "PreToolUse", { timeout: 5 })] });
  // Tools that edit, commit, ask or need permission: their completion also means "it is working again".
  add("PostToolUse", { matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell|AskUserQuestion|WebFetch|WebSearch|mcp__.*", hooks: [cmd(hookPath, "PostToolUse", { timeout: 5, async: true })] });
  add("Stop", { hooks: [cmd(hookPath, "Stop", { timeout: 5 })] });
  // Live status only: never answer, never wait.
  add("PermissionRequest", { matcher: "", hooks: [cmd(hookPath, "PermissionRequest", { timeout: 5, async: true })] });
  add("Notification", { matcher: "", hooks: [cmd(hookPath, "Notification", { timeout: 5, async: true })] });
  add("SessionEnd", { matcher: "", hooks: [cmd(hookPath, "SessionEnd", { timeout: 5, async: true })] });
  return { ...clean, hooks };
}

/** Pure: every hook entry pointing at our hook script removed; other tools' hooks untouched. */
export function withoutWorkglanceHooks(s: Settings, hookPath = HOOK): Settings {
  if (!s.hooks) return s;
  // Ours: this hook path, or a workglance hook script from an earlier install (a source checkout, an older copy).
  const isOurs = (p: string) => { const n = p.replace(/\\/g, "/"); return n === hookPath || /workglance[^/]*\/(?:.*\/)?hook\.(?:ts|js)$/i.test(n); };
  const ours = (h: HookEntry["hooks"][number]) => (h.args ?? []).some(isOurs) || h.command.replace(/\\/g, "/").includes(hookPath);
  const hooks: Record<string, HookEntry[]> = {};
  for (const [event, entries] of Object.entries(s.hooks)) {
    const kept = entries.map((e) => ({ ...e, hooks: e.hooks.filter((h) => !ours(h)) })).filter((e) => e.hooks.length);
    if (kept.length) hooks[event] = kept;
  }
  return { ...s, hooks };
}

function rewrite(change: (s: Settings) => Settings): string {
  const original = readFileSync(SETTINGS, "utf8");
  const backup = `${SETTINGS}.workglance-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(SETTINGS, backup);
  const next = JSON.stringify(change(JSON.parse(original)), null, 2) + "\n";
  const tmp = `${SETTINGS}.workglance-tmp`;
  writeFileSync(tmp, next);
  renameSync(tmp, SETTINGS);
  return backup;
}

function claude(args: string[]): string {
  // One command string (fixed words and our own URL, nothing typed by anyone): `claude` is a .cmd on Windows.
  const line = ["claude", ...args].map((a) => (/^[\w:/.@=-]+$/.test(a) ? a : `"${a.replace(/"/g, "")}"`)).join(" ");
  try { return execSync(line, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 60_000 }); } catch (e: any) { return String(e?.stderr ?? e?.message ?? e); }
}

/** Where this copy of workglance lives, for the VS Code extension (it starts the server from here). */
export function writeInstallInfo(): void {
  const cli = IS_BUILD ? join(APP, "cli.js") : appFile("cli");
  mkdirSync(WORKGLANCE_HOME, { recursive: true });
  writeFileSync(join(WORKGLANCE_HOME, "install.json"), JSON.stringify({ cli, node: process.execPath, port: loadConfig().port }, null, 2));
}

/** The published build copies its three entry points (self-contained bundles) next to the data. */
function copyApp(): void {
  if (!IS_BUILD) return;
  mkdirSync(APP, { recursive: true });
  for (const name of ["cli", "hook", "refresh-worker"] as const) {
    const tmp = join(APP, `${name}.js.tmp`);
    copyFileSync(appFile(name), tmp);
    renameSync(tmp, join(APP, `${name}.js`));
  }
  console.log(`app copied to ${APP}`);
}

export function install(): void {
  copyApp();
  const backup = rewrite((s) => withWorkglanceHooks(s));
  console.log(`hooks added to ${SETTINGS}\nbackup: ${backup}`);
  writeInstallInfo();
  const url = `http://127.0.0.1:${loadConfig().port}/mcp`;
  claude(["mcp", "remove", "--scope", "user", "workglance"]);
  console.log(claude(["mcp", "add", "--transport", "http", "--scope", "user", "workglance", url]).trim());
  console.log("Open tabs pick up the tools after a restart (or /mcp). Turn everything off with \"enabled\": false in ~/.workglance/config.json.");
}

export function uninstall(): void {
  const backup = rewrite((s) => withoutWorkglanceHooks(s));
  console.log(`hooks removed from ${SETTINGS}\nbackup: ${backup}`);
  console.log(claude(["mcp", "remove", "--scope", "user", "workglance"]).trim());
}
