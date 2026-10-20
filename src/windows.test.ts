import test from "node:test";
import assert from "node:assert/strict";
import { pickWindow, type Win } from "./windows.ts";

const NOW = 1_000_000;
const win = (id: string, folders: string[], focusedAt = 0, seenAt = NOW): Win => ({ id, folders, focusedAt, seenAt, waiter: null, queue: [] });

test("pickWindow: the window whose folder holds the tab's cwd, deepest first, then last focused", () => {
  const am = win("am", ["c:\\dev\\shop"], 5);
  const wt = win("wt", ["C:/projects/workglance"], 9);
  const wtree = win("wtree", ["C:\\dev\\shop\\.claude\\worktrees\\x"], 1);
  assert.equal(pickWindow([am, wt], "C:\\dev\\shop", NOW)?.id, "am", "case and slashes don't matter");
  assert.equal(pickWindow([am, wt], "c:\\dev\\shop\\.claude\\worktrees\\y", NOW)?.id, "am", "a worktree under the window's folder");
  assert.equal(pickWindow([am, wtree], "c:\\dev\\shop\\.claude\\worktrees\\x", NOW)?.id, "wtree", "the deeper folder wins");
  assert.equal(pickWindow([am, wt], "C:\\dev\\shop-apps-sdk", NOW), null, "a sibling with the same prefix is not inside");
  assert.equal(pickWindow([am, wt], "C:\\projects\\workglance\\", NOW)?.id, "wt");
  assert.equal(pickWindow([am, win("am2", ["C:\\dev\\shop"], 7)], "C:\\dev\\shop", NOW)?.id, "am2", "same folder twice: the last focused");
  assert.equal(pickWindow([win("old", ["C:\\dev\\shop"], 0, NOW - 60_000)], "C:\\dev\\shop", NOW), null, "a window that stopped polling is gone");
});
