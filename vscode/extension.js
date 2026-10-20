// Workglance for VS Code: a window into the local workglance server. No logic of its own besides
// starting the server, showing the board, and telling you when a tab needs you.
const vscode = require("vscode");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");

const HOME = process.env.WORKGLANCE_HOME || path.join(os.homedir(), ".workglance");

function installInfo() {
  try { return JSON.parse(fs.readFileSync(path.join(HOME, "install.json"), "utf8")); } catch { return null; }
}
const port = () => (installInfo() && installInfo().port) || 4477;
const base = () => `http://127.0.0.1:${port()}`;

function getJson(p) {
  return new Promise((resolve, reject) => {
    const req = http.get(base() + p, { timeout: 2000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}

let starting = 0;
/** Start the server like the session hook does, if nothing answers (at most once a minute). */
function ensureServer() {
  const info = installInfo();
  if (!info || Date.now() - starting < 60_000) return;
  starting = Date.now();
  const log = fs.openSync(path.join(HOME, "server.log"), "a");
  spawn(info.node || "node", ["--no-warnings", info.cli, "serve"], { detached: true, stdio: ["ignore", log, log], windowsHide: true }).unref();
}

function postJson(p, body, timeout) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(base() + p, { method: "POST", timeout, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => {
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () => { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end(data);
  });
}

/** Opens that exact Claude Code session in THIS window (the Claude extension's own command). */
function openTab(sessionId) {
  return vscode.commands.executeCommand("claude-vscode.primaryEditor.open", sessionId);
}

/** Opens a session in whichever window has it (asks the server); here only if no window claims it. */
async function openTabAnywhere(sessionId) {
  const r = await postJson("/api/open", { session: sessionId }, 3000).catch(() => ({}));
  if (!r.ok) await openTab(sessionId);
}

/** What `code <folder>` needs to find this window: its .code-workspace file, else its first folder. */
function windowTarget() {
  const ws = vscode.workspace.workspaceFile;
  if (ws && ws.scheme === "file") return ws.fsPath;
  const f = (vscode.workspace.workspaceFolders || []).find((x) => x.uri.scheme === "file");
  return f ? f.uri.fsPath : null;
}

/** Brings this window to the front: `code <its folder>` focuses the window that already has it open. */
function raiseWindow() {
  const target = windowTarget();
  const cli = path.join(vscode.env.appRoot, "out", "cli.js");
  if (!target || !fs.existsSync(cli)) return;
  spawn(process.execPath, [cli, target], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, detached: true, stdio: "ignore", windowsHide: true }).unref();
}

/** Tells the server which folders this window has, and opens the tabs it routes here. */
function windowLoop(context) {
  const id = crypto.randomUUID();
  let focusedAt = vscode.window.state.focused ? Date.now() : 0;
  let stopped = false;
  context.subscriptions.push(vscode.window.onDidChangeWindowState((s) => { if (s.focused) focusedAt = Date.now(); }), { dispose: () => { stopped = true; } });
  (async () => {
    while (!stopped) {
      const folders = (vscode.workspace.workspaceFolders || []).filter((f) => f.uri.scheme === "file").map((f) => f.uri.fsPath);
      try {
        const r = await postJson("/api/windows/wait", { id, folders, focusedAt }, 35_000);
        for (const s of r.open || []) {
          if (!/^[0-9a-f-]{36}$/i.test(s)) continue;
          await openTab(s);
          if (!vscode.window.state.focused) raiseWindow();
        }
      } catch { await new Promise((r) => setTimeout(r, 5000)); }
    }
  })();
}

// The extension is only a window: the engine (hooks, server, board) comes from `npx workglance install`.
// Without it there is nothing to show, so say so and offer to install it, instead of a silent dead icon.
const README = "https://github.com/iceloh/workglance#readme";
const isInstalled = () => !!installInfo();

function installEngine() {
  const t = vscode.window.createTerminal({ name: "Workglance install" });
  t.show();
  t.sendText("npx --yes workglance@latest install");
}

let asked = false;
async function offerInstall(context, force = false) {
  if (asked && !force) return;
  if (!force && context.globalState.get("workglance.dontAskInstall")) return;
  asked = true;
  const pick = await vscode.window.showInformationMessage(
    "Workglance isn't installed on this machine yet. The extension shows its board of what your AI coding tabs did; the board itself comes from a small local tool (needs Node.js 24+).",
    "Install now", "What is it?", "Don't ask again");
  if (pick === "Install now") installEngine();
  else if (pick === "What is it?") vscode.env.openExternal(vscode.Uri.parse(README));
  else if (pick === "Don't ask again") context.globalState.update("workglance.dontAskInstall", true);
}

let panel = null;
function openBoard(context) {
  if (!isInstalled()) { offerInstall(context, true); return; }
  if (panel) { panel.reveal(); return; }
  panel = vscode.window.createWebviewPanel("workglance.board", "Workglance", vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
  // The board itself is served by the local server; links that open a Claude tab are relayed to us.
  panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${base()}; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<style>html,body,iframe{margin:0;padding:0;border:0;width:100%;height:100vh;display:block;background:transparent}</style></head>
<body><iframe src="${base()}/?embed=1"></iframe>
<script>const vscode=acquireVsCodeApi();window.addEventListener("message",(e)=>{if(e.data&&e.data.type==="workglance.openTab")vscode.postMessage(e.data)});</script>
</body></html>`;
  panel.webview.onDidReceiveMessage((m) => { if (m && m.type === "workglance.openTab" && /^[0-9a-f-]{36}$/i.test(m.session)) openTabAnywhere(m.session); });
  panel.onDidDispose(() => { panel = null; });
}

function activate(context) {
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  bar.command = "workglance.openBoard";
  bar.text = "$(checklist) Workglance";
  bar.show();
  context.subscriptions.push(bar,
    vscode.commands.registerCommand("workglance.openBoard", () => openBoard(context)),
    vscode.commands.registerCommand("workglance.openInBrowser", () => vscode.env.openExternal(vscode.Uri.parse(base()))),
    vscode.commands.registerCommand("workglance.install", installEngine));

  windowLoop(context);

  const notified = new Map(); // session -> the live status we already notified about
  let failures = 0;
  let wasInstalled = isInstalled();
  const tick = async () => {
    const installed = isInstalled();
    if (!installed) {
      bar.text = "$(cloud-download) Install Workglance";
      bar.tooltip = "Workglance isn't installed on this machine yet. Click to install it.";
      bar.command = "workglance.install";
      bar.backgroundColor = undefined;
      offerInstall(context);
      wasInstalled = false;
      return;
    }
    bar.command = "workglance.openBoard";
    if (!wasInstalled) {
      wasInstalled = true;
      vscode.window.showInformationMessage("Workglance is installed. Restart your Claude Code tabs (or run /mcp in them) so they get its tools.", "Open board")
        .then((pick) => { if (pick) openBoard(context); });
    }
    try {
      const s = await getJson("/api/status");
      failures = 0;
      const needs = s.live.filter((t) => t.live === "question" || t.live === "permission");
      const parts = [];
      if (needs.length) parts.push(`$(bell-dot) ${needs.length} need you`);
      if (s.working) parts.push(`$(sync) ${s.working} working`);
      if (s.attention) parts.push(`$(warning) ${s.attention}`);
      bar.text = parts.join(" · ") || "$(checklist) Workglance";
      bar.backgroundColor = needs.length ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
      bar.tooltip = [
        ...s.live.map((t) => `${t.title || t.id.slice(0, 8)}: ${t.live}${t.detail ? ` (${t.detail})` : ""}`),
        s.attention ? `\n${s.attention} item(s) need attention (stuck tasks, stale worktrees)` : "",
      ].filter(Boolean).join("\n") || "No tracked tabs";
      if (!vscode.workspace.getConfiguration("workglance").get("notifications")) return;
      // A new scheduled digest: say so once, in the window you're using (every window polls).
      if (s.digest && s.digest.unread && vscode.window.state.focused && context.globalState.get("workglance.digestNotified") !== s.digest.id) {
        context.globalState.update("workglance.digestNotified", s.digest.id);
        vscode.window.showInformationMessage("Your Workglance digest is ready: everything since the previous one.", "Open digest")
          .then((pick) => { if (pick) vscode.env.openExternal(vscode.Uri.parse(base() + "/digest")); });
      }
      for (const t of s.live) {
        const key = `${t.live}@${t.since}`;
        if (notified.get(t.id) === key) continue;
        notified.set(t.id, key);
        if (t.live !== "question" && t.live !== "permission") continue;
        const what = t.live === "permission" ? "needs permission" : "asked you something";
        vscode.window.showWarningMessage(`${t.title || "A tab"} ${what}${t.detail ? `: ${t.detail}` : ""}`, "Open tab").then((pick) => { if (pick) openTabAnywhere(t.id); });
      }
    } catch {
      bar.text = "$(circle-slash) Workglance";
      bar.tooltip = "Workglance server is not answering; starting it.";
      if (++failures >= 2) ensureServer();
    }
  };
  // First pass only records what is already waiting: no burst of old notifications at startup.
  getJson("/api/status").then((s) => { for (const t of s.live) notified.set(t.id, `${t.live}@${t.since}`); }).catch(() => {}).finally(tick);
  const seconds = Math.max(2, vscode.workspace.getConfiguration("workglance").get("pollSeconds") || 4);
  const timer = setInterval(tick, seconds * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

function deactivate() {}

module.exports = { activate, deactivate };
