import test from "node:test";
import assert from "node:assert/strict";
import { short } from "./page.ts";

test("short: worktrees by name, the home folder as ~, long paths by their last two parts", () => {
  assert.equal(short("C:\\code\\shop\\.claude\\worktrees\\fix-login", "C:\\Users\\jane"), "⎇ fix-login");
  assert.equal(short("/home/jane/code/shop/.claude/worktrees/fix-login", "/home/jane"), "⎇ fix-login");
  assert.equal(short("C:\\Users\\Jane\\code\\shop", "C:\\Users\\jane"), "~\\code\\shop", "home matched case-insensitively");
  assert.equal(short("/home/jane/code/shop", "/home/jane"), "~/code/shop");
  assert.equal(short("/home/janet/code", "/home/jane"), "/home/janet/code", "a sibling of home is not home");
  assert.equal(short("C:\\code\\shop", "C:\\Users\\jane"), "C:\\code\\shop", "short paths stay whole");
  assert.equal(short("D:\\work\\clients\\acme\\monorepo\\services\\billing", "C:\\Users\\jane"), "…\\services\\billing");
});
