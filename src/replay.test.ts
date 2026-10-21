import "./test-home.ts"; // before anything that reads WORKGLANCE_HOME
import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.ts";
import { replayFailedCalls } from "./replay.ts";
import { runTool } from "./tools.ts";

const TAB = "tab-perf";
const old = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
function call(db: ReturnType<typeof openDb>, id: string, tool: string, input: object, failed: boolean, at = old(5)) {
  db.prepare("INSERT INTO wt_calls(id, session_id, at, tool, input, cwd, failed) VALUES (?,?,?,?,?,?,?)").run(id, TAB, at, tool, JSON.stringify(input), "C:\\nowhere", failed ? 1 : 0);
}

test("the AUDIT case: a create_task that hit a down server is replayed once, as that tab", () => {
  const db = openDb(":memory:");
  call(db, "toolu_lost", "create_task", { title: "Auditoria do codebase", type: "investigation", _workglance: {} }, true);
  const r = replayFailedCalls(db);
  assert.deepEqual(r.map((x) => x.outcome), ["replayed: W-1"]);
  const t = db.prepare("SELECT title, type, created_by FROM tasks").get() as any;
  assert.deepEqual({ ...t }, { title: "Auditoria do codebase", type: "investigation", created_by: TAB });
  assert.equal(replayFailedCalls(db).length, 0, "never twice");
});

test("not replayed: calls that went through, calls still in flight, and creates the tab already retried", () => {
  const db = openDb(":memory:");
  // went through: its id is on an event
  runTool(db, "create_task", { title: "Live one", type: "bug" }, { session_id: TAB, cwd: "C:\\nowhere" }, "toolu_ok");
  call(db, "toolu_ok", "create_task", { title: "Live one", type: "bug" }, true);
  // in flight: too recent to judge
  call(db, "toolu_new", "create_task", { title: "Fresh", type: "bug" }, true, new Date().toISOString());
  // failed, then the agent retried with a new call that succeeded
  call(db, "toolu_fail", "create_task", { title: "Retried", type: "feature" }, true);
  runTool(db, "create_task", { title: "Retried", type: "feature" }, { session_id: TAB, cwd: "C:\\nowhere" }, "toolu_retry");
  const r = replayFailedCalls(db);
  assert.deepEqual(r.map((x) => [x.id, x.outcome]), [["toolu_fail", "skipped: the tab retried and succeeded"]]);
  assert.equal((db.prepare("SELECT count(*) n FROM tasks").get() as any).n, 2);
});

test("a replayed update that is no longer valid is recorded as refused, not thrown", () => {
  const db = openDb(":memory:");
  call(db, "toolu_upd", "update_task", { id: 42, status: "done", note: "x" }, true);
  assert.match(replayFailedCalls(db)[0]!.outcome, /^refused: W-42 does not exist/);
});
