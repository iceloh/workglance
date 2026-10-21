import "./test-home.ts"; // before anything that reads WORKGLANCE_HOME
import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";
import { scan } from "./scan.ts";

const line = (o: object) => JSON.stringify(o) + "\n";
const at = (m: number) => `2026-10-19T12:${String(m).padStart(2, "0")}:00.000Z`;
const user = (uuid: string, m: number, text: string) =>
  line({ type: "user", uuid, timestamp: at(m), cwd: "C:\\dev\\a", gitBranch: "dev", sessionId: "s1", entrypoint: "claude-vscode", message: { content: text } });

test("scan lease: another live scanner makes this one skip; the lease is released after a scan; an expired one is taken over", () => {
  const root = mkdtempSync(join(tmpdir(), "wt-lease-"));
  mkdirSync(join(root, "p"), { recursive: true });
  writeFileSync(join(root, "p", "s.jsonl"), user("u1", 1, "hi"));
  const db = openDb(":memory:");
  db.prepare("INSERT INTO meta(key, value) VALUES ('scan_lease', ?)").run(`other-process|${Date.now() + 60_000}`);
  assert.equal(scan(db, root).read, 0, "someone else is scanning: skip");
  db.prepare("UPDATE meta SET value = ? WHERE key = 'scan_lease'").run(`other-process|${Date.now() - 1}`);
  assert.equal(scan(db, root).read, 1, "their lease expired: take over");
  assert.equal(db.prepare("SELECT count(*) n FROM meta WHERE key = 'scan_lease'").get()!.n, 0, "released after the scan");
});

test("scan: backfill, then only what was appended; renames kept as history; subagent git actions go to the parent tab", () => {
  const root = mkdtempSync(join(tmpdir(), "wt-scan-"));
  const proj = join(root, "c--dev-a");
  mkdirSync(join(proj, "s1", "subagents"), { recursive: true });
  const main = join(proj, "s1.jsonl");
  writeFileSync(main, user("u1", 1, "first ask") + line({ type: "custom-title", customTitle: "MAG/HARDCODED", sessionId: "s1" }));
  writeFileSync(join(proj, "s1", "subagents", "agent-x.jsonl"),
    line({ type: "user", uuid: "sub1", timestamp: at(2), cwd: "C:\\dev\\a", sessionId: "s1", isSidechain: true, message: { content: "subagent task prompt" } }) +
    line({ type: "assistant", timestamp: at(3), cwd: "C:\\dev\\a", sessionId: "s1", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "git commit -m x" } }] } }));

  const db = openDb(":memory:");
  const first = scan(db, root);
  assert.equal(first.read, 2);

  appendFileSync(main, user("u2", 5, "second ask") + line({ type: "custom-title", customTitle: "DEVOPS/SRE", sessionId: "s1" }) + '{"type":"user","uuid":"u3"');
  const second = scan(db, root);
  assert.equal(second.read, 1, "only the file that changed is read again");

  const s = db.prepare("SELECT title, titles, first_at, last_at, entrypoint, transcript FROM sessions WHERE id='s1'").get() as any;
  assert.equal(s.transcript, main, "the tab's own file, never its subagent's log");
  assert.equal(s.title, "DEVOPS/SRE");
  assert.deepEqual(JSON.parse(s.titles).map((t: any) => t.title), ["MAG/HARDCODED", "DEVOPS/SRE"]);
  assert.deepEqual([s.first_at, s.last_at, s.entrypoint], [at(1), at(5), "claude-vscode"]);
  assert.deepEqual(db.prepare("SELECT text FROM prompts ORDER BY at").all().map((r: any) => r.text), ["first ask", "second ask"],
    "subagent prompts are not the person's prompts");
  assert.deepEqual(db.prepare("SELECT session_id, action, dir FROM git_actions").all().map((r) => ({ ...r })),
    [{ session_id: "s1", action: "commit", dir: "C:\\dev\\a" }]);

  // A file read by an older parser is read again (once), and that keeps one rename history, not two.
  db.exec("UPDATE files SET parser_version = 1");
  assert.equal(scan(db, root).read, 2, "both files re-read by the newer parser");
  assert.equal(scan(db, root).read, 0, "and then not again");
  assert.deepEqual(JSON.parse((db.prepare("SELECT titles FROM sessions WHERE id='s1'").get() as any).titles).map((t: any) => t.title), ["MAG/HARDCODED", "DEVOPS/SRE"]);
  assert.equal((db.prepare("SELECT count(*) n FROM prompts").get() as any).n, 2);

  // The half-written last line is picked up once it is complete, and nothing is counted twice.
  appendFileSync(main, ',"timestamp":"' + at(9) + '","sessionId":"s1","message":{"content":"third ask"}}\n');
  scan(db, root);
  assert.equal((db.prepare("SELECT count(*) n FROM prompts").get() as any).n, 3);

  // A workglance call and its "not connected" result, through the scanner (the result line has no timestamp of its own).
  appendFileSync(main,
    line({ type: "assistant", timestamp: at(10), cwd: "C:\\dev\\a", sessionId: "s1", message: { content: [{ type: "tool_use", id: "toolu_x", name: "mcp__workglance__create_task", input: { title: "Audit", type: "investigation" } }] } }) +
    line({ type: "user", sessionId: "s1", message: { content: [{ type: "tool_result", tool_use_id: "toolu_x", is_error: true, content: 'MCP server "workglance" is not connected' }] } }));
  scan(db, root);
  assert.deepEqual({ ...(db.prepare("SELECT tool, failed, session_id FROM wt_calls WHERE id='toolu_x'").get() as any) }, { tool: "create_task", failed: 1, session_id: "s1" });
});
