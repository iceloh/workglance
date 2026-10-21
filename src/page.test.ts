import test from "node:test";
import assert from "node:assert/strict";
import { BOARD_JS, LANGUAGES, renderSettingsPage, short } from "./page.ts";

test("settings page: its script parses; time pickers, a language list with Automatic first, escaped values", () => {
  const html = renderSettingsPage(["C:/tmp/x"], { times: ["08:00", "18:30"], summary: true, language: "Klingon <b>" });
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(m[1]!));
  assert.equal(html.match(/<input type="time"/g)?.length, 2);
  assert.match(html, /<option value="">Automatic: the language of your cards<\/option>/);
  assert.match(html, /<option selected>Klingon &lt;b&gt;<\/option>/, "a language from config.json stays selectable, escaped");
  assert.ok(LANGUAGES.includes("Portuguese (Brazil)"));
  assert.doesNotMatch(html.slice(html.indexOf("const MAXTIMES")), /alert\(|confirm\(/);
});

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
