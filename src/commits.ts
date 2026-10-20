// Which tab made which commit, and how far each commit got (in dev? in main?).
import type { Db } from "./db.ts";
import { myCommits, patchId, refCommits, resolveRepo, stageRefs, userEmail, worktreeList, worktreeState, type GitCommit } from "./git.ts";
import { normalizeDir } from "./transcript.ts";
import { taskForCommit } from "./tasks.ts";
import { isIgnored, loadConfig } from "./config.ts";

/**
 * A `git commit` can take a while to land (pre-commit hooks of 30+ min, background runs), but the
 * commit is always created AFTER the command started; the small "before" margin is only clock skew.
 */
export const COMMIT_WINDOW_BEFORE_SEC = 10;
export const COMMIT_WINDOW_AFTER_SEC = 60 * 60;

export type CommitAction = { id: string; sessionId: string; atSec: number };

/**
 * Pure. Each commit goes to the closest `git commit` action that ran before it (within the window) in
 * the same repo. Author time survives rebase and amend, so a rewritten copy lands on the same tab.
 */
export function attribute(actions: CommitAction[], commits: GitCommit[]): Map<string, CommitAction> {
  const sorted = [...actions].sort((a, b) => a.atSec - b.atSec);
  const out = new Map<string, CommitAction>();
  for (const c of commits) {
    let best: CommitAction | null = null;
    for (const a of sorted) {
      if (a.atSec - COMMIT_WINDOW_BEFORE_SEC > c.authorAt) break;
      if (c.authorAt - a.atSec <= COMMIT_WINDOW_AFTER_SEC) best = a;
    }
    if (best) out.set(c.sha, best);
  }
  return out;
}

const RECHECK_DIR_MS = 24 * 60 * 60 * 1000;

/** Folders the tabs worked in -> worktrees and repos. Cached; a folder is checked again once a day. */
export function refreshDirs(db: Db): void {
  const now = new Date();
  const dirs = db.prepare(`SELECT DISTINCT cwd AS d FROM locations UNION SELECT DISTINCT dir FROM git_actions`).all() as { d: string }[];
  const cached = new Map((db.prepare("SELECT path, checked_at FROM dirs").all() as { path: string; checked_at: string }[]).map((r) => [r.path, r.checked_at]));
  const upsert = db.prepare(`INSERT INTO dirs(path, worktree, repo, checked_at) VALUES (?,?,?,?)
    ON CONFLICT(path) DO UPDATE SET worktree = COALESCE(excluded.worktree, dirs.worktree), repo = COALESCE(excluded.repo, dirs.repo), checked_at = excluded.checked_at`);
  const cfg = loadConfig();
  for (const { d } of dirs) {
    if (isIgnored(cfg, d)) continue; // untracked: not even a git call there
    const at = cached.get(normalizeDir(d));
    if (at && now.getTime() - Date.parse(at) < RECHECK_DIR_MS) continue;
    const r = resolveRepo(d);
    upsert.run(normalizeDir(d), r?.worktree ?? null, r?.repo ?? null, now.toISOString());
  }
}

/** Repos, their worktrees and what is still undone in each (uncommitted files, commits not pushed). */
export function refreshRepos(db: Db): void {
  const now = new Date().toISOString();
  const repos = (db.prepare("SELECT DISTINCT repo FROM dirs WHERE repo IS NOT NULL").all() as { repo: string }[]).map((r) => r.repo);
  const upRepo = db.prepare(`INSERT INTO repos(id, name, main_ref, dev_ref, checked_at) VALUES (?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET main_ref = excluded.main_ref, dev_ref = excluded.dev_ref, checked_at = excluded.checked_at`);
  const upWt = db.prepare(`INSERT INTO worktrees(path, repo, branch, head, dirty, ahead, upstream, exists_now, checked_at) VALUES (?,?,?,?,?,?,?,1,?)
    ON CONFLICT(path) DO UPDATE SET repo = excluded.repo, branch = excluded.branch, head = excluded.head, dirty = excluded.dirty,
      ahead = excluded.ahead, upstream = excluded.upstream, exists_now = 1, checked_at = excluded.checked_at`);
  const cfg = loadConfig();
  for (const repo of repos) {
    if (isIgnored(cfg, repo)) continue;
    const refs = stageRefs(repo);
    upRepo.run(repo, repo.split(/[\\/]/).at(-1) ?? repo, refs.main, refs.dev, now);
    db.prepare("UPDATE worktrees SET exists_now = 0 WHERE repo = ?").run(repo);
    for (const wt of worktreeList(repo)) {
      if (isIgnored(cfg, wt.path)) continue;
      const st = worktreeState(wt.path);
      upWt.run(wt.path, repo, wt.branch, wt.head, st?.dirty ?? null, st?.ahead ?? null, st?.upstream ?? null, now);
    }
  }
}

/** Margin when re-reading recent actions: transcripts can be scanned a little after the fact. */
const RECENT_MARGIN_SEC = 2 * 60 * 60;

/**
 * My commits in every repo a tab committed to: attributed to tabs, with their stage. Incremental:
 * a commit already in main is final and never looked at again; a repo is re-read only from its
 * oldest unfinished commit or its newest actions.
 */
export function refreshCommits(db: Db): void {
  const now = new Date().toISOString();
  const rows = db.prepare(`SELECT g.id, g.session_id, g.at, d.repo, d.worktree FROM git_actions g JOIN dirs d ON d.path = g.dir
    WHERE g.action = 'commit' AND d.repo IS NOT NULL`).all() as { id: string; session_id: string; at: string; repo: string; worktree: string }[];
  const byRepo = new Map<string, typeof rows>();
  for (const r of rows) byRepo.set(r.repo, [...(byRepo.get(r.repo) ?? []), r]);
  const lastCheck = new Map((db.prepare("SELECT repo, commits_at FROM checks").all() as { repo: string; commits_at: string }[]).map((r) => [r.repo, Date.parse(r.commits_at) / 1000]));
  const pendingSince = db.prepare("SELECT min(at) at FROM commits WHERE repo = ? AND COALESCE(in_main, 0) = 0");
  const finalShas = db.prepare("SELECT sha FROM commits WHERE repo = ? AND in_main = 1");
  const setCheck = db.prepare("INSERT INTO checks(repo, commits_at) VALUES (?, ?) ON CONFLICT(repo) DO UPDATE SET commits_at = excluded.commits_at");
  const pid = cachedPatchId(db);

  const upsert = db.prepare(`INSERT INTO commits(sha, repo, worktree, at, subject, session_id, action_id, in_dev, in_main, matched_as, checked_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(sha) DO UPDATE SET session_id = excluded.session_id, action_id = excluded.action_id,
      worktree = excluded.worktree, in_dev = excluded.in_dev, in_main = excluded.in_main, matched_as = excluded.matched_as, checked_at = excluded.checked_at`);
  const cfg = loadConfig();
  for (const [repo, acts] of byRepo) {
    if (isIgnored(cfg, repo)) continue;
    const email = userEmail(repo);
    if (!email) continue;
    const checked = lastCheck.get(repo);
    const actSecs = acts.map((a) => Date.parse(a.at) / 1000);
    const newActs = checked === undefined ? actSecs : actSecs.filter((s) => s >= checked - RECENT_MARGIN_SEC);
    const pending = (pendingSince.get(repo) as { at: string | null }).at;
    const starts = [...newActs, ...(pending ? [Date.parse(pending) / 1000] : [])];
    if (!starts.length) { setCheck.run(repo, now); continue; }
    const since = Math.min(...starts) - COMMIT_WINDOW_BEFORE_SEC;
    const done = new Set((finalShas.all(repo) as { sha: string }[]).map((r) => r.sha));
    const mine = myCommits(repo, email, since).filter((c) => !done.has(c.sha));
    const actions = acts.map((a) => ({ id: a.id, sessionId: a.session_id, atSec: Date.parse(a.at) / 1000 }));
    const who = attribute(actions, mine);
    const refs = stageRefs(repo);
    const dev = refs.dev ? refCommits(repo, refs.dev, since - 86400) : null;
    const main = refs.main ? refCommits(repo, refs.main, since - 86400) : null;
    const wtOf = new Map(acts.map((a) => [a.id, a.worktree]));
    db.exec("BEGIN");
    for (const c of mine) {
      const a = who.get(c.sha);
      if (!a) continue; // a commit no tab made (typed by hand): not ours to show here
      const inMain = main ? reached(repo, c, main, pid) : null;
      const inDev = dev ? reached(repo, c, dev, pid) : null;
      const matched = (inMain && inMain !== c.sha) || (inDev && inDev !== c.sha) ? (inMain ?? inDev) : null;
      upsert.run(c.sha, repo, wtOf.get(a.id) ?? null, new Date(c.authorAt * 1000).toISOString(), c.subject, a.sessionId, a.id,
        dev ? (inDev ? 1 : 0) : null, main ? (inMain ? 1 : 0) : null, matched, now);
    }
    setCheck.run(repo, now);
    db.exec("COMMIT");
  }
}

/** Each commit a tab made goes to the task that tab was working on at that moment (if any). */
export function linkCommitsToTasks(db: Db): number {
  // Recomputed for every commit made by a tab (a few hundred rows): a task started or closed later can
  // change where a commit belongs, and a fixed rule must correct old links, not only new ones.
  const pending = db.prepare("SELECT sha, session_id, at, matched_as FROM commits WHERE session_id IS NOT NULL").all() as { sha: string; session_id: string; at: string; matched_as: string | null }[];
  const claims = db.prepare("SELECT sha, task_id FROM commit_claims c WHERE EXISTS (SELECT 1 FROM tasks t WHERE t.id = c.task_id AND t.status <> 'dropped') ORDER BY at").all() as { sha: string; task_id: number }[];
  const claimed = (c: { sha: string; matched_as: string | null }) => claims.filter((k) => c.sha.startsWith(k.sha) || (c.matched_as ?? "").startsWith(k.sha)).at(-1)?.task_id ?? null;

  // Every moment this tab put a card in focus: created it started, took it, or moved it back to in progress.
  const rowsOf = db.prepare(`SELECT e.task_id, e.at AS focus_at, t.closed_at FROM task_events e JOIN tasks t ON t.id = e.task_id
    WHERE e.session_id = ? AND (e.kind = 'taken' OR e.to_status = 'in_progress') AND t.status <> 'dropped'`);
  const set = db.prepare("UPDATE commits SET task_id = ? WHERE sha = ?");
  let linked = 0;
  for (const c of pending) {
    const task = claimed(c) ?? taskForCommit(rowsOf.all(c.session_id) as any[], Date.parse(c.at));
    set.run(task, c.sha); // null when no task fits any more (e.g. the task was dropped)
    if (task) linked++;
  }
  return linked;
}

type PatchIdOf =(repo: string, sha: string) => string | null;

function cachedPatchId(db: Db): PatchIdOf {
  const get = db.prepare("SELECT pid FROM patch_ids WHERE sha = ?");
  const put = db.prepare("INSERT OR REPLACE INTO patch_ids(sha, pid) VALUES (?, ?)");
  return (repo, sha) => {
    const hit = get.get(sha) as { pid: string | null } | undefined;
    if (hit) return hit.pid;
    const pid = patchId(repo, sha);
    put.run(sha, pid);
    return pid;
  };
}

/** The sha under which this change is reachable from `ref`: itself, or a rebased copy with the same patch. */
function reached(repo: string, c: GitCommit, ref: { shas: Set<string>; bySubject: Map<string, string[]> }, pid: PatchIdOf): string | null {
  if (ref.shas.has(c.sha)) return c.sha;
  const twins = ref.bySubject.get(c.subject);
  if (!twins?.length) return null;
  const mine = pid(repo, c.sha);
  if (!mine) return null;
  return twins.find((t) => pid(repo, t) === mine) ?? null;
}
