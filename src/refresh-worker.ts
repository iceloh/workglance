// Runs the slow git refresh off the server's main thread, then exits (no memory kept between runs).
import { parentPort } from "node:worker_threads";
import { openDb } from "./db.ts";
import { loadConfig } from "./config.ts";
import { linkCommitsToTasks, refreshCommits, refreshDirs, refreshRepos } from "./commits.ts";
import { placeTasks } from "./task-place.ts";
import { refreshPipelines } from "./pipelines.ts";

const db = openDb();
const t0 = Date.now();
let error: string | null = null;
try {
  refreshDirs(db);
  refreshCommits(db);
  linkCommitsToTasks(db);
  placeTasks(db);
  refreshRepos(db);
  await refreshPipelines(db, loadConfig().bitbucketNetrc);
} catch (e) {
  error = e instanceof Error ? e.message : String(e);
}
db.close();
parentPort?.postMessage({ ms: Date.now() - t0, error });
