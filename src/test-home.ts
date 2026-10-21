// Imported FIRST by tests whose code reads WORKGLANCE_HOME at import (paths.ts, config.ts): points it at a
// throwaway folder, so the user's real ~/.workglance (its config, its tab states) never shapes or receives a test.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.WORKGLANCE_HOME = mkdtempSync(join(tmpdir(), "wt-test-home-"));
