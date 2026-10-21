// Everything Workglance asks git. Each call is a short-lived `git` process; nothing stays running.
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { normalizeDir } from "./transcript.ts";

export function git(dir: string, args: string[], input?: string): string | null {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", input, stdio: ["pipe", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  } catch {
    return null;
  }
}

/**
 * `git fetch origin` in the background (it can take seconds): only when the user asks for a fresh look
 * ("Check cards"), so a merge someone else made shows up. Never prompts for credentials; gives up after 30 s.
 */
export function fetchOrigin(repo: string, timeoutMs = 30_000): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("git", ["-C", repo, "fetch", "--quiet", "origin"], { timeout: timeoutMs, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (err) => resolve(!err));
  });
}

/** Folder -> its worktree root and the repo it belongs to (the shared .git dir), or null outside git. */
export function resolveRepo(dir: string): { worktree: string; repo: string } | null {
  if (!existsSync(dir)) return null;
  const out = git(dir, ["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir"]);
  if (!out) return null;
  const [top, common] = out.trim().split(/\r?\n/);
  if (!top || !common) return null;
  return { worktree: normalizeDir(top), repo: normalizeDir(common).replace(/[\\/]\.git$/i, "") };
}

export function currentBranch(dir: string): string | null {
  const b = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim();
  return b && b !== "HEAD" ? b : null;
}

export function worktreeList(repo: string): { path: string; branch: string | null; head: string | null }[] {
  const out = git(repo, ["worktree", "list", "--porcelain"]);
  if (!out) return [];
  const list: { path: string; branch: string | null; head: string | null }[] = [];
  for (const block of out.split(/\r?\n\r?\n/)) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    if (!path) continue;
    list.push({ path: normalizeDir(path), branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null, head: block.match(/^HEAD (\w+)$/m)?.[1] ?? null });
  }
  return list;
}

/** Uncommitted files and commits not pushed, from `git status -b`. */
export function worktreeState(path: string): { dirty: number; ahead: number; upstream: string | null } | null {
  const out = git(path, ["status", "--porcelain=v1", "-b"]);
  if (out === null) return null;
  const [head = "", ...files] = out.split(/\r?\n/).filter(Boolean);
  return {
    dirty: files.length,
    ahead: Number(head.match(/\[ahead (\d+)/)?.[1] ?? 0),
    upstream: head.match(/^## [^.]+\.\.\.(\S+)/)?.[1] ?? null,
  };
}

/** Where "testing" and "done" live: origin/dev (if any) and origin/main|master (or the local ones). */
export function stageRefs(repo: string): { main: string | null; dev: string | null } {
  const has = (ref: string) => git(repo, ["rev-parse", "--verify", "--quiet", ref]) !== null;
  const main = ["origin/main", "origin/master", "main", "master"].find(has) ?? null;
  const dev = ["origin/dev", "origin/develop"].find(has) ?? null;
  return { main, dev };
}

export function userEmail(repo: string): string | null {
  return git(repo, ["config", "user.email"])?.trim() || null;
}

export type GitCommit = { sha: string; authorAt: number; subject: string };

/** My commits since `sinceSec`, on every ref AND in the reflog: a rebase rewrites the sha, the original stays findable. */
export function myCommits(repo: string, email: string, sinceSec: number): GitCommit[] {
  const out = git(repo, ["log", "--all", "--reflog", `--since=${sinceSec}`, `--author=${email}`, "--format=%H%x1f%at%x1f%s"]);
  if (!out) return [];
  const seen = new Set<string>();
  const list: GitCommit[] = [];
  for (const l of out.split(/\r?\n/)) {
    const [sha, at, subject] = l.split("\x1f");
    if (!sha || !at || seen.has(sha)) continue;
    seen.add(sha);
    list.push({ sha, authorAt: Number(at), subject: subject ?? "" });
  }
  return list;
}

/** shas and subjects reachable from `ref`, limited to a time window (cheap enough to run on every refresh). */
export function refCommits(repo: string, ref: string, sinceSec: number): { shas: Set<string>; bySubject: Map<string, string[]> } {
  const out = git(repo, ["log", ref, `--since=${sinceSec}`, "--format=%H%x1f%s"]) ?? "";
  const shas = new Set<string>();
  const bySubject = new Map<string, string[]>();
  for (const l of out.split(/\r?\n/)) {
    const [sha, subject] = l.split("\x1f");
    if (!sha) continue;
    shas.add(sha);
    const k = subject ?? "";
    bySubject.set(k, [...(bySubject.get(k) ?? []), sha]);
  }
  return { shas, bySubject };
}

/** Same change, different sha (rebase, cherry-pick): compare `git patch-id`. */
export function patchId(repo: string, sha: string): string | null {
  const diff = git(repo, ["show", "--format=", sha]);
  if (!diff) return null;
  return git(repo, ["patch-id", "--stable"], diff)?.trim().split(/\s+/)[0] ?? null;
}
