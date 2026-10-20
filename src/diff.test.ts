import test from "node:test";
import assert from "node:assert/strict";
import { parseUnifiedDiff, reviewMessage } from "./diff.ts";

const SAMPLE = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,4 @@ function x() {
 keep
-old line
+new line
+added
 tail
diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
`;

test("parseUnifiedDiff: files, hunks and the right line numbers on both sides", () => {
  const [a, img] = parseUnifiedDiff(SAMPLE);
  assert.equal(a!.path, "src/a.ts");
  assert.deepEqual(a!.hunks[0]!.lines.map((l) => [l.kind, l.old, l.new, l.text]), [
    ["ctx", 10, 10, "keep"], ["del", 11, null, "old line"], ["add", null, 11, "new line"], ["add", null, 12, "added"], ["ctx", 12, 13, "tail"],
  ]);
  assert.equal(img!.binary, true);
});

test("reviewMessage: one message, file:line per comment, empty comments dropped", () => {
  assert.equal(reviewMessage([{ file: "src/a.ts", line: 11, text: " use the helper " }, { file: "README.md", line: null, text: "typo in title" }, { file: "x", line: 1, text: "  " }]),
    "Review of the changes:\n- src/a.ts:11 — use the helper\n- README.md — typo in title");
  assert.equal(reviewMessage([]), "");
});
