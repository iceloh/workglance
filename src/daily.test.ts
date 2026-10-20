import test from "node:test";
import assert from "node:assert/strict";
import { dueRun, latestSlot, parseTimes, runDueDigest, ensureDigestTable, latestRun, slotId } from "./daily.ts";

const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m, 0, 0); // local time, October 2026

test("parseTimes: valid, sorted, unique, default 08:00", () => {
  assert.deepEqual(parseTimes("18:00, 8:00 13:00 8:00"), ["08:00", "13:00", "18:00"]);
  assert.deepEqual(parseTimes(["25:00", "nope", "7:30"]), ["07:30"]);
  assert.deepEqual(parseTimes(""), ["08:00"]);
  assert.deepEqual(parseTimes(undefined), ["08:00"]);
});

test("latestSlot: the last scheduled moment at or before now, including yesterday's", () => {
  const times = ["08:00", "13:00", "18:00"];
  assert.equal(slotId(latestSlot(at(21, 14), times)), "2026-10-21 13:00");
  assert.equal(slotId(latestSlot(at(21, 7, 59), times)), "2026-10-20 18:00", "before the first slot: yesterday's last");
  assert.equal(slotId(latestSlot(at(21, 8), times)), "2026-10-21 08:00", "exactly at the slot");
});

test("dueRun: one digest per slot, covering since the previous one; missed slots collapse into one", () => {
  const times = ["08:00", "13:00", "18:00"];
  const first = dueRun(at(21, 8, 1), times, null)!;
  assert.equal(first.id, "2026-10-21 08:00");
  assert.equal(Date.parse(first.to) - Date.parse(first.from), 86400_000, "the first ever covers the day before");
  assert.equal(dueRun(at(21, 12), times, first.to), null, "nothing until the next slot");
  const second = dueRun(at(21, 13, 5), times, first.to)!;
  assert.equal(second.id, "2026-10-21 13:00");
  assert.equal(second.from, first.to, "starts where the previous one ended");
  // Computer off from 13:00 to the next morning: one digest, 13:00 -> today 08:00.
  const back = dueRun(at(22, 9), times, second.to)!;
  assert.equal(back.id, "2026-10-22 08:00");
  assert.equal(back.from, second.to);
});

test("runDueDigest: stores it once; the same slot never runs twice", async () => {
  const { openDb } = await import("./db.ts");
  const db = openDb(":memory:");
  ensureDigestTable(db);
  assert.equal(runDueDigest(db, ["08:00"], at(21, 9))?.id, "2026-10-21 08:00");
  assert.equal(runDueDigest(db, ["08:00"], at(21, 15)), null);
  assert.equal(runDueDigest(db, ["08:00"], at(22, 8, 30))?.id, "2026-10-22 08:00");
  assert.equal(latestRun(db)?.id, "2026-10-22 08:00");
});
