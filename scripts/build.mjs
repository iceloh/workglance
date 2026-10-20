// Builds the published package: three self-contained bundles (no node_modules at runtime, one file to
// load per hook call) plus the `workglance` launcher. Node can't strip TypeScript types inside
// node_modules, so the package ships JavaScript.
import { build } from "esbuild";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist");

await build({
  entryPoints: { cli: "src/cli.ts", hook: "src/hook.ts", "refresh-worker": "src/refresh-worker.ts" },
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // Bundled CommonJS dependencies (parts of the MCP SDK) call require(); give ESM one.
  banner: { js: 'import { createRequire as __wtRequire } from "node:module"; const require = __wtRequire(import.meta.url);' },
  legalComments: "linked",
  logLevel: "warning",
});

// The launcher: hides only node:sqlite's "experimental" notice (hooks and the server already run with
// --no-warnings), then loads the CLI. A static import would load node:sqlite before this filter exists.
writeFileSync("dist/workglance.js", `#!/usr/bin/env node
const emit = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  if (/SQLite is an experimental feature/.test(String(warning?.message ?? warning))) return;
  return emit.call(process, warning, ...rest);
};
await import("./cli.js");
`);
chmodSync("dist/workglance.js", 0o755);
console.log("built dist/: workglance.js (bin), cli.js, hook.js, refresh-worker.js");
