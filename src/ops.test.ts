import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ops.ts reads WORKGLANCE_HOME at import: run it in a child process with a throwaway home.
const OPS = fileURLToPath(new URL("./ops.ts", import.meta.url));
const DB = fileURLToPath(new URL("./db.ts", import.meta.url));
const TASKS = fileURLToPath(new URL("./tasks.ts", import.meta.url));

test("backups: one a day, the last 7 kept; export redacts secrets", () => {
  const home = mkdtempSync(join(tmpdir(), "wt-ops-"));
  mkdirSync(join(home, "backups"));
  for (let d = 1; d <= 8; d++) writeFileSync(join(home, "backups", `workglance-2026-10-0${d}.db`), "x");
  const script = `
    import { openDb } from ${JSON.stringify("file:///" + DB.replace(/\\/g, "/"))};
    import { createTask, updateTask } from ${JSON.stringify("file:///" + TASKS.replace(/\\/g, "/"))};
    import { backupIfDue, exportTasks } from ${JSON.stringify("file:///" + OPS.replace(/\\/g, "/"))};
    const db = openDb();
    const t = createTask(db, { session_id: "s", cwd: "C:\\\\r" }, { repo: null, worktree: null, branch: null }, { title: "Rotate key", type: "ops" });
    updateTask(db, null, "user", { id: t.id, status: "done", note: "old key was sk-ant-api03-abcdefghijklmnopqrstuvwx", result: "done" });
    const first = backupIfDue(db, "2026-10-19");
    const again = backupIfDue(db, "2026-10-19");
    console.log(JSON.stringify({ first, again, exported: exportTasks(db) }));`;
  const r = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], { env: { ...process.env, WORKGLANCE_HOME: home }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.first, "workglance-2026-10-19.db");
  assert.equal(out.again, null, "not twice the same day");
  const kept = readdirSync(join(home, "backups")).sort();
  assert.equal(kept.length, 7);
  assert.equal(kept.at(-1), "workglance-2026-10-19.db");
  assert.ok(!kept.includes("workglance-2026-10-01.db"), "oldest pruned");
  assert.ok(existsSync(join(home, "backups", "workglance-2026-10-19.db")));
  assert.equal(out.exported.tasks[0].history.at(-1).note, "old key was [api key]");
});
