// A board full of made-up work, for screenshots and for trying Workglance without installing anything:
//   npm run demo                 -> seeds a temp folder and serves it on http://127.0.0.1:4588
//   node --no-warnings scripts/demo.ts <empty folder>   -> only seeds that folder
// The demo server runs with WORKGLANCE_DEMO=1 (no git checks: the demo's folders don't exist) and its own
// data folder and port, so it never touches a real install.
import { mkdirSync, mkdtempSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const serve = process.argv.includes("--serve");
const home = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? mkdtempSync(join(tmpdir(), "workglance-demo-"));
process.env.WORKGLANCE_HOME = home;
mkdirSync(join(home, "none"), { recursive: true });
const { openDb } = await import("../src/db.ts");
const { createTask, updateTask, userComment } = await import("../src/tasks.ts");
const { saveState } = await import("../src/state.ts");

const db = openDb(join(home, "workglance.db"));
const NOW = Date.now();
const ago = (h: number) => new Date(NOW - h * 3600_000).toISOString();
const REPO = "/home/jane/code/shop";
const wt = (name: string) => `${REPO}/.claude/worktrees/${name}`;

const TABS: Record<string, string> = {
  checkout: "CHECKOUT", payments: "PAYMENTS", search: "SEARCH", infra: "INFRA", docs: "DOCS",
};
const sid = (k: string) => `${k.padEnd(8, "0").slice(0, 8)}-0000-4000-8000-000000000000`.replace(/[^0-9a-f-]/g, "a");
for (const [k, title] of Object.entries(TABS)) {
  db.prepare("INSERT INTO sessions(id, title, titles, first_at, last_at, entrypoint) VALUES (?, ?, '[]', ?, ?, 'claude-vscode')").run(sid(k), title, ago(70), ago(0.1));
}
db.prepare("INSERT INTO repos(id, name, main_ref, dev_ref, checked_at) VALUES (?, 'shop', 'origin/main', 'origin/dev', ?)").run(REPO, ago(0));

type Seed = {
  tab: string; title: string; type: string; status: "planned" | "in_progress" | "testing" | "done"; worktree: string; branch: string;
  startedH: number; closedH?: number; testingH?: number; result?: string; note?: string; edits?: number;
  commits?: { subject: string; h: number; dev: boolean; main: boolean }[]; ci?: { branch: string; n: number; state: string };
  usd?: number; description?: string;
};
const SEEDS: Seed[] = [
  { tab: "checkout", title: "Retry Stripe webhooks with exponential backoff", type: "feature", status: "done", worktree: wt("webhook-retry"), branch: "feat/webhook-retry",
    startedH: 52, closedH: 30, edits: 34, usd: 18.4, ci: { branch: "main", n: 212, state: "passed" },
    result: "Webhook handler retries 5xx and timeouts with backoff (1 s → 5 min, 8 tries) and a dead-letter table. Verified: unit tests + replaying 40 captured events against staging. Left: alert on dead letters (W-6).",
    commits: [{ subject: "feat(webhooks): retry with exponential backoff", h: 40, dev: true, main: true }, { subject: "feat(webhooks): dead-letter table and replay command", h: 33, dev: true, main: true }] },
  { tab: "checkout", title: "Cart total off by one cent with stacked discounts", type: "bug", status: "done", worktree: REPO, branch: "dev",
    startedH: 26, closedH: 22, edits: 9, usd: 4.1, ci: { branch: "main", n: 214, state: "passed" },
    result: "Discounts were rounded per line, then summed. Now summed in cents and rounded once. Regression test with the customer's cart.",
    commits: [{ subject: "fix(cart): round stacked discounts once, in cents", h: 23, dev: true, main: true }] },
  { tab: "checkout", title: "Apple Pay on the checkout page", type: "feature", status: "testing", worktree: wt("apple-pay"), branch: "feat/apple-pay",
    startedH: 20, testingH: 3, edits: 41, usd: 27.9, ci: { branch: "dev", n: 231, state: "passed" }, note: "Pushed to dev; needs a check on a real iPhone (sandbox card).",
    commits: [{ subject: "feat(checkout): Apple Pay button and merchant validation", h: 9, dev: true, main: false }, { subject: "feat(checkout): Apple Pay shipping contact mapping", h: 4, dev: true, main: false }] },
  { tab: "search", title: "Typo-tolerant product search", type: "feature", status: "in_progress", worktree: wt("fuzzy-search"), branch: "feat/fuzzy-search",
    startedH: 6, edits: 22, usd: 11.2, note: "Trigram index in place; tuning the threshold on the 500 most common queries.",
    commits: [{ subject: "feat(search): pg_trgm index on product names", h: 2, dev: false, main: false }] },
  { tab: "search", title: "Why is checkout p95 latency 2.3 s?", type: "investigation", status: "done", worktree: REPO, branch: "dev",
    startedH: 30, closedH: 27, usd: 6.3,
    result: "Findings: 1) 61% of p95 is the tax API called twice per request (once for the preview) - cache per cart hash. 2) N+1 on product images in the summary (14 queries). 3) Cold start of the PDF receipt worker on the first order of the hour. Fixing 1 and 2 should bring p95 under 900 ms." },
  { tab: "payments", title: "Remove the legacy payment webhook route", type: "refactor", status: "in_progress", worktree: wt("legacy-webhook"), branch: "refactor/legacy-webhook",
    startedH: 1.5, edits: 6, usd: 2.2, note: "Asked whether to keep the old route for a week with a deprecation log." },
  { tab: "infra", title: "Move the staging database into the new VPC", type: "ops", status: "testing", worktree: `${REPO}-infra`, branch: "main",
    startedH: 98, testingH: 90, edits: 12, usd: 9.7, ci: { branch: "main", n: 88, state: "failed" }, note: "Applied to staging; waiting for the nightly backup to confirm restores work.",
    commits: [{ subject: "infra(staging): db subnet group in vpc-2", h: 92, dev: true, main: true }] },
  { tab: "infra", title: "Rate-limit the public API", type: "feature", status: "planned", worktree: REPO, branch: "dev", startedH: 4 },
  { tab: "docs", title: "Document the orders endpoint", type: "docs", status: "done", worktree: REPO, branch: "dev",
    startedH: 10, closedH: 8, edits: 5, usd: 1.6, result: "OpenAPI spec + examples for list/create/refund; published on the docs site.",
    commits: [{ subject: "docs(api): orders endpoint with examples", h: 8.5, dev: true, main: true }] },
];

const at = (id: number, field: string, iso: string) => db.prepare(`UPDATE tasks SET ${field} = ? WHERE id = ?`).run(iso, id);
let shaN = 0;
for (const s of SEEDS) {
  const stamp = { session_id: sid(s.tab), cwd: s.worktree };
  const t = createTask(db, stamp, { repo: REPO, worktree: s.worktree, branch: s.branch }, { title: s.title, type: s.type as any, description: s.description, start_now: s.status !== "planned" });
  if (s.status === "testing") updateTask(db, stamp, "agent", { id: t.id, status: "testing", note: s.note ?? "pushed" });
  if (s.status === "done") updateTask(db, stamp, "agent", { id: t.id, status: "done", note: "done", result: s.result });
  if (s.status === "in_progress" && s.note) updateTask(db, stamp, "agent", { id: t.id, note: s.note });
  // Spread the history over the past days.
  at(t.id, "created_at", ago(s.startedH));
  if (s.status !== "planned") at(t.id, "started_at", ago(s.startedH));
  if (s.closedH !== undefined) at(t.id, "closed_at", ago(s.closedH));
  at(t.id, "updated_at", ago(s.closedH ?? s.testingH ?? Math.min(s.startedH, 0.3)));
  const evs = db.prepare("SELECT id FROM task_events WHERE task_id = ? ORDER BY id").all(t.id) as { id: number }[];
  const times = [s.startedH, s.testingH ?? s.closedH ?? 0.3, s.closedH ?? 0.2];
  evs.forEach((e, i) => db.prepare("UPDATE task_events SET at = ? WHERE id = ?").run(ago(times[Math.min(i, times.length - 1)]!), e.id));
  db.prepare("UPDATE task_sessions SET first_at = ?, last_at = ? WHERE task_id = ?").run(ago(s.startedH), ago(s.closedH ?? 0.2), t.id);
  db.prepare("INSERT OR IGNORE INTO dirs(path, worktree, repo, checked_at) VALUES (?, ?, ?, ?)").run(s.worktree, s.worktree, REPO, ago(0));
  for (let i = 0; i < (s.edits ?? 0); i++) {
    const h = s.startedH - ((s.startedH - (s.closedH ?? 0.1)) * (i + 1)) / ((s.edits ?? 1) + 1);
    db.prepare("INSERT INTO edits(id, session_id, at, dir) VALUES (?, ?, ?, ?)").run(`e${t.id}-${i}`, sid(s.tab), ago(h), s.worktree);
  }
  for (const c of s.commits ?? []) {
    const sha = (0xa1b2c3d0 + ++shaN * 7919).toString(16).padEnd(40, "0");
    db.prepare("INSERT INTO commits(sha, repo, worktree, at, subject, session_id, task_id, in_dev, in_main, checked_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(sha, REPO, s.worktree, ago(c.h), c.subject, sid(s.tab), t.id, c.dev ? 1 : 0, c.main ? 1 : 0, ago(0));
    if (s.ci) db.prepare("INSERT OR REPLACE INTO commit_pipelines(sha, branch, number, state, url, checked_at) VALUES (?,?,?,?,?,?)")
      .run(sha, s.ci.branch, s.ci.n, s.ci.state, `https://ci.example.com/shop/${s.ci.n}`, ago(0));
  }
  // Model usage while it was open: output-heavy enough to land near the intended cost (opus-5-5 output $20/M).
  if (s.usd) {
    const n = 12;
    for (let i = 0; i < n; i++) {
      const h = s.startedH - ((s.startedH - (s.closedH ?? 0.1)) * (i + 1)) / (n + 1);
      db.prepare("INSERT INTO usage VALUES (?, ?, ?, 'claude-opus-5-5', 50, ?, 0, 0, 0)").run(`u${t.id}-${i}`, sid(s.tab), ago(h), Math.round((s.usd / n / 20) * 1e6));
    }
  }
}
// A comment from the user on the board, not yet seen by the tab.
const apple = (db.prepare("SELECT id FROM tasks WHERE title LIKE 'Apple Pay%'").get() as { id: number }).id;
userComment(db, apple, "Also test with a card that requires 3-D Secure.");

// Prompts, so the stats and the per-tab view have something to count.
const PROMPTS: [string, string, number][] = [
  ["checkout", "Stripe webhooks are failing silently when our API times out. Add retries.", 52],
  ["checkout", "Customer says the cart is one cent off with two discounts. Find it.", 26],
  ["checkout", "Add Apple Pay to checkout, behind the payments feature flag.", 20],
  ["search", "Why is checkout so slow at p95? Investigate, don't change anything yet.", 30],
  ["search", "Make product search tolerant to typos.", 6],
  ["payments", "We don't need the legacy webhook route anymore, remove it.", 1.5],
  ["infra", "Move the staging DB into the new VPC.", 98],
  ["docs", "Document the orders endpoint, with examples.", 10],
];
PROMPTS.forEach(([tab, text, h], i) => db.prepare("INSERT INTO prompts(uuid, session_id, at, text, cwd, branch) VALUES (?,?,?,?,?,?)").run(`p${i}`, sid(tab), ago(h), text, REPO, "dev"));

// Work nobody finished: shows up under "Still undone" and, when old, "Needs attention".
const WORKTREES: [string, string, number, number, number][] = [
  [wt("apple-pay"), "feat/apple-pay", 2, 0, 1],
  [wt("fuzzy-search"), "feat/fuzzy-search", 4, 1, 0.5],
  [wt("old-coupons"), "feat/coupons-v2", 7, 0, 140],
];
for (const [path, branch, dirty, ahead, touchedH] of WORKTREES) {
  db.prepare("INSERT OR REPLACE INTO worktrees(path, repo, branch, dirty, ahead, upstream, exists_now, checked_at) VALUES (?,?,?,?,?,?,1,?)").run(path, REPO, branch, dirty, ahead, `origin/${branch}`, ago(0));
  db.prepare("INSERT OR IGNORE INTO dirs(path, worktree, repo, checked_at) VALUES (?,?,?,?)").run(path, path, REPO, ago(0));
  db.prepare("INSERT OR REPLACE INTO locations(session_id, cwd, branch, first_at, last_at, hits) VALUES (?,?,?,?,?,1)").run(sid(path.includes("search") ? "search" : "checkout"), path, branch, ago(touchedH + 1), ago(touchedH));
}

// What each tab is doing right now.
const LIVE: [string, "working" | "question" | "permission" | "done", number, string?][] = [
  ["payments", "question", 0.15, "Keep the old route for a week with a deprecation log, or remove it now?"],
  ["infra", "permission", 0.05, "Bash: terraform plan -var-file=staging.tfvars"],
  ["search", "working", 0.02],
  ["checkout", "done", 0.5],
  ["docs", "done", 8],
];
for (const [tab, live, h, detail] of LIVE) saveState(sid(tab), { changed: 0, nudges: 0, active: true, live, liveAt: ago(h), liveDetail: detail });
console.log(`demo data in ${home}: ${SEEDS.length} cards, ${Object.keys(TABS).length} tabs`);
if (serve) {
  const env = { ...process.env, WORKGLANCE_HOME: home, WORKGLANCE_PORT: "4588", WORKGLANCE_DEMO: "1", WORKGLANCE_CLAUDE_PROJECTS: join(home, "none") };
  console.log("demo board: http://127.0.0.1:4588  (Ctrl+C to stop)");
  spawn(process.execPath, ["--no-warnings", join(import.meta.dirname, "..", "src", "cli.ts"), "serve"], { env, stdio: "inherit" });
}
