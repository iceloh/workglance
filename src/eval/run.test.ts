import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { throwawayDirs } from "./run.ts";

test("throwawayDirs: the run's own folder and the transcript folder Claude makes for its repo", () => {
  const projects = join("tmp", "projects");
  assert.deepEqual(throwawayDirs("C:/runs/x-1", "C:/runs/x-1/repo", projects), ["C:/runs/x-1", join(projects, "C--runs-x-1-repo")]);
});
