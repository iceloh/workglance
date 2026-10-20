import test from "node:test";
import assert from "node:assert/strict";
import { isUnder, pathKey } from "./transcript.ts";

test("pathKey: case-folded on Windows and macOS, exact on Linux", () => {
  assert.equal(pathKey("c:/Code/Shop/", "win32"), "c:\\code\\shop");
  assert.equal(pathKey("/Users/jane/Code/Shop", "darwin"), "/users/jane/code/shop");
  assert.equal(pathKey("/home/jane/Code/Shop", "linux"), "/home/jane/Code/Shop");
  assert.equal(pathKey("/home/jane/code/../Code/./Shop/", "linux"), "/home/jane/Code/Shop");
});

test("isUnder: the folder or inside it, never a sibling sharing its prefix, on every OS", () => {
  for (const [platform, parent, inside, sibling] of [
    ["win32", "C:\\code\\shop", "c:/code/shop/.claude/worktrees/x", "C:\\code\\shop-sdk"],
    ["darwin", "/Users/jane/code/shop", "/users/jane/code/shop/src", "/Users/jane/code/shop-sdk"],
    ["linux", "/home/jane/code/shop", "/home/jane/code/shop/src", "/home/jane/code/shop-sdk"],
  ] as const) {
    assert.ok(isUnder(parent, parent, platform), `${platform}: itself`);
    assert.ok(isUnder(inside, parent, platform), `${platform}: inside`);
    assert.ok(!isUnder(sibling, parent, platform), `${platform}: sibling`);
  }
  assert.ok(!isUnder("/home/jane/Code/shop/src", "/home/jane/code/shop", "linux"), "Linux: case matters");
  assert.ok(isUnder("/home/jane/code/shop/src", "/home/jane/code/shop/", "linux"), "trailing slash on the parent");
});

test("expandHome: ~ in config paths means the home folder", async () => {
  const { expandHome } = await import("./config.ts");
  assert.equal(expandHome("~/experiments", "/home/jane"), "/home/jane/experiments");
  assert.equal(expandHome("~", "/home/jane"), "/home/jane");
  assert.equal(expandHome("~jane/x", "/home/jane"), "~jane/x", "only the current user's ~");
  assert.equal(expandHome("/abs/x", "/home/jane"), "/abs/x");
});

test("pathKey: a Windows path stays case-insensitive even when read on Linux", () => {
  assert.equal(pathKey("C:/Code/Shop", "linux"), String.raw`c:\code\shop`);
  assert.ok(isUnder(String.raw`c:\code\shop\src`, "C:/CODE/Shop", "linux"));
});
