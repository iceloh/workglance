// workglance <command>
//   scan    read new transcript lines (first run = full backfill) and print what was found
//   serve   start the board on 127.0.0.1 (scans on every page load)
import { openDb } from "./db.ts";
import { scan } from "./scan.ts";

const cmd = process.argv[2] ?? "help";

if (cmd === "scan") {
  const db = openDb();
  const s = scan(db);
  const count = (t: string) => (db.prepare(`SELECT count(*) n FROM ${t}`).get() as { n: number }).n;
  console.log(`files ${s.files}, read ${s.read}, ${(s.bytes / 1048576).toFixed(1)} MB, ${s.facts} facts, ${s.ms} ms, rss ${Math.round(process.memoryUsage().rss / 1048576)} MB`);
  console.log(`sessions ${count("sessions")}, prompts ${count("prompts")}, locations ${count("locations")}, git actions ${count("git_actions")}`);
} else if (cmd === "serve") {
  await import("./server.ts");
} else if (cmd === "eval") {
  const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  await (await import("./eval/run.ts")).runEval({ only: arg("--only"), model: arg("--model"), parallel: arg("--parallel") ? Number(arg("--parallel")) : undefined });
} else if (cmd === "doctor") {
  const checks = await (await import("./ops.ts")).doctor();
  for (const c of checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name.padEnd(17)} ${c.detail}`);
  process.exitCode = checks.every((c) => c.ok || c.name === "vscode extension") ? 0 : 1;
} else if (cmd === "stop") {
  console.log((await (await import("./ops.ts")).stop()) ? "stopped" : "not running");
} else if (cmd === "restart") {
  await (await import("./ops.ts")).restart();
  console.log("restarted");
} else if (cmd === "export") {
  const { exportTasks } = await import("./ops.ts");
  process.stdout.write(JSON.stringify(exportTasks(openDb()), null, 2) + "\n");
} else if (cmd === "install") {
  (await import("./install.ts")).install();
} else if (cmd === "uninstall") {
  (await import("./install.ts")).uninstall();
} else {
  console.log("usage: workglance serve | scan | doctor | stop | restart | export | install | uninstall | eval [--only a,b] [--model sonnet] [--parallel 3]");
}
