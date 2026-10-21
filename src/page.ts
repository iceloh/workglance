// Server-rendered HTML for the board. Everything user-written (prompts, titles, subjects) is escaped.
import { homedir } from "node:os";
import type { BoardStats, LiveTab, Stage, TabView, TaskCard, TaskDetail, TimelineItem, UndoneView } from "./report.ts";
import type { CostSummary } from "./cost.ts";
import type { Attention } from "./attention.ts";
import type { Hit } from "./search.ts";
import { byRepo, type Digest, type RepoGroup } from "./digest.ts";
import type { Metrics } from "./metrics.ts";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
/** A folder for display: a Claude worktree as "⎇ name", the home folder as "~", a long path as its last two parts. */
export function short(p: string, home = homedir()): string {
  const wt = p.match(/[\\/]\.claude[\\/]worktrees[\\/](.+)$/);
  if (wt) return `⎇ ${wt[1]}`;
  const h = home.replace(/[\\/]+$/, "");
  const underHome = !!h && p.length > h.length && p.toLowerCase().startsWith(h.toLowerCase()) && /[\\/]/.test(p.charAt(h.length));
  const shown = underHome ? `~${p.slice(h.length)}` : p;
  if (shown.length <= 40) return shown;
  const sep = p.includes("\\") ? "\\" : "/";
  const parts = shown.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…${sep}${parts.slice(-2).join(sep)}` : shown;
}
const STAGE: Record<Stage, string> = { done: "Done", testing: "Testing", in_progress: "In progress", local: "Local" };

/** A repo by name, as the repo filter shows and matches it: its folder's last part. */
export const repoName = (repo: string | null | undefined): string => repo ? repo.split(/[\\/]/).filter(Boolean).at(-1) ?? repo : "";
/** What the repo and tab filters match on, carried by each card (one value per line). */
const filterData = (repos: (string | null | undefined)[], tabs: string[]) =>
  ` data-repos="${esc([...new Set(repos.map(repoName).filter(Boolean))].join("\n").toLowerCase())}" data-tabs="${esc(tabs.join("\n"))}"`;

function tabCard(t: TabView): string {
  const name = t.title ? esc(t.title) : `<span class="muted">unnamed tab</span>`;
  const was = t.formerTitles.length ? `<div class="was">was: ${t.formerTitles.slice(0, 4).map(esc).join(" · ")}${t.formerTitles.length > 4 ? " …" : ""}</div>` : "";
  const places = t.places.slice(0, 4).map((p) => `<span class="chip" title="${esc(p.worktree)}">${esc(short(p.worktree))}${p.branch ? ` <b>${esc(p.branch)}</b>` : ""}</span>`).join("");
  const counts = { done: 0, testing: 0, in_progress: 0, local: 0 } as Record<Stage, number>;
  for (const c of t.commits) counts[c.stage]++;
  const summary = (Object.keys(counts) as Stage[]).filter((k) => counts[k]).map((k) => `<span class="badge ${k}">${counts[k]} ${STAGE[k]}</span>`).join("");
  const commits = t.commits.slice(0, 12).map((c) =>
    `<li><span class="badge ${c.stage}">${STAGE[c.stage]}</span> <code>${esc(c.sha.slice(0, 9))}</code> ${esc(c.subject)} <span class="muted">${esc(c.repo)} · ${when(c.at)}${c.copies > 1 ? " · rebased" : ""}</span></li>`).join("");
  const prompts = t.prompts.map((p) => `<li><span class="muted">${when(p.at)}</span> ${esc(p.text.length > 280 ? p.text.slice(0, 280) + "…" : p.text)}</li>`).join("");
  const text = [t.title, ...t.formerTitles, ...t.prompts.map((p) => p.text), ...t.commits.map((c) => c.subject), ...t.places.map((p) => p.worktree + " " + p.branch)].join(" ").toLowerCase();
  return `<article class="card" data-text="${esc(text)}"${filterData(t.places.map((p) => p.repo), [t.id])}>
  <header><h3>${name}</h3><span class="muted">${ago(t.lastAt)} · ${t.promptCount} prompts</span></header>
  ${was}
  <div class="places">${places}</div>
  ${summary ? `<div class="summary">${summary}</div>` : ""}
  ${t.tasks.length ? `<ul class="tasks">${t.tasks.map((k) => `<li><a href="/task/${k.id}"><span class="muted">W-${k.id}</span> ${esc(k.title)}</a> <span class="muted">${esc(STATUS_LABEL[k.status] ?? k.status)}</span></li>`).join("")}</ul>` : ""}
  ${commits ? `<details><summary>Commits (${t.commits.length})</summary><ul>${commits}</ul></details>` : ""}
  ${prompts ? `<details><summary>Latest prompts</summary><ul>${prompts}</ul></details>` : ""}
  <div class="id muted">${esc(t.id)}</div>
</article>`;
}

const COLUMNS: [string, string][] = [["planned", "Planned"], ["in_progress", "In progress"], ["testing", "Testing"], ["done", "Done"]];

function taskCard(t: TaskCard, live: Map<string, string> = new Map()): string {
  const commits = (Object.keys(t.commits) as Stage[]).filter((k) => t.commits[k]).map((k) => `<span class="badge ${k}">${t.commits[k]} ${STAGE[k]}</span>`).join("");
  // On open cards, a tab that is working (or waiting for you) right now gets a live dot next to its name.
  const tabs = t.tabs.map((s) => {
    const l = live.get(s.id);
    const dot = l && l !== "done" && (t.status === "in_progress" || t.status === "testing") ? `<span class="ldot ${esc(l)}" title="${esc(LIVE[l] ?? l)}"></span>` : "";
    return dot + esc(s.title ?? s.id.slice(0, 8));
  }).join(" · ");
  const text = [t.title, t.type, t.branch, t.worktree, ...t.tabs.map((s) => s.title), t.lastNote].join(" ").toLowerCase();
  const activity = [t.edits ? `${t.edits} edit${t.edits > 1 ? "s" : ""}` : "", money(t.cost), t.lastActivityAt ? `active ${ago(t.lastActivityAt)}` : ""].filter(Boolean).join(" · ");
  return `<article class="card task" draggable="true" data-id="${t.id}" data-status="${esc(t.status)}" data-text="${esc(text)}"${filterData([t.repo], t.tabs.map((s) => s.id))}>
  <header><h3><a href="/task/${t.id}"><span class="muted">W-${t.id}</span> ${esc(t.title)}</a></h3></header>
  ${t.unseen ? `<div class="unseen" title="Delivered on the tab's next prompt">● your change is not seen by the tab yet</div>` : ""}
  <div class="places"><span class="chip type">${esc(t.type)}</span>${t.worktree ? `<span class="chip" title="${esc(t.worktree)}">${esc(short(t.worktree))}${t.branch ? ` <b>${esc(t.branch)}</b>` : ""}</span>` : ""}</div>
  ${commits ? `<div class="summary">${commits}</div>` : ""}
  ${ciChips(t.ci)}
  ${t.warning ? `<div class="warn">⚠ ${esc(t.warning)}</div>` : ""}
  ${noteLine(t.status === "done" && t.result ? t.result : t.lastNote)}
  <div class="muted small">${tabs}${activity ? ` · ${activity}` : ""}</div>
</article>`;
}

/** A closed card shows its result (what changed, the findings), an open one its latest note. */
const noteLine = (s: string | null) => (s ? `<div class="note">${esc(s.length > 200 ? s.slice(0, 200) + "…" : s)}</div>` : "");

const CI_ICON: Record<string, string> = { passed: "✓", failed: "✗", running: "⟳", stopped: "■" };
function ciChips(ci: TaskCard["ci"]): string {
  if (!ci.length) return "";
  return `<div class="summary">${ci.map((c) => `<a class="ci ${esc(c.state)}" href="${esc(c.url)}" target="_blank" rel="noopener" title="${c.state === "passed" ? "went through this green pipeline" : `latest pipeline: ${c.state}`}">${esc(c.branch)} #${c.number} ${CI_ICON[c.state] ?? ""}</a>`).join("")}</div>`;
}

const STATUS_LABEL: Record<string, string> ={ planned: "Planned", in_progress: "In progress", testing: "Testing", done: "Done", dropped: "Dropped" };

export function renderTaskPage(d: TaskDetail): string {
  const commits = (Object.keys(d.commits) as Stage[]).filter((k) => d.commits[k]).map((k) => `<span class="badge ${k}">${d.commits[k]} ${STAGE[k]}</span>`).join("");
  const item = (i: TimelineItem) => {
    if (i.kind === "commit") return `<li class="tl commit"><span class="when">${when(i.at)}</span><span class="badge ${i.stage}">${STAGE[i.stage]}</span> <code>${esc(i.sha.slice(0, 9))}</code> ${esc(i.subject)} <span class="muted">${esc(i.repo)}</span></li>`;
    if (i.kind === "prompt") return `<li class="tl prompt"><span class="when">${when(i.at)}</span><span class="who">you → ${esc(i.tab ?? "tab")}</span> ${esc(i.text.length > 400 ? i.text.slice(0, 400) + "…" : i.text)}</li>`;
    const move = i.what === "status" ? `${STATUS_LABEL[i.from ?? ""] ?? i.from} → <b>${STATUS_LABEL[i.to ?? ""] ?? i.to}</b>` : i.what === "created" ? `created as <b>${STATUS_LABEL[i.to ?? ""] ?? i.to}</b>` : esc(i.what);
    return `<li class="tl event"><span class="when">${when(i.at)}</span><span class="who">${esc(i.actor === "user" ? "you" : i.tab ?? "agent")}</span> ${move}${i.note ? ` — ${esc(i.note)}` : ""}</li>`;
  };
  const edits = d.editsByWorktree.map((e) => `<span class="chip" title="${esc(e.worktree)}">${esc(short(e.worktree))} · ${e.n}</span>`).join("");
  return shell(`W-${d.id} ${d.title}`, `${topNav("")}
<main class="detail">
<h2><span class="muted">W-${d.id}</span> ${esc(d.title)}</h2>
<div class="places"><span class="chip type">${esc(d.type)}</span><span class="chip"><b>${esc(STATUS_LABEL[d.status] ?? d.status)}</b></span>
${d.worktree ? `<span class="chip" title="${esc(d.worktree)}">${esc(short(d.worktree))}${d.branch ? ` <b>${esc(d.branch)}</b>` : ""}${d.placeSource === "activity" ? "" : ` <span class="muted">(from the tab's folder)</span>`}</span>` : ""}${commits}</div>
${ciChips(d.ci)}
${d.warning ? `<div class="warn">⚠ ${esc(d.warning)}</div>` : ""}
<p class="muted">Tabs: ${d.tabs.map((s) => `<a href="${openTabUrl(s.id)}" title="Open in VS Code">${esc(s.title ?? s.id.slice(0, 8))}</a>`).join(" · ") || "none"} · created ${when(d.createdAt)}${d.closedAt ? ` · closed ${when(d.closedAt)}` : ""}
${d.cost.responses ? ` · model work while open: <b>${money(d.cost)}</b> (${d.cost.responses} responses, ${Math.round(d.cost.outputTokens / 1000)}k output tokens)` : ""}</p>
${d.unseen ? `<div class="unseen">● your latest change is not seen by the tab yet — it is delivered on the tab's next prompt</div>` : ""}
<div class="actions">${(["planned", "in_progress", "testing", "done", "dropped"] as const).filter((s) => s !== d.status)
    .map((s) => `<button class="btn${s === "dropped" ? " danger" : ""}" onclick="moveTo(${d.id},'${s}','${esc(d.status)}')">${s === "dropped" ? "Drop" : `Move to ${STATUS_LABEL[s]}`}</button>`).join("")}</div>
<form class="comment" onsubmit="return comment(${d.id}, this)"><textarea name="note" rows="2" placeholder="Comment for the tab (it reads this on its next prompt)…" required></textarea><button class="btn">Comment</button></form>
${d.description ? `<h3>Description</h3><p class="pre">${esc(d.description)}</p>` : ""}
${d.result ? `<h3>Result</h3><p class="pre">${esc(d.result)}</p>` : ""}
${edits ? `<h3>Where the work happened</h3><div class="places">${edits}</div>` : ""}
<h3>Changes</h3>
<div id="review" data-task="${d.id}"><button class="btn" onclick="loadDiff(${d.id})">Show the task's changes</button>
<span class="muted small">Click a line to comment; all comments go to the tab as one message.</span></div>
<h3>Timeline</h3><ul class="timeline">${d.timeline.map(item).join("")}</ul>
</main>
<script>${BOARD_JS}</script>`);
}

function board(tasks: TaskCard[], live: Map<string, string>): string {
  if (!tasks.length) return `<div class="empty">No tasks yet. Tabs register their main work as they go.</div>`;
  return `<div class="board">${COLUMNS.map(([k, label]) => {
    const col = tasks.filter((t) => t.status === k);
    return `<section class="col" data-status="${k}"><h4>${label} <span class="muted n">${col.length}</span></h4>${col.map((t) => taskCard(t, live)).join("")}</section>`;
  }).join("")}</div>`;
}

function undoneRow(u: UndoneView): string {
  const what = [u.dirty ? `${u.dirty} uncommitted file${u.dirty > 1 ? "s" : ""}` : "", u.ahead ? `${u.ahead} commit${u.ahead > 1 ? "s" : ""} not pushed` : ""].filter(Boolean).join(" · ");
  return `<tr class="undone"${filterData([u.repo], [])}><td>${esc(u.repo)}</td><td title="${esc(u.path)}">${esc(short(u.path))}</td><td><b>${esc(u.branch ?? "")}</b></td><td>${what}${u.upstream ? "" : ` <span class="muted">(no upstream)</span>`}</td>
  <td>${u.lastTab ? `${esc(u.lastTab.title ?? "unnamed tab")} <span class="muted">${ago(u.lastTab.at)}</span>` : `<span class="muted">no tab</span>`}</td>
  <td><button class="mini" data-path="${esc(u.path)}" onclick="untrackPath(this)" title="Workglance stops looking at this folder: no cards, nudges or git checks. Undo in Settings.">Untrack</button></td></tr>`;
}

export type Health = { tracked: number; nudges: number; noiseHidden: boolean };

/**
 * "API est. $4.20": what the work would cost at API list prices. Labelled so it never reads as a bill:
 * on a Claude subscription nothing is charged per token (it uses the plan's limits).
 */
export function money(c: CostSummary): string {
  if (!c.responses) return "";
  const v = `$${c.usd >= 100 ? c.usd.toFixed(0) : c.usd.toFixed(2)}${c.unpriced ? "+" : ""}`;
  return `<span class="est" title="Estimated at API list prices. On a Claude subscription this is effort, not your bill.">API est. ${v}</span>`;
}

function topNav(active: string, extra = ""): string {
  const link = (href: string, key: string, label: string) => `<a href="${href}" class="${active === key ? "on" : ""}">${label}</a>`;
  return `<div class="top"><h1><a href="/">Workglance</a></h1><nav class="ranges">${link("/", "board", "Board")}${link("/digest", "digest", digestUnread ? `Digest <span class="newdot" title="A new digest is ready"></span>` : "Digest")}${link("/metrics", "metrics", "Metrics")}${link("/settings", "settings", "Settings")}</nav>
<form action="/search" class="searchform"><input name="q" placeholder="Search everything: prompts, tasks, results, commits…" autocomplete="off"></form>${extra}</div>`;
}

function attentionPanel(items: Attention[]): string {
  if (!items.length) return "";
  return `<h2>Needs attention <span class="badge needs">${items.length}</span></h2><div class="livelist">${items.slice(0, 12).map((a) =>
    `<div class="live attention"><span class="dot"></span><a href="${esc(a.href)}">${esc(a.text)}</a><span class="acts">
      <button class="mini" data-key="${esc(a.key)}" onclick="dismissItem(this, 7)" title="Hide for 7 days">Snooze 7d</button>
      <button class="mini" data-key="${esc(a.key)}" onclick="dismissItem(this, 0)" title="Hide for good (comes back only if the situation changes)">Dismiss</button>
      ${a.path ? `<button class="mini" data-path="${esc(a.path)}" onclick="untrackPath(this)" title="Workglance stops looking at this folder: no cards, nudges or git checks. Undo in Settings.">Untrack repo</button>` : ""}
    </span></div>`).join("")}${items.length > 12 ? `<div class="muted small">… ${items.length - 12} more</div>` : ""}</div>`;
}

/** The summary languages offered in Settings (any other one can still be set in config.json). */
export const LANGUAGES = ["English", "Portuguese (Brazil)", "Portuguese (Portugal)", "Spanish", "French", "German", "Italian", "Dutch",
  "Polish", "Russian", "Ukrainian", "Turkish", "Arabic", "Hebrew", "Hindi", "Indonesian", "Vietnamese", "Japanese", "Korean",
  "Chinese (Simplified)", "Chinese (Traditional)"];

const timeChip = (t: string) => `<span class="timechip"><input type="time" value="${esc(t)}" required aria-label="Digest time"><button type="button" class="x" title="Remove this time" onclick="removeTime(this)">×</button></span>`;

export function renderSettingsPage(untracked: string[], digest: { times: string[]; summary: boolean; language: string } = { times: ["08:00"], summary: true, language: "" }): string {
  const langs = digest.language && !LANGUAGES.includes(digest.language) ? [digest.language, ...LANGUAGES] : LANGUAGES;
  return shell("Settings", `${topNav("settings")}<main class="detail settings">
<h2>Settings</h2>
<section class="panel">
<h3>Digest</h3>
<p class="muted">At each of these times Workglance writes a digest of everything since the previous one: what got done, what waits for you, commits, model work. If the computer was off, one digest covers the whole gap.</p>
<form onsubmit="return saveDigest(this)">
<div class="field"><span class="label">Times</span><div class="fieldbody"><div class="times" id="times">${digest.times.map(timeChip).join("")}</div>
<div class="row"><button type="button" class="mini" id="addtime" onclick="addTime()">+ Add a time</button><span class="muted small">up to 6 a day</span></div></div></div>
<div class="field"><label class="label" for="language">Summary language</label><div class="fieldbody"><select id="language" name="language">
<option value=""${digest.language ? "" : " selected"}>Automatic: the language of your cards</option>
${langs.map((l) => `<option${l === digest.language ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></div></div>
<div class="field"><span class="label">Summary</span><div class="fieldbody"><label class="check"><input type="checkbox" name="summary"${digest.summary ? " checked" : ""}> Write one with <code>claude -p</code> when each digest is made</label>
<div class="muted small">Runs once per digest on your Claude subscription; nothing is sent anywhere else.</div></div></div>
<div class="formactions"><button class="btn primary">Save</button><span class="small" id="digeststatus"></span></div>
</form>
</section>
<section class="panel">
<h3>Untracked folders</h3>
<p class="muted">Workglance doesn't look at these: tabs working there get no protocol, cards or nudges, nothing from them is stored, and no git command runs there. Their cards stay.</p>
<input id="foldersearch" type="search" placeholder="Search the folders your tabs worked in, or paste a path" autocomplete="off" oninput="showFolders()" onfocus="showFolders()">
<div id="folderresults" class="folderlist"></div>
<h4>Untracked now <span class="muted">${untracked.length}</span></h4>
${untracked.length ? `<div class="folderlist">${untracked.map((p) => `<div class="folderrow"><div class="what"><code>${esc(p)}</code></div><button class="mini" data-path="${esc(p)}" onclick="retrackPath(this)">Track again</button></div>`).join("")}</div>` : `<div class="muted small">None. Everything your tabs work on is tracked.</div>`}
</section>
</main><script>${BOARD_JS}
const MAXTIMES=6;
function timeInputs(){return [...document.querySelectorAll("#times input")]}
function syncTimes(){const n=timeInputs().length;document.getElementById("addtime").disabled=n>=MAXTIMES;
  document.querySelectorAll("#times .x").forEach(b=>{b.disabled=n<=1;b.title=n<=1?"At least one time":"Remove this time"})}
function addTime(){if(timeInputs().length>=MAXTIMES)return;const c=el("span","timechip"),i=el("input");i.type="time";i.required=true;i.value="18:00";
  const x=el("button","x","×");x.type="button";x.onclick=()=>removeTime(x);c.append(i,x);document.getElementById("times").append(c);i.focus();syncTimes()}
function removeTime(b){if(timeInputs().length>1)b.parentElement.remove();syncTimes()}
async function saveDigest(f){const s=document.getElementById("digeststatus");
  const times=timeInputs().map(i=>i.value).filter(Boolean);
  const r=await fetch("/api/settings/digest",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({times,summary:f.summary.checked,language:f.language.value})}).catch(()=>null);
  const j=r?await r.json().catch(()=>({})):{};
  if(!r||!r.ok){s.className="small err";s.textContent="Not saved: "+(j.error||"the local server didn't answer");return false}
  const box=document.getElementById("times");box.textContent="";for(const t of j.times){const c=el("span","timechip"),i=el("input"),x=el("button","x","×");i.type="time";i.required=true;i.value=t;x.type="button";x.onclick=()=>removeTime(x);c.append(i,x);box.append(c)}
  syncTimes();s.className="small ok";s.textContent="Saved: digests at "+j.times.join(", ")+" · summary "+(j.summary?(j.language?"in "+j.language:"in your cards' language"):"off");return false}
syncTimes();
// Folder search: the list comes once from the server; rows are built with textContent only.
let folders=null;
const ago=(iso)=>{const h=(Date.now()-Date.parse(iso))/3600e3,d=Math.round(h/24);return h<1?"in the last hour":h<24?Math.round(h)+" h ago":d===1?"yesterday":d+" days ago"};
async function showFolders(){if(!folders){folders=[];folders=await fetch("/api/folders").then(r=>r.json()).catch(()=>[])}
  const q=document.getElementById("foldersearch").value.trim(),box=document.getElementById("folderresults");box.textContent="";
  const ql=q.toLowerCase(),hits=folders.filter(f=>!ql||f.path.toLowerCase().includes(ql)||f.name.toLowerCase().includes(ql)).slice(0,8);
  for(const f of hits)box.append(folderRow(f.name,f.path,(f.repo?"repo":"folder")+" · last used "+ago(f.lastAt)+" · "+f.tabs+" tab"+(f.tabs===1?"":"s")));
  if(/^([a-zA-Z]:[\\\\/]|\\/)/.test(q)&&!folders.some(f=>f.path.toLowerCase()===ql))box.append(folderRow("Untrack this path",q,"not seen in your tabs yet"));
  if(q&&!box.children.length)box.append(el("div","muted small","No folder your tabs worked in matches. Paste the full path to untrack another one."))}
function folderRow(name,path,meta){const row=el("div","folderrow"),what=el("div","what");what.append(el("b",null,name),el("code",null,path),el("div","muted small",meta));
  const b=el("button","mini","Untrack");let armed=false;
  b.onclick=async()=>{if(!armed){armed=true;b.className="mini danger";b.textContent="Click again to untrack";what.lastChild.textContent="Stops tracking it and forgets what was stored about it; its cards stay. You can undo it below.";return}
    b.disabled=true;const r=await fetch("/api/untrack",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({path})}).catch(()=>null);
    if(r&&r.ok)location.reload();else{const j=r?await r.json().catch(()=>({})):{};what.lastChild.className="small err";what.lastChild.textContent="Not untracked: "+(j.error||"the local server didn't answer");b.disabled=false}};
  row.append(what,b);return row}</script>`);
}

export function renderSearchPage(q: string, hits: Hit[], titles: Map<string, string | null>): string {
  const KIND: Record<string, string> = { prompt: "you asked", task: "task", note: "note", commit: "commit" };
  const hit = (h: Hit) => {
    const snippet = esc(h.snippet).replace(/\[\[/g, "<mark>").replace(/\]\]/g, "</mark>");
    const target = h.taskId ? `/task/${h.taskId}` : h.sessionId ? openTabUrl(h.sessionId) : "";
    const tab = h.sessionId ? esc(titles.get(h.sessionId) ?? h.sessionId.slice(0, 8)) : "";
    return `<li class="hit"><span class="badge local">${KIND[h.kind]}</span> ${target ? `<a href="${esc(target)}">${esc(h.kind === "commit" ? h.ref.slice(0, 9) : h.ref.startsWith("W-") ? h.ref : "")}</a>` : ""}
      <span class="muted">${tab} · ${when(h.at)}</span><div class="snip">${snippet}</div></li>`;
  };
  return shell(`Search: ${q}`, `${topNav("search")}<main class="detail"><h2>${hits.length} result${hits.length === 1 ? "" : "s"} for “${esc(q)}”</h2>
<ul class="hits">${hits.map(hit).join("") || `<li class="muted">Nothing found.</li>`}</ul></main>`);
}

type EvalRun = { at: string; model: string; results: { name: string; pass: boolean; failures: string[]; warnings: string[]; costUsd: number }[] };

export function renderMetricsPage(m: Metrics, ev: EvalRun | null, range: string, ranges: string[]): string {
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
  const tasksList = (items: { id: number; title: string }[]) => items.length ? `<ul>${items.map((t) => `<li><a href="/task/${t.id}"><span class="muted">W-${t.id}</span> ${esc(t.title)}</a></li>`).join("")}</ul>` : `<div class="muted">none</div>`;
  const stat = (label: string, value: string, hint: string) => `<div class="stat"><div class="v">${value}</div><div class="l">${esc(label)}</div><div class="muted small">${esc(hint)}</div></div>`;
  const evals = ev ? `<p class="muted">Last run ${when(ev.at)} · model ${esc(ev.model)} · <b>${ev.results.filter((r) => r.pass).length}/${ev.results.length} passed</b> · $${ev.results.reduce((a, r) => a + r.costUsd, 0).toFixed(2)}</p>
<table>${ev.results.map((r) => `<tr><td><span class="badge ${r.pass ? "done" : "in_progress"}">${r.pass ? "PASS" : "FAIL"}</span></td><td><b>${esc(r.name)}</b>${[...r.failures.map((f) => `<div class="warn">${esc(f)}</div>`), ...r.warnings.map((w) => `<div class="muted small">warn: ${esc(w)}</div>`)].join("")}</td><td class="muted">$${r.costUsd.toFixed(2)}</td></tr>`).join("")}</table>`
    : `<p class="muted">No eval run yet. Run <code>workglance eval</code> (real model usage, ~$1–3).</p>`;
  return shell("Metrics", `${topNav("metrics", `<nav class="ranges">${ranges.map((r) => `<a href="/metrics?range=${r}" class="${r === range ? "on" : ""}">${r}</a>`).join("")}</nav>`)}<main class="detail">
<h2>Is the protocol working? <span class="muted small">since ${when(m.since === "0000" ? new Date(0).toISOString() : m.since)}</span></h2>
<div class="stats">
${stat("of your tabs' commits linked to a task", pct(m.commits.linked, m.commits.total), `${m.commits.linked} of ${m.commits.total}`)}
${stat("nudges followed by a task", pct(m.nudges.linked, m.nudges.linked + m.nudges.declined), `${m.nudges.linked} linked · ${m.nudges.declined} declined · ${m.nudges.pending} pending`)}
${stat("cards created", String(m.tasks.created), `${m.tasks.done} closed`)}
</div>
<h3>Closed without a result (${m.tasks.doneWithoutResult.length})</h3>${tasksList(m.tasks.doneWithoutResult)}
<h3>Investigations whose result isn't findings (${m.tasks.thinInvestigations.length})</h3>${tasksList(m.tasks.thinInvestigations)}
<h3>Probably not real tasks: closed in minutes, no edit, no commit (${m.tasks.quickEmpty.length})</h3>${tasksList(m.tasks.quickEmpty)}
<h3>Per tab</h3>${m.perTab.length ? `<table><tr><td></td><td class="muted">cards</td><td class="muted">commits</td><td class="muted">linked</td></tr>${m.perTab.map((t) => `<tr><td><a href="${openTabUrl(t.id)}">${esc(t.title ?? t.id.slice(0, 8))}</a></td><td>${t.tasks}</td><td>${t.commits}</td><td>${pct(t.linkedCommits, t.commits)}</td></tr>`).join("")}</table>` : `<div class="muted">—</div>`}
<h2>Protocol evals</h2>${evals}
</main>`);
}

/** How a digest page is labelled and navigated: a scheduled digest (previous slot -> this one) or a calendar day. */
export type DigestView = {
  heading: string; window: string; prev: string | null; next: string | null;
  /** What "Summarize with Claude" posts to /api/digest/summary: {id} for a scheduled digest, {date} for a day. */
  summarize: Record<string, string>; note?: string;
  /** On the latest digest: offer a new one covering from its end ("since") to now. */
  fresh?: { since: string };
};

export function renderDigestPage(d: Digest, summary: string | null, v: DigestView): string {
  const groups = byRepo(d);
  const cardLink = (t: { id: number; title: string }) => `<a href="/task/${t.id}"><span class="muted">W-${t.id}</span> ${esc(t.title)}</a>`;
  // A result shows its first sentence; the rest opens on click.
  const result = (r: string | null) => {
    if (!r) return "";
    const first = r.replace(/\s+/g, " ").match(/^.{1,160}?[.!?](\s|$)/)?.[0]?.trim() ?? r.slice(0, 160);
    return first.length >= r.trim().length ? `<div class="muted small">${esc(r)}</div>`
      : `<details class="res"><summary class="muted small">${esc(first)}</summary><div class="muted small">${esc(r)}</div></details>`;
  };
  const block = (label: string, items: string[]) => items.length ? `<h4>${label} <span class="muted">${items.length}</span></h4><ul>${items.join("")}</ul>` : "";
  const counts = (g: RepoGroup) => [g.closed.length && `${g.closed.length} done`, g.toTesting.length && `${g.toTesting.length} to testing`,
    g.started.length && `${g.started.length} started`, g.created.length && `${g.created.length} new`, g.commits && `${g.commits} commit${g.commits === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
  const section = (g: RepoGroup) => `<section class="repo"><h3>${esc(g.repo)} <span class="muted small">${counts(g)}</span></h3>
${block("Done", g.closed.map((t) => `<li>${cardLink(t)} <span class="chip type">${esc(t.type)}</span>${result(t.result)}</li>`))}
${block("Moved to testing", g.toTesting.map((t) => `<li>${cardLink(t)}</li>`))}
${block("Started", g.started.map((t) => `<li>${cardLink(t)}</li>`))}
${block("New cards", g.created.map((t) => `<li>${cardLink(t)} <span class="muted small">${esc(t.status.replace("_", " "))}</span></li>`))}
${!g.closed.length && !g.toTesting.length && !g.started.length && !g.created.length ? `<div class="muted small">Commits only.</div>` : ""}</section>`;
  const needs = d.testingNow.length ? `<section class="repo needs"><h3>Needs you <span class="muted small">${d.testingNow.length} waiting for your verification</span></h3>
<ul>${d.testingNow.map((t) => `<li>${cardLink(t)} <span class="chip">${esc(t.repo)}</span></li>`).join("")}</ul></section>` : "";
  const total = [d.closed.length && `${d.closed.length} done`, d.commits.reduce((n, c) => n + c.n, 0) && `${d.commits.reduce((n, c) => n + c.n, 0)} commits`,
    d.tabs.length && `${d.tabs.length} tabs`].filter(Boolean).join(" · ");
  return shell(v.heading, `${topNav("digest")}<main class="detail">
<h2>${esc(v.heading)} <span class="small">${v.prev ? `<a href="${esc(v.prev)}">← previous</a>` : ""}${v.prev && v.next ? " · " : ""}${v.next ? `<a href="${esc(v.next)}">next →</a>` : ""}</span></h2>
<p class="muted">${esc(v.window)}${v.note ? ` · ${esc(v.note)}` : ""}${total ? ` · ${total}` : ""}${d.total.usd ? ` · ${money(d.total)}` : ""}</p>
${v.fresh ? `<div class="newdigest"><button class="btn primary" onclick="newDigest(this)">New digest: what you did since ${esc(v.fresh.since)}</button> <span class="small muted" id="newstatus">The next scheduled one starts from there.</span></div>` : ""}
<div class="digestsum" id="summary">${summary ? summaryHtml(summary) : ""}
<div class="small">${summary ? `<button class="mini" onclick='summarize(${esc(JSON.stringify(v.summarize))})'>Rewrite summary (same period)</button>` : `<button class="btn" onclick='summarize(${esc(JSON.stringify(v.summarize))})'>Summarize with Claude</button>`} <span class="muted small">runs <code>claude -p</code> once on your subscription; nothing is sent anywhere else</span></div></div>
${needs}
${groups.length ? groups.map(section).join("") : `<div class="empty">Nothing happened in this period.</div>`}
<details class="repo"><summary><b>Tabs · model work</b> ${money(d.total) || "—"} <span class="muted small">(API list prices; on a subscription this is effort, not your bill)</span></summary>
${d.tabs.length ? `<table>${d.tabs.map((t) => `<tr><td><a href="${openTabUrl(t.id)}">${esc(t.title ?? t.id.slice(0, 8))}</a></td><td>${t.prompts} prompts</td><td>${money(t.cost)}</td></tr>`).join("")}</table>` : `<div class="muted">No activity.</div>`}</details>
<p class="muted small">Digests are written at the times set in <a href="/settings">Settings</a>; each one covers everything since the previous one. <a href="/digest?date=${todayISO()}">Calendar days →</a></p>
</main>
<script>${BOARD_JS}
async function summarize(body){const box=document.getElementById("summary");box.textContent="Asking Claude… (up to a minute)";
  const r=await fetch("/api/digest/summary",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  const j=await r.json().catch(()=>({}));if(r.ok)location.reload();else box.textContent="Could not summarize: "+(j.error||r.status)}
async function newDigest(b){const s=document.getElementById("newstatus");b.disabled=true;s.className="small muted";s.textContent="Writing the digest… the summary takes up to a minute.";
  const r=await fetch("/api/digest/now",{method:"POST",headers:{"content-type":"application/json"},body:"{}"}).catch(()=>null);
  const j=r?await r.json().catch(()=>({})):{};
  if(!r||!r.ok){s.className="small err";s.textContent="Not created: "+(j.error||"the local server didn't answer. Try again in a few seconds.");b.disabled=false;return}
  location.href="/digest?id="+encodeURIComponent(j.id)}</script>`);
}

/** The summary in its parts (overview, one per repo, "needs you"): a part that starts with "Name:" gets the name in bold. */
export function summaryHtml(text: string): string {
  return text.split(/\n\s*\n|\n(?=[^\s:]{1,40}:\s)/).map((part) => part.trim()).filter(Boolean).map((part) => {
    const m = part.match(/^([^:\n]{1,40}):\s+([\s\S]*)$/);
    return m ? `<p><b>${esc(m[1]!)}:</b> ${esc(m[2]!)}</p>` : `<p>${esc(part)}</p>`;
  }).join("");
}

const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

/** A digest that hasn't been opened yet puts a dot on the Digest link (set by the server before rendering). */
let digestUnread = false;
export function setDigestUnread(v: boolean): void { digestUnread = v; }

const LIVE: Record<string, string> = { permission: "needs permission", question: "asked you", working: "working", done: "your turn" };
/** Opens that exact session in the Claude Code VS Code extension (its own vscode:// handler). */
export const openTabUrl = (sessionId: string) => `vscode://anthropic.claude-code/open?session=${encodeURIComponent(sessionId)}`;

/** One tab in the rail: dot, name, age; what it's on (and why it waits) only when it's busy or needs you. */
function railRow(t: LiveTab): string {
  const busy = t.live !== "done";
  const tip = ["Open in VS Code", LIVE[t.live] ?? t.live, t.detail, ...t.tasks.map((k) => `W-${k.id} ${k.title}`)].filter(Boolean).join("\n");
  const line = [busy ? LIVE[t.live] ?? t.live : "", t.tasks[0] ? `W-${t.tasks[0].id}` : ""].filter(Boolean).join(" · ");
  return `<a class="rtab ${esc(t.live)}" href="${openTabUrl(t.id)}" title="${esc(tip)}"><span class="dot"></span><span class="rname">${esc(t.title ?? t.id.slice(0, 8))}</span><span class="rage">${esc(ago(t.since).replace(/ ago$/, ""))}</span>${busy && line ? `<span class="rstate">${esc(line)}</span>` : ""}</a>`;
}

/** Live tabs as a sticky rail beside the board: needs you, then working, then idle. */
function rail(tabs: LiveTab[]): string {
  const needs = tabs.filter((t) => t.live === "question" || t.live === "permission");
  const working = tabs.filter((t) => t.live === "working");
  const idle = tabs.filter((t) => !needs.includes(t) && !working.includes(t));
  const group = (label: string, list: LiveTab[], cls = "") => list.length ? `<div class="rgroup ${cls}"><h5>${label} <span>${list.length}</span></h5>${list.map(railRow).join("")}</div>` : "";
  return `<aside class="rail"><h4>Tabs</h4>${tabs.length ? group("Needs you", needs, "needs") + group("Working", working) + group("Idle", idle) : `<div class="muted small">No open tabs.</div>`}</aside>`;
}

const PERIOD: Record<string, string> = { today: "Today", "7d": "Last 7 days", "30d": "Last 30 days", all: "All time" };
const dollars = (n: number) => `$${n >= 100 ? Math.round(n).toLocaleString("en-US") : n.toFixed(2)}`;

/** The micro dashboard: the chosen period at a glance. Open work counts as of now. */
function statsStrip(s: BoardStats, range: string): string {
  const item = (v: string | number, label: string, title = "") => `<div class="mstat"${title ? ` title="${esc(title)}"` : ""}><b>${v}</b><span>${label}</span></div>`;
  return `<div class="ministats"><span class="mlabel">${esc(PERIOD[range] ?? range)}</span>
${item(s.created, s.created === 1 ? "card" : "cards", "Cards created in this period")}${item(s.done, "done", "Cards closed as done in this period")}${item(s.inProgress, "in progress", "Right now")}${item(s.testing, "testing", "Right now")}
${item(`<span class="est">${dollars(s.costUsd)}</span>`, "API est.", `All tabs' model work in this period at API list prices. On a Claude subscription this is effort, not your bill.${s.unpriced ? ` ${s.unpriced} responses from unpriced models are not counted.` : ""}`)}${item(s.tabs, s.tabs === 1 ? "tab" : "tabs", "Tabs that got a prompt in this period")}${item(s.prompts, "prompts")}${item(s.commits, "commits", "Your commits in this period")}</div>`;
}

export function renderPage(v: { stats: BoardStats; live: LiveTab[]; attention: Attention[]; tasks: TaskCard[]; tabs: TabView[]; undone: UndoneView[]; range: string; ranges: string[]; version: number; git: { at: number; running: boolean; error: string | null }; health: Health }): string {
  const rangeLinks = v.ranges.map((r) => `<a href="/?range=${r}" class="period${r === v.range ? " on" : ""}">${r}</a>`).join("");
  const gitNote = v.git.running ? "checking git…" : v.git.at ? `git checked ${ago(new Date(v.git.at).toISOString())}` : "git not checked yet";
  const health = `${v.health.tracked} tab${v.health.tracked === 1 ? "" : "s"} tracked · ${v.health.nudges} nudge${v.health.nudges === 1 ? "" : "s"} sent`;
  // The filters offer what is on this page: repos of its cards, tabs and worktrees; tabs, most recent first.
  const repos = [...new Set([...v.tasks.map((t) => t.repo), ...v.tabs.flatMap((t) => t.places.map((p) => p.repo)), ...v.undone.map((u) => u.repo)]
    .map(repoName).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const tabOpts = new Map<string, string>();
  for (const t of [...v.tabs, ...v.tasks.flatMap((k) => k.tabs)]) if (!tabOpts.has(t.id)) tabOpts.set(t.id, t.title ?? t.id.slice(0, 8));
  const filters = `<select id="frepo" class="filter" aria-label="Filter by repo"><option value="">All repos</option>${repos.map((r) => `<option value="${esc(r.toLowerCase())}">${esc(r)}</option>`).join("")}</select>
<select id="ftab" class="filter" aria-label="Filter by tab"><option value="">All tabs</option>${[...tabOpts].map(([id, title]) => `<option value="${esc(id)}">${esc(title)}</option>`).join("")}</select>`;
  return shell("Workglance", `${topNav("board", `<input id="q" placeholder="Filter this page…" autocomplete="off">${filters}<nav class="ranges">${rangeLinks}</nav><span class="muted">${gitNote}${v.git.error ? " · <b>git error</b>" : ""} · ${health}</span>`)}
<div class="layout">${rail(v.live)}<main>
${statsStrip(v.stats, v.range)}
${attentionPanel(v.attention)}
<h2>Work <span class="muted" id="worktotal" data-n="${v.tasks.length}">(${v.tasks.length} tasks)</span></h2>
${board(v.tasks, new Map(v.live.map((t) => [t.id, t.live])))}
<h2 id="undone">Still undone <span class="muted">(${v.undone.length} worktrees with uncommitted or unpushed work)</span></h2>
${v.undone.length ? `<table>${v.undone.map(undoneRow).join("")}</table>` : `<div class="empty">Nothing uncommitted or unpushed.</div>`}
<h2>Tabs <span class="muted">(${v.tabs.length})</span> <a class="small" href="/?range=${v.range}${v.health.noiseHidden ? "&noise=1" : ""}">${v.health.noiseHidden ? "show" : "hide"} unnamed one-prompt sessions</a></h2>
<div class="grid">${v.tabs.map(tabCard).join("") || `<div class="empty">No tabs in this period.</div>`}</div>
</main></div>
<script>
const q=document.getElementById("q"),fr=document.getElementById("frepo"),ft=document.getElementById("ftab");
// Repo and tab filters live in the URL: they survive the auto-reload and a change of period.
const params=new URLSearchParams(location.search);fr.value=params.get("repo")||"";ft.value=params.get("tab")||"";
function applyFilters(){const s=q.value.trim().toLowerCase(),r=fr.value,t=ft.value;
  const has=(e,k,x)=>(e.dataset[k]||"").split("\\n").includes(x);
  for(const c of document.querySelectorAll(".card,tr.undone"))c.style.display=(!s||!("text" in c.dataset)||c.dataset.text.includes(s))&&(!r||has(c,"repos",r))&&(!t||has(c,"tabs",t))?"":"none";
  for(const col of document.querySelectorAll(".col[data-status]"))col.querySelector(".n").textContent=[...col.querySelectorAll(".task")].filter(c=>c.style.display!=="none").length;
  const wt=document.getElementById("worktotal");if(wt){const all=Number(wt.dataset.n),shown=[...document.querySelectorAll(".task")].filter(c=>c.style.display!=="none").length;wt.textContent="("+(shown===all?all:shown+" of "+all)+" tasks)"}
  fr.classList.toggle("on",!!r);ft.classList.toggle("on",!!t);
  const keep=(u)=>{r?u.searchParams.set("repo",r):u.searchParams.delete("repo");t?u.searchParams.set("tab",t):u.searchParams.delete("tab");return u};
  history.replaceState(null,"",keep(new URL(location.href)));for(const a of document.querySelectorAll("a.period"))a.href=keep(new URL(a.href))}
q.addEventListener("input",applyFilters);fr.addEventListener("change",applyFilters);ft.addEventListener("change",applyFilters);applyFilters();
let v=${v.version};
setInterval(async()=>{try{const r=await fetch("/api/version");const j=await r.json();if(j.version!==v&&document.activeElement!==q&&!(document.activeElement&&document.activeElement.tagName==="SELECT")&&!document.querySelector("details[open]")&&!dragging)location.reload()}catch{}},20000);
let dragging=null;
for(const c of document.querySelectorAll(".task[draggable]")){
  c.addEventListener("dragstart",(e)=>{dragging=c;e.dataTransfer.setData("text/plain",c.dataset.id);c.classList.add("dragging")});
  c.addEventListener("dragend",()=>{c.classList.remove("dragging");dragging=null});
}
for(const col of document.querySelectorAll(".col[data-status]")){
  col.addEventListener("dragover",(e)=>{if(dragging&&dragging.dataset.status!==col.dataset.status){e.preventDefault();col.classList.add("over")}});
  col.addEventListener("dragleave",()=>col.classList.remove("over"));
  col.addEventListener("drop",(e)=>{e.preventDefault();col.classList.remove("over");if(dragging)moveTo(Number(dragging.dataset.id),col.dataset.status,dragging.dataset.status)});
}
${BOARD_JS}
</script>`, v.live.filter((t) => t.live === "question" || t.live === "permission").length);
}

/**
 * Browser side of the board actions. Moving a card backwards (or dropping it) asks why: that reason is
 * what the tab will act on. The server enforces the same rule; this only asks before sending.
 */
export const BOARD_JS = `
const ORDER={planned:0,in_progress:1,testing:2,done:3,dropped:4};
async function send(url,body){const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  if(!r.ok){const j=await r.json().catch(()=>({}));alert(j.error||"Could not save");return false}return true}
async function moveTo(id,to,from){let note;
  if(to==="dropped"||ORDER[to]<ORDER[from]){note=prompt(to==="dropped"?"Why drop it? The tab will read this.":"Why move it back? The tab will read this.");if(!note||!note.trim())return}
  if(await send("/api/tasks/"+id+"/move",{status:to,note}))location.reload()}
// A vscode:// link lands in the last focused VS Code window, which may not have that tab (it opens a blank
// one). So the server hands the click to the window that has the tab's folder. When none can, our own dialog
// says why; "open in the last window" goes through the server too, never through the browser's
// "Open Visual Studio Code?" prompt.
const openTab=(session,force)=>fetch("/api/open",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({session,force})}).then(r=>r.json()).catch(()=>({reason:"server"}));
function tabDialog(session,r){let d=document.getElementById("tabdlg");if(d)d.remove();d=el("dialog");d.id="tabdlg";
  const title=r.reason==="no_windows"?"VS Code isn't connected yet":r.reason==="no_match"?"This tab's window isn't open":"Workglance isn't answering";
  const text=r.reason==="no_windows"?"Run “Developer: Reload Window” once in each VS Code window. After that, clicking a tab opens it in the right window."
    :r.reason==="no_match"?"No open VS Code window has this folder:":"The local server didn't answer. It restarts by itself; try again in a few seconds.";
  d.append(el("h3",null,title),el("p",null,text));if(r.reason==="no_match"&&r.cwd)d.append(el("code",null,r.cwd));
  const row=el("div","dlgactions"),cancel=el("button","btn","Cancel");cancel.onclick=()=>d.close();
  if(r.reason!=="server"){const go=el("button","btn primary","Open in the last VS Code window");go.onclick=async()=>{d.close();await openTab(session,true)};go.autofocus=true;row.append(cancel,go)}else row.append(cancel);
  d.append(row);d.addEventListener("click",(e)=>{if(e.target===d)d.close()});d.addEventListener("close",()=>d.remove());document.body.append(d);d.showModal()}
document.addEventListener("click",async(e)=>{const a=e.target.closest&&e.target.closest('a[href^="vscode://anthropic.claude-code/open"]');
  if(!a)return;e.preventDefault();const s=new URL(a.href).searchParams.get("session");const r=await openTab(s,false);if(!r.ok)tabDialog(s,r)});
// Review: the diff is built with textContent only (never innerHTML): file contents can't inject anything.
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e};
const review=[];
async function loadDiff(id){const box=document.getElementById("review");box.textContent="Loading…";
  const sections=await (await fetch("/api/tasks/"+id+"/diff")).json();box.textContent="";
  if(!sections.length){box.append(el("div","muted","No commits or uncommitted changes for this task yet."));return}
  for(const s of sections){box.append(el("h4","diffsec",(s.sha?s.sha.slice(0,9)+"  ":"")+s.title));
    for(const f of s.files){const d=el("details","difffile");d.open=s.files.length<=6;d.append(el("summary",null,f.path+(f.binary?" (binary)":"")+(f.truncated?" (truncated)":"")));
      const tbl=el("table","diff");for(const h of f.hunks){const hr=el("tr","hunk");hr.append(el("td","num",""),el("td","num",""),el("td","code",h.header));tbl.append(hr);
        for(const l of h.lines){const tr=el("tr",l.kind);tr.append(el("td","num",l.old??""),el("td","num",l.new??""),el("td","code",(l.kind==="add"?"+":l.kind==="del"?"-":" ")+l.text));
          tr.onclick=()=>addComment(tr,f.path,l.new??l.old);tbl.append(tr)}}
      d.append(tbl);box.append(d)}}
  box.prepend(el("p","muted small","Click any line to comment on it. Your comments go to the tab that did this work as one message; it reads them on its next prompt."));
  const bar=el("div","reviewbar"),send=el("button","btn primary");send.id="sendreview";send.onclick=()=>sendReview(id);
  const status=el("span","small");status.id="reviewstatus";bar.append(send,status);box.append(bar);updateSend()}
const reviewComments=()=>review.map(c=>({file:c.file,line:c.line,text:c.text})).filter(c=>c.text.trim());
// The button says what it will send, and stays off until there is something to send.
function updateSend(){const b=document.getElementById("sendreview");if(!b)return;const n=reviewComments().length;b.disabled=!n;
  b.textContent=n?"Send "+n+" comment"+(n>1?"s":"")+" to the tab":"Send review to the tab";
  b.title=n?"":"Click a line in the diff and write a comment first"}
function reviewStatus(text,kind){const s=document.getElementById("reviewstatus");s.textContent=text;s.className="small "+kind}
function addComment(tr,file,line){if(tr.nextSibling&&tr.nextSibling.classList&&tr.nextSibling.classList.contains("cm"))return;
  const row=el("tr","cm"),td=el("td");td.colSpan=3;const ta=el("textarea");ta.rows=2;ta.placeholder="Comment on "+file+":"+line;ta.oninput=updateSend;td.append(ta);row.append(td);tr.after(row);ta.focus();
  review.push({file,line,get text(){return ta.value}})}
async function sendReview(id){const comments=reviewComments();if(!comments.length)return;
  const b=document.getElementById("sendreview");b.disabled=true;reviewStatus("Sending…","muted");
  const r=await fetch("/api/tasks/"+id+"/review",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({comments})}).catch(()=>null);
  if(!r||!r.ok){const j=r?await r.json().catch(()=>({})):{};reviewStatus("Not sent: "+(j.error||"the local server didn't answer. Try again in a few seconds."),"err");b.disabled=false;return}
  reviewStatus("Sent. The tab reads your review on its next prompt; it's on the timeline below.","ok");setTimeout(()=>location.reload(),1500)}
async function post(url,body){if(await send(url,body))location.reload()}
function dismissItem(b,days){post("/api/attention/dismiss",{key:b.dataset.key,days:days||null})}
function untrackPath(b){if(confirm("Untrack "+b.dataset.path+"?\\n\\nWorkglance stops looking at this folder (no cards, nudges or git checks) and forgets what it stored about it. Tasks stay. You can undo it in Settings."))post("/api/untrack",{path:b.dataset.path})}
function retrackPath(b){post("/api/retrack",{path:b.dataset.path})}
async function comment(id,form){const note=form.note.value.trim();if(note&&await send("/api/tasks/"+id+"/comment",{note}))location.reload();return false}
`;

const CSS = `
.est{border-bottom:1px dotted var(--muted);cursor:help}
.layout{display:grid;grid-template-columns:210px minmax(0,1fr);max-width:1760px;margin:0 auto}.layout main{max-width:none;margin:0;min-width:0}
.rail{position:sticky;top:58px;align-self:start;max-height:calc(100vh - 70px);overflow:auto;padding:16px 4px 16px 20px}
.rail h4{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:8px 8px 10px}
.rgroup{margin-bottom:14px}.rgroup h5{font-size:11px;color:var(--muted);margin:0 8px 4px;font-weight:600}.rgroup h5 span{font-weight:400}.rgroup.needs h5{color:#c2410c}
.rtab{display:grid;grid-template-columns:8px minmax(0,1fr) auto;column-gap:8px;align-items:center;padding:6px 8px;border-radius:8px;text-decoration:none;color:var(--text);font-size:13px}
.rtab:hover{background:var(--card)}.rtab .dot{width:8px;height:8px;border-radius:50%;background:var(--muted);opacity:.5}
.rtab.working .dot{background:var(--prog);opacity:1;animation:wtpulse 1.6s ease-in-out infinite}
.rtab.question,.rtab.permission{background:rgba(194,65,12,.1)}.rtab.question .dot,.rtab.permission .dot{background:#c2410c;opacity:1;box-shadow:0 0 0 3px rgba(194,65,12,.25)}
.rname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}.rtab.done .rname{font-weight:500;color:var(--muted)}.rtab.done:hover .rname{color:var(--text)}
.rage{font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}
.rstate{grid-column:2/4;font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rtab.question .rstate,.rtab.permission .rstate{color:#c2410c}
@keyframes wtpulse{50%{opacity:.35}}@media (prefers-reduced-motion:reduce){.rtab.working .dot{animation:none}}
.ldot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px;vertical-align:1px}.ldot.working{background:var(--prog)}.ldot.question,.ldot.permission{background:#c2410c}
.ministats{display:flex;flex-wrap:wrap;gap:4px 18px;align-items:baseline;padding:8px 14px;margin:6px 0 4px;border:1px solid var(--line);border-radius:10px;background:var(--card);font-size:12px}
.ministats .mlabel{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-right:2px}
.mstat b{font-size:14px;margin-right:4px;font-variant-numeric:tabular-nums}.mstat span{color:var(--muted)}.mstat b .est{color:var(--text)}
@media (max-width:1000px){.layout{display:block}.rail{position:static;max-height:none;padding:12px 20px 0;display:flex;flex-wrap:wrap;gap:6px;align-items:center}.rail h4{margin:0 4px 0 0}.rgroup{display:contents}.rgroup h5,.rstate{display:none}.rtab{display:inline-flex;gap:6px;border:1px solid var(--line);background:var(--card);padding:4px 10px;border-radius:999px}}
.newdot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#f97316;vertical-align:2px;margin-left:2px}
.repo{border:1px solid var(--line);border-radius:12px;padding:10px 16px;margin:14px 0;background:var(--card)}.repo h3{margin:4px 0 6px;font-size:15px}.repo h4{margin:10px 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.repo ul{margin:0 0 4px;padding-left:18px}.repo li{margin:4px 0}.repo.needs{border-color:#f97316}.repo.needs h3{color:#f97316}
.res summary{cursor:pointer;list-style:none}.res summary::-webkit-details-marker{display:none}.res summary::after{content:" …";color:var(--accent)}.res[open] summary{display:none}
.digestsum{border:1px solid var(--line);border-radius:12px;padding:6px 16px 12px;background:var(--card);line-height:1.55}.digestsum p{margin:10px 0}
#tabdlg{border:1px solid var(--line);border-radius:14px;background:var(--card);color:var(--text);padding:22px 24px;width:min(460px,calc(100vw - 32px));box-shadow:0 20px 60px rgba(0,0,0,.45)}
#tabdlg::backdrop{background:rgba(10,12,16,.55);backdrop-filter:blur(2px)}
#tabdlg h3{margin:0 0 8px;font-size:16px}#tabdlg p{margin:0 0 10px;color:var(--muted);line-height:1.5;font-size:13px}
#tabdlg code{display:block;font-size:12px;background:var(--chip);border-radius:8px;padding:8px 10px;overflow-wrap:anywhere;margin-bottom:10px}
#tabdlg .btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.dlgactions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.mini{font:inherit;font-size:11px;padding:2px 8px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--muted);cursor:pointer}.mini:hover{color:var(--text);border-color:var(--accent)}
.live .acts{margin-left:auto;display:flex;gap:4px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin:8px 0 4px}.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.stat .v{font-size:26px;font-weight:700}.stat .l{font-size:13px}
.searchform{flex:1;min-width:180px;display:flex}.searchform input{flex:1}.live.attention .dot{background:var(--testing)}.live.attention a{text-decoration:none}
.hits{list-style:none;padding:0}.hit{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 12px;margin:6px 0}.hit .snip{margin-top:4px;overflow-wrap:anywhere}
mark{background:rgba(254,230,0,.55);color:inherit;border-radius:3px;padding:0 2px}
.diffsec{margin:14px 0 6px;font-size:13px}.difffile{margin:4px 0;border:1px solid var(--line);border-radius:8px;background:var(--card);overflow:hidden}
.difffile>summary{padding:6px 10px;font-family:ui-monospace,Consolas,monospace;font-size:12px}.diff{width:100%;border-collapse:collapse;font:12px/1.4 ui-monospace,Consolas,monospace}
.diff td{padding:0 6px;border:0;white-space:pre-wrap;overflow-wrap:anywhere}.diff td.num{color:var(--muted);text-align:right;width:1%;white-space:nowrap;user-select:none}
.diff tr.add{background:rgba(31,138,76,.13)}.diff tr.del{background:rgba(194,65,12,.13)}.diff tr.hunk td{color:var(--muted);background:var(--chip)}
.diff tr:not(.hunk):not(.cm):hover{outline:1px solid var(--accent);cursor:pointer}.diff tr.cm textarea{width:100%;font:inherit;margin:4px 0;padding:6px;border:1px solid var(--accent);border-radius:6px;background:var(--card);color:var(--text)}
.ci{font-size:11px;font-weight:600;padding:1px 7px;border-radius:999px;text-decoration:none;border:1px solid}.ci.passed{color:var(--done);border-color:var(--done)}
.ci.failed{color:#c2410c;border-color:#c2410c}.ci.running{color:var(--testing);border-color:var(--testing)}.ci.stopped{color:var(--muted);border-color:var(--muted)}
.livelist{display:flex;flex-direction:column;gap:6px}.live{display:flex;flex-wrap:wrap;align-items:center;gap:8px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 12px}
.live .dot{width:9px;height:9px;border-radius:50%;background:var(--muted);flex:none}.live.working .dot{background:var(--prog)}.live.done .dot{background:var(--done)}
.live.question,.live.permission{border-color:#c2410c}.live.question .dot,.live.permission .dot{background:#c2410c;box-shadow:0 0 0 3px rgba(194,65,12,.2)}
.live .tabname{font-weight:600;text-decoration:none}.live .tabname:hover{text-decoration:underline}.live .state{font-size:12px;font-weight:600}.live.question .state,.live.permission .state{color:#c2410c}
.live .detail{font-size:12px;color:var(--muted);flex-basis:100%;overflow-wrap:anywhere}.badge.needs{background:#c2410c}
.task[draggable]{cursor:grab}.task.dragging{opacity:.5}.col.over{outline:2px dashed var(--accent);outline-offset:-2px}
.unseen{color:var(--accent);font-size:12px;font-weight:600;margin:4px 0}
.actions{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}.btn{font:inherit;font-size:13px;padding:5px 11px;border-radius:7px;border:1px solid var(--line);background:var(--card);color:var(--text);cursor:pointer}
.btn:hover{border-color:var(--accent)}.btn.danger{color:#c2410c}.btn:disabled{opacity:.5;cursor:default;border-color:var(--line)}
.reviewbar{position:sticky;bottom:0;display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:12px;padding:10px 0;background:var(--bg);border-top:1px solid var(--line)}
.small.ok{color:#1f8a4c}.small.err{color:#c2410c}
.settings .panel{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:4px 20px 16px;margin:0 0 18px}
.settings .panel h3{font-size:15px;margin:14px 0 4px}.settings .panel h4{font-size:13px;margin:18px 0 6px}
.field{display:flex;gap:16px;padding:12px 0;border-top:1px solid var(--line)}.field .label{flex:0 0 150px;font-weight:600;font-size:13px;padding-top:5px}
.fieldbody{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px;align-items:flex-start}.fieldbody .row{display:flex;align-items:center;gap:10px}
.times{display:flex;gap:8px;flex-wrap:wrap}.timechip{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:8px;padding:2px 2px 2px 8px;background:var(--bg)}
.timechip input{border:0;background:transparent;color:var(--text);font:inherit;color-scheme:light dark}.timechip .x{border:0;background:none;color:var(--muted);cursor:pointer;font-size:16px;line-height:1;padding:2px 6px}
.timechip .x:hover:not(:disabled){color:#c2410c}.timechip .x:disabled{opacity:.3;cursor:default}
.settings select,.settings input[type=search]{font:inherit;font-size:13px;padding:7px 10px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--text);color-scheme:light dark}
.settings input[type=search]{width:100%;box-sizing:border-box;margin-top:6px}.check{display:flex;gap:8px;align-items:center;font-size:13px}
.formactions{display:flex;align-items:center;gap:12px;padding-top:12px;border-top:1px solid var(--line)}
.folderlist{margin-top:6px}.folderrow{display:flex;align-items:center;gap:12px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;margin-bottom:6px;background:var(--bg)}
.folderrow .what{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}.folderrow code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mini.danger{color:#c2410c;border-color:#c2410c}
@media (max-width:640px){.field{flex-direction:column;gap:6px}.field .label{flex:none;padding:0}}.newdigest{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:4px 0 14px}
.comment{display:flex;gap:8px;align-items:flex-start;margin:6px 0 4px}.comment textarea{flex:1;font:inherit;padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--text);resize:vertical}
:root{--bg:#f6f7f9;--card:#fff;--text:#1d2330;--muted:#6b7280;--line:#e3e6eb;--chip:#eef1f5;--done:#1f8a4c;--testing:#b7791f;--prog:#2b6cb0;--local:#6b7280;--accent:#4f46e5}
@media (prefers-color-scheme:dark){:root{--bg:#111318;--card:#1a1d24;--text:#e6e8ec;--muted:#9aa1ad;--line:#2a2e37;--chip:#252a33;--accent:#8b85ff}}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--text)}
.top{position:sticky;top:0;z-index:2;display:flex;gap:16px;align-items:center;flex-wrap:wrap;padding:12px 20px;background:var(--bg);border-bottom:1px solid var(--line)}
.top h1{font-size:17px;margin:0}.top input{flex:1;min-width:180px;padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--text)}
.top select.filter{max-width:140px;padding:7px 8px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--text);font:inherit;font-size:13px;color-scheme:light dark}
.top select.filter.on{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.ranges a{padding:4px 9px;border-radius:6px;color:var(--muted);text-decoration:none}.ranges a.on{background:var(--accent);color:#fff}
main{padding:16px 20px;max-width:1500px;margin:0 auto}h2{font-size:15px;margin:22px 0 10px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
td{padding:7px 10px;border-top:1px solid var(--line);vertical-align:top}tr:first-child td{border-top:0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:12px}
@media (max-width:520px){.grid{grid-template-columns:1fr}main,.top{padding-left:16px;padding-right:16px}}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;min-width:0}
.card header{display:flex;justify-content:space-between;gap:8px;align-items:baseline}.card h3{margin:0;font-size:15px;overflow-wrap:anywhere}
.was{color:var(--muted);font-size:12px;margin-top:2px}.places{margin:8px 0;display:flex;flex-wrap:wrap;gap:5px}
.chip{background:var(--chip);border-radius:6px;padding:2px 7px;font-size:12px;max-width:100%;overflow-wrap:anywhere}
.summary{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:6px}
.badge{display:inline-block;font-size:11px;font-weight:600;padding:1px 7px;border-radius:999px;color:#fff;white-space:nowrap}
.badge.done{background:var(--done)}.badge.testing{background:var(--testing)}.badge.in_progress{background:var(--prog)}.badge.local{background:var(--local)}
details{margin-top:6px}summary{cursor:pointer;color:var(--muted);font-size:13px}ul{margin:6px 0 0;padding-left:16px}li{margin:3px 0;overflow-wrap:anywhere}
.board{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;align-items:start}
@media (max-width:900px){.board{grid-template-columns:1fr 1fr}}@media (max-width:520px){.board{grid-template-columns:1fr}}
.col{background:var(--chip);border-radius:10px;padding:8px;display:flex;flex-direction:column;gap:8px;min-width:0}.col h4{margin:2px 4px;font-size:13px}
.task h3{font-size:14px}.chip.type{font-weight:600}.warn{color:#c2410c;font-size:12px;margin:4px 0}.note{font-size:12px;margin:4px 0}.small{font-size:12px}
code{font-size:12px}.muted{color:var(--muted)}.id{font-size:11px;margin-top:8px}.empty{color:var(--muted);padding:10px 0}
a{color:inherit}h1 a{text-decoration:none}.card h3 a{text-decoration:none}.card h3 a:hover{text-decoration:underline}.tasks{list-style:none;padding:0;margin:6px 0}
.detail{max-width:980px}.detail h3{font-size:14px;margin:18px 0 6px}.pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:0}
.timeline{list-style:none;padding:0;border-left:2px solid var(--line);margin-left:6px}.tl{padding:5px 0 5px 12px;position:relative}.tl:before{content:"";position:absolute;left:-6px;top:11px;width:10px;height:10px;border-radius:50%;background:var(--line)}
.tl.event:before{background:var(--accent)}.tl.commit:before{background:var(--done)}.when{color:var(--muted);font-size:12px;margin-right:8px}.who{font-weight:600;margin-right:6px}.tl.prompt{color:var(--muted)}
`;

/** `needsYou`: tabs waiting for an answer or a permission. The browser tab says so: "(2) …" and an orange dot. */
function shell(title: string, body: string, needsYou = 0): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg${needsYou ? "?needs=1" : ""}">
<title>${needsYou ? `(${needsYou}) ` : ""}${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;
}
