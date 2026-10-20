// CI status on cards: which pipeline covered a task's commit on dev / main, and how it went.
// Bitbucket Pipelines and GitHub Actions, picked by the repo's origin remote; the rule is the same for both.
// A pipeline runs once per push on the tip: a commit pushed with others is covered by the FIRST
// pipeline whose commit contains it, not by a pipeline of its own.
import { readFileSync } from "node:fs";
import type { Db } from "./db.ts";
import { spawnSync } from "node:child_process";
import { git } from "./git.ts";

export type Pipeline = { uuid: string; number: number; commit: string; branch: string; state: "running" | "passed" | "failed" | "stopped"; createdAt: string; url: string };

/** `git@bitbucket.org:ws/repo.git` or `https://...bitbucket.org/ws/repo` -> { ws, repo }. */
export function bitbucketSlug(remote: string): { ws: string; repo: string } | null {
  const m = remote.trim().match(/bitbucket\.org[:/]([^/]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return m ? { ws: m[1]!, repo: m[2]! } : null;
}

/** `git@github.com:owner/repo.git` or `https://github.com/owner/repo` -> { owner, repo }. */
export function githubSlug(remote: string): { owner: string; repo: string } | null {
  const m = remote.trim().match(/github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

/**
 * Pure: GitHub Actions runs -> one pipeline per pushed commit. A push can start several workflows: the
 * commit passed only when every one of them succeeded, failed when any failed, and runs while any runs.
 */
export function toGithubPipelines(runs: any[], branch: string): Pipeline[] {
  const bySha = new Map<string, any[]>();
  for (const r of runs) if (r?.head_sha && r.head_branch === branch) bySha.set(r.head_sha, [...(bySha.get(r.head_sha) ?? []), r]);
  const out: Pipeline[] = [];
  for (const [sha, rs] of bySha) {
    const done = rs.every((r) => r.status === "completed");
    const bad = rs.find((r) => r.status === "completed" && !["success", "skipped", "neutral"].includes(r.conclusion));
    const state: Pipeline["state"] = bad ? (bad.conclusion === "cancelled" ? "stopped" : "failed") : done ? "passed" : "running";
    const first = [...rs].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
    out.push({ uuid: String(first.id), number: first.run_number, commit: sha, branch, state, createdAt: first.created_at, url: (bad ?? first).html_url });
  }
  return out;
}

/** A GitHub token from GH_TOKEN / GITHUB_TOKEN or the gh CLI. Read when needed, never stored or logged. */
export function githubToken(): string | null {
  const env = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (env) return env;
  const r = spawnSync("gh auth token", { encoding: "utf8", shell: true, windowsHide: true, timeout: 5000 });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

async function fetchGithubRuns(slug: { owner: string; repo: string }, branch: string, token: string | null): Promise<Pipeline[]> {
  const url = `https://api.github.com/repos/${slug.owner}/${slug.repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=50`;
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "workglance" };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`github ${r.status}`);
  const j = await r.json() as { workflow_runs?: any[] };
  return toGithubPipelines(j.workflow_runs ?? [], branch);
}

/** Credentials from a netrc file (`machine api.bitbucket.org login X password Y`). Read when needed, never stored or logged. */
export function netrcAuth(file: string, host = "api.bitbucket.org"): string | null {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return null; }
  const tokens = text.split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== "machine" || tokens[i + 1] !== host) continue;
    let login: string | null = null, password: string | null = null;
    for (let j = i + 2; j < tokens.length && tokens[j] !== "machine"; j += 2) {
      if (tokens[j] === "login") login = tokens[j + 1] ?? null;
      if (tokens[j] === "password") password = tokens[j + 1] ?? null;
    }
    return login && password ? "Basic " + Buffer.from(`${login}:${password}`).toString("base64") : null;
  }
  return null;
}

/** Pure: Bitbucket's pipeline JSON -> our shape. */
export function toPipeline(p: any, slug: { ws: string; repo: string }): Pipeline | null {
  const commit = p?.target?.commit?.hash;
  if (!commit) return null;
  const st = p.state?.name, res = p.state?.result?.name;
  const state = st !== "COMPLETED" ? "running" : res === "SUCCESSFUL" ? "passed" : res === "STOPPED" ? "stopped" : "failed";
  return { uuid: p.uuid, number: p.build_number, commit, branch: p?.target?.ref_name ?? "", state, createdAt: p.created_on,
    url: `https://bitbucket.org/${slug.ws}/${slug.repo}/pipelines/results/${p.build_number}` };
}

async function fetchPipelines(slug: { ws: string; repo: string }, branch: string, auth: string): Promise<Pipeline[]> {
  const url = `https://api.bitbucket.org/2.0/repositories/${slug.ws}/${slug.repo}/pipelines/?sort=-created_on&pagelen=50&target.branch=${encodeURIComponent(branch)}`;
  const r = await fetch(url, { headers: { authorization: auth, accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`bitbucket ${r.status}`);
  const j = await r.json() as { values?: any[] };
  return (j.values ?? []).map((p) => toPipeline(p, slug)).filter((p): p is Pipeline => !!p);
}

/**
 * Pure given an ancestry check. The question a card answers is "has this change gone through a green
 * pipeline yet?": the first PASSING pipeline that contains the commit; if none passed yet, the latest one
 * that contains it (still failing or still running). Found on real data: the first pipeline containing
 * a fix on main (#412) failed for an unrelated reason; a later one passed and deployed it.
 */
export function coveringPipeline(sha: string, pipelines: Pipeline[], contains: (tip: string, sha: string) => boolean, commitAt?: string): Pipeline | null {
  // A pipeline that started before the commit existed can't contain it (an hour of slack for clocks): no git
  // call for those. Then stop at the first answer: each `contains` is a git process, and this runs for every
  // linked commit against ~50 pipelines per branch.
  const from = commitAt ? new Date(Date.parse(commitAt) - 3600_000).toISOString() : "";
  const candidates = [...pipelines].filter((p) => p.createdAt >= from).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const has = (p: Pipeline) => p.commit === sha || contains(p.commit, sha);
  return candidates.find((p) => p.state === "passed" && has(p)) ?? [...candidates].reverse().find(has) ?? null;
}

const RECENT_MS = 7 * 86400_000;

// Without a token GitHub allows 60 requests an hour: then each branch is checked at most every 15 minutes.
const GITHUB_ANON_EVERY_MS = 15 * 60_000;

/**
 * For each repo on Bitbucket or GitHub with recent commits linked to tasks: fetch its recent dev/main
 * pipelines and store, per commit, the pipeline that covered it on each branch. Bitbucket needs the netrc
 * credentials (silent no-op without them); GitHub works without a token for public repos, rate-limited.
 */
export async function refreshPipelines(db: Db, netrcFile: string | null): Promise<number> {
  const bbAuth = netrcFile ? netrcAuth(netrcFile) : null;
  let ghToken: string | null | undefined; // looked up once, only if a GitHub repo shows up
  const since = new Date(Date.now() - RECENT_MS).toISOString();
  const repos = db.prepare(`SELECT DISTINCT c.repo, r.main_ref, r.dev_ref FROM commits c JOIN repos r ON r.id = c.repo
    WHERE c.task_id IS NOT NULL AND c.at >= ? AND (c.in_dev = 1 OR c.in_main = 1)`).all(since) as { repo: string; main_ref: string | null; dev_ref: string | null }[];
  const upsert = db.prepare(`INSERT INTO commit_pipelines(sha, branch, number, state, url, checked_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(sha, branch) DO UPDATE SET number = excluded.number, state = excluded.state, url = excluded.url, checked_at = excluded.checked_at`);
  let n = 0;
  for (const r of repos) {
    const remote = git(r.repo, ["remote", "get-url", "origin"]) ?? "";
    const bb = bitbucketSlug(remote), gh = githubSlug(remote);
    if (!(bb && bbAuth) && !gh) continue;
    const commits = db.prepare(`SELECT COALESCE(matched_as, sha) AS sha, at, in_dev, in_main FROM commits
      WHERE repo = ? AND task_id IS NOT NULL AND at >= ? AND (in_dev = 1 OR in_main = 1)`).all(r.repo, since) as { sha: string; at: string; in_dev: number; in_main: number }[];
    // Through a green pipeline on a branch = settled there: never asked again.
    const settled = db.prepare("SELECT 1 FROM commit_pipelines WHERE sha = ? AND branch = ? AND state = 'passed'");
    for (const [ref, flag] of [[r.dev_ref, "in_dev"], [r.main_ref, "in_main"]] as const) {
      if (!ref) continue;
      const branch = ref.replace(/^origin\//, "");
      const wanted = commits.filter((c) => c[flag] === 1 && !settled.get(c.sha, branch));
      if (!wanted.length) continue;
      let pipelines: Pipeline[];
      try {
        if (bb && bbAuth) pipelines = await fetchPipelines(bb, branch, bbAuth);
        else {
          if (ghToken === undefined) ghToken = githubToken();
          const key = `github_checked:${gh!.owner}/${gh!.repo}:${branch}`;
          const last = Number((db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? 0);
          if (!ghToken && Date.now() - last < GITHUB_ANON_EVERY_MS) continue;
          db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run(key, String(Date.now()));
          pipelines = await fetchGithubRuns(gh!, branch, ghToken);
        }
      } catch { continue; }
      const known = new Map<string, boolean>();
      const contains = (tip: string, sha: string) => {
        const k = `${tip}:${sha}`;
        if (!known.has(k)) known.set(k, git(r.repo, ["merge-base", "--is-ancestor", sha, tip]) !== null);
        return known.get(k)!;
      };
      for (const c of wanted) {
        const p = coveringPipeline(c.sha, pipelines, contains, c.at);
        if (p) { upsert.run(c.sha, branch, p.number, p.state, p.url, new Date().toISOString()); n++; }
      }
    }
  }
  return n;
}
