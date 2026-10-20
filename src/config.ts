// ~/.workglance/config.json — optional. Missing or broken file = defaults.
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { EVAL_RUNS, WORKGLANCE_HOME } from "./paths.ts";
import { isUnder, pathKey } from "./transcript.ts";
import { parseTimes } from "./daily.ts";

export type Config = {
  enabled: boolean; port: number; ignore: string[];
  /** netrc with Bitbucket API credentials, for pipeline status on cards. Unset = no CI status. */
  bitbucketNetrc: string | null;
  /** $ per million tokens by model, over the built-in table (see cost.ts). */
  prices: Record<string, { input: number; output: number; cacheRead?: number }>;
  /** When the scheduled digest is written (local times, default 08:00); each covers since the previous one. */
  digestTimes: string[];
  /** Have `claude -p` write the digest's summary paragraph right away (uses the user's subscription). */
  digestSummary: boolean;
};

/** Only well-formed entries: a typo in config.json must not turn every cost into NaN. */
export function validPrices(v: unknown): Config["prices"] {
  const out: Config["prices"] = {};
  if (!v || typeof v !== "object") return out;
  for (const [model, p] of Object.entries(v as Record<string, any>)) {
    const n = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0;
    if (p && n(p.input) && n(p.output) && (p.cacheRead === undefined || n(p.cacheRead))) out[model] = { input: p.input, output: p.output, ...(p.cacheRead !== undefined ? { cacheRead: p.cacheRead } : {}) };
  }
  return out;
}

/** "~/x" -> the home folder's x, as people write paths in config files. */
export function expandHome(p: string, home: string = homedir()): string {
  return /^~(?=$|[\/])/.test(p) ? home + p.slice(1) : p;
}

export function loadConfig(): Config {
  let raw: Partial<Config> & { enabled?: boolean; bitbucketNetrc?: string } = {};
  try { raw = JSON.parse(readFileSync(join(WORKGLANCE_HOME, "config.json"), "utf8")); } catch {}
  return {
    // Kill switch for the hooks: false (or WORKGLANCE_DISABLED=1) makes every hook a no-op.
    enabled: process.env.WORKGLANCE_DISABLED !== "1" && raw.enabled !== false,
    port: Number(process.env.WORKGLANCE_PORT ?? raw.port ?? 4477),
    // Folders whose sessions are not shown (throwaway experiments, temp dirs).
    // The temp folder is ignored (throwaway runs) except inside an eval run, whose repos live there.
    ignore: [...(process.env.WORKGLANCE_EVAL === "1" ? [] : [...tempDirs(), EVAL_RUNS]), ...(raw.ignore ?? []).map((p) => expandHome(p))].map((p) => pathKey(p)),
    bitbucketNetrc: raw.bitbucketNetrc ? expandHome(raw.bitbucketNetrc) : null,
    prices: validPrices((raw as { prices?: unknown }).prices),
    digestTimes: parseTimes((raw as { digestTimes?: unknown }).digestTimes),
    digestSummary: (raw as { digestSummary?: unknown }).digestSummary !== false,
  };
}

/** Folders untracked from the screen, as written in config.json (what the user sees and can undo). */
export function untrackedFolders(): string[] {
  try { return (JSON.parse(readFileSync(join(WORKGLANCE_HOME, "config.json"), "utf8")).ignore ?? []) as string[]; } catch { return []; }
}

/**
 * Add/remove a folder in config.json's `ignore`, keeping every other setting. Hooks read the file on every
 * call, so the change applies to running tabs at once.
 */
export function setUntracked(path: string, untracked: boolean): string[] {
  const file = join(WORKGLANCE_HOME, "config.json");
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch {}
  const norm = (p: string) => pathKey(p);
  const list = ((raw.ignore as string[] | undefined) ?? []).filter((p) => norm(p) !== norm(path));
  if (untracked) list.push(path.replace(/\\/g, "/"));
  raw.ignore = list;
  mkdirSync(WORKGLANCE_HOME, { recursive: true });
  writeFileSync(file + ".tmp", JSON.stringify(raw, null, 2) + "\n");
  renameSync(file + ".tmp", file);
  return list;
}

/** Sets keys in config.json, keeping every other setting (same atomic write as setUntracked). */
export function setConfig(patch: Record<string, unknown>): void {
  const file = join(WORKGLANCE_HOME, "config.json");
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch {}
  Object.assign(raw, patch);
  mkdirSync(WORKGLANCE_HOME, { recursive: true });
  writeFileSync(file + ".tmp", JSON.stringify(raw, null, 2) + "\n");
  renameSync(file + ".tmp", file);
}

export function isIgnored(cfg: Config, dir: string | null): boolean {
  if (!dir) return false;
  return cfg.ignore.some((p) => isUnder(dir, p));
}

/**
 * The temp folder by both of its names. On Windows tmpdir() can be the 8.3 short path
 * (C:\Users\JANEDO~1\...) while tools write under the long one (C:\Users\JaneDoe\...):
 * ignoring only one let every eval repo onto the board.
 */
export function tempDirs(): string[] {
  const t = tmpdir();
  let real = t;
  try { real = realpathSync.native(t); } catch {}
  return real === t ? [t] : [t, real];
}
