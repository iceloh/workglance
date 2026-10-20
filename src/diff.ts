// A task's changes for review: its commits plus what is still uncommitted in its worktree.
import type { Db } from "./db.ts";
import { git } from "./git.ts";

export type DiffLine = { kind: "add" | "del" | "ctx"; old: number | null; new: number | null; text: string };
export type DiffFile = { path: string; hunks: { header: string; lines: DiffLine[] }[]; truncated: boolean; binary: boolean };
export type DiffSection = { title: string; sha: string | null; files: DiffFile[] };

const MAX_LINES_PER_FILE = 1500;

/** Pure: unified diff text (git show / git diff) -> files, hunks, numbered lines. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null, hunk: DiffFile["hunks"][number] | null = null, oldN = 0, newN = 0, count = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      file = { path: m?.[2] ?? line.slice(11), hunks: [], truncated: false, binary: false };
      files.push(file); hunk = null; count = 0;
      continue;
    }
    if (!file) continue;
    if (line.startsWith("Binary files ")) { file.binary = true; continue; }
    if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file") || line.startsWith("similarity") || line.startsWith("rename ")) continue;
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (h) { oldN = Number(h[1]); newN = Number(h[2]); hunk = { header: line, lines: [] }; file.hunks.push(hunk); continue; }
    if (!hunk || line.startsWith("\\")) continue;
    if (++count > MAX_LINES_PER_FILE) { file.truncated = true; continue; }
    if (line.startsWith("+")) hunk.lines.push({ kind: "add", old: null, new: newN++, text: line.slice(1) });
    else if (line.startsWith("-")) hunk.lines.push({ kind: "del", old: oldN++, new: null, text: line.slice(1) });
    else hunk.lines.push({ kind: "ctx", old: oldN++, new: newN++, text: line.slice(1) });
  }
  return files;
}

/** The task's commits (oldest first), then its worktree's uncommitted changes while the task is open. */
export function taskDiff(db: Db, taskId: number): DiffSection[] {
  const t = db.prepare("SELECT status, worktree, repo FROM tasks WHERE id = ?").get(taskId) as { status: string; worktree: string | null; repo: string | null } | undefined;
  if (!t) return [];
  const out: DiffSection[] = [];
  for (const c of db.prepare("SELECT sha, matched_as, subject, repo FROM commits WHERE task_id = ? ORDER BY at").all(taskId) as any[]) {
    const show = git(c.repo, ["show", "--format=", "--no-color", "-M", c.sha]) ?? (c.matched_as ? git(c.repo, ["show", "--format=", "--no-color", "-M", c.matched_as]) : null);
    if (show !== null) out.push({ title: c.subject, sha: c.sha, files: parseUnifiedDiff(show) });
  }
  if (t.worktree && ["planned", "in_progress", "testing"].includes(t.status)) {
    const wip = git(t.worktree, ["diff", "HEAD", "--no-color", "-M"]);
    if (wip) out.push({ title: "Uncommitted in the worktree", sha: null, files: parseUnifiedDiff(wip) });
  }
  return out;
}

/** Pure: line comments -> the one message the tab receives. */
export function reviewMessage(comments: { file: string; line: number | null; text: string }[]): string {
  const lines = comments.filter((c) => c.text.trim()).map((c) => `- ${c.file}${c.line ? `:${c.line}` : ""} — ${c.text.trim()}`);
  return lines.length ? `Review of the changes:\n${lines.join("\n")}` : "";
}
