import test from "node:test";
import assert from "node:assert/strict";
import { BOARD_JS, short } from "./page.ts";

test("BOARD_JS: the board's browser script parses (an error there silently breaks every page)", () => {
  assert.doesNotThrow(() => new Function(BOARD_JS));
});

test("review: guidance and results inline, never a browser alert", () => {
  const review = BOARD_JS.slice(BOARD_JS.indexOf("async function loadDiff"), BOARD_JS.indexOf("async function post("));
  assert.ok(review.length > 0);
  assert.doesNotMatch(review, /alert\(/);
  assert.match(review, /reads them on its next prompt/);
  assert.match(review, /b\.disabled=!n/, "Send stays off until a comment has text");
});

test("short: worktrees by name, the home folder as ~, long paths by their last two parts", () => {
  assert.equal(short("C:\\code\\shop\\.claude\\worktrees\\fix-login", "C:\\Users\\jane"), "⎇ fix-login");
  assert.equal(short("/home/jane/code/shop/.claude/worktrees/fix-login", "/home/jane"), "⎇ fix-login");
  assert.equal(short("C:\\Users\\Jane\\code\\shop", "C:\\Users\\jane"), "~\\code\\shop", "home matched case-insensitively");
  assert.equal(short("/home/jane/code/shop", "/home/jane"), "~/code/shop");
  assert.equal(short("/home/janet/code", "/home/jane"), "/home/janet/code", "a sibling of home is not home");
  assert.equal(short("C:\\code\\shop", "C:\\Users\\jane"), "C:\\code\\shop", "short paths stay whole");
  assert.equal(short("D:\\work\\clients\\acme\\monorepo\\services\\billing", "C:\\Users\\jane"), "…\\services\\billing");
});
