// Only the pure parts: the tests never open a window.
import test from "node:test";
import assert from "node:assert/strict";
import { pickerCommands, readPick } from "./picker.ts";

test("pickerCommands: the modern Explorer picker on Windows, with no user text and nothing for a shell to parse", () => {
  const [w] = pickerCommands("win32");
  assert.equal(w!.cmd, "powershell.exe");
  const script = Buffer.from(w!.args.at(-1)!, "base64").toString("utf16le");
  assert.match(script, /FOS_PICKFOLDERS/);
  assert.match(script, /0x800704C7/, "a closed window is a cancel, any other failure is an error");
  assert.equal(w!.args.at(-2), "-EncodedCommand");
  assert.equal(pickerCommands("darwin")[0]!.cmd, "osascript");
  assert.deepEqual(pickerCommands("linux").map((c) => c.cmd), ["zenity", "kdialog"]);
});

test("readPick: a path, a cancel, or no picker on this system", () => {
  assert.deepEqual(readPick(0, "C:\\dev\\shop\r\n", false), { path: "C:\\dev\\shop" });
  assert.deepEqual(readPick(0, "/Users/me/shop/\n", false), { path: "/Users/me/shop" }, "macOS ends folders with /");
  assert.deepEqual(readPick(0, "C:\\", false), { path: "C:\\" }, "a drive keeps its separator");
  assert.deepEqual(readPick(0, "", false), { cancelled: true });
  assert.deepEqual(readPick(1, "", false), { cancelled: true }, "zenity exits 1 on Cancel");
  assert.deepEqual(readPick(null, "", true), { unavailable: true });
});
