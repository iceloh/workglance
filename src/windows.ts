// Which VS Code window owns a Claude tab. A vscode:// link always lands in the last focused window, and
// a window that doesn't have the session opens a blank tab. So every window's extension tells us its
// folders (long poll), and "open this tab" is delivered to the window whose folder holds the tab's cwd.
import type http from "node:http";
import { isUnder, pathKey } from "./transcript.ts";

export type Win = {
  id: string; folders: string[]; focusedAt: number; seenAt: number;
  waiter: http.ServerResponse | null; queue: string[];
};

/** A window that stopped polling (closed, or VS Code quit) is gone after this. */
export const WINDOW_TTL_MS = 40_000;
export const WAIT_MS = 25_000;


/** The live window whose folder contains `cwd`: the deepest folder wins, then the last focused. */
export function pickWindow(wins: Iterable<Win>, cwd: string, now = Date.now()): Win | null {
  let best: Win | null = null, bestLen = -1;
  for (const w of wins) {
    if (!w.waiter && now - w.seenAt > WINDOW_TTL_MS) continue;
    for (const f of w.folders) {
      if (!f || !isUnder(cwd, f)) continue;
      const n = pathKey(f);
      if (n.length > bestLen || (n.length === bestLen && w.focusedAt > best!.focusedAt)) { best = w; bestLen = n.length; }
    }
  }
  return best;
}

export class WindowRegistry {
  readonly windows = new Map<string, Win>();

  /** The extension's long poll: answers at once with queued tabs, else after WAIT_MS with none. */
  wait(body: Record<string, any>, res: http.ServerResponse, now = Date.now()): void {
    const id = String(body.id ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) { res.writeHead(400).end(); return; }
    const folders = (Array.isArray(body.folders) ? body.folders : []).map(String).filter((f: string) => f.length < 1000).slice(0, 50);
    let w = this.windows.get(id);
    if (!w) { w = { id, folders, focusedAt: 0, seenAt: now, waiter: null, queue: [] }; this.windows.set(id, w); }
    w.folders = folders;
    w.seenAt = now;
    w.focusedAt = Math.max(w.focusedAt, Number(body.focusedAt) || 0);
    if (w.waiter) this.answer(w);
    w.waiter = res;
    res.on("close", () => { if (w!.waiter === res) { w!.waiter = null; w!.seenAt = Date.now(); } });
    if (w.queue.length) { this.answer(w); return; }
    setTimeout(() => { if (w!.waiter === res) this.answer(w!); }, WAIT_MS).unref();
    for (const [k, x] of this.windows) if (!x.waiter && now - x.seenAt > WINDOW_TTL_MS) this.windows.delete(k);
  }

  /** Windows still polling (an extension that stopped polling is closed). */
  live(now = Date.now()): Win[] {
    return [...this.windows.values()].filter((w) => w.waiter || now - w.seenAt <= WINDOW_TTL_MS);
  }

  /** Queue "open this session" for the window that owns `cwd`, or say why no window can. */
  open(session: string, cwd: string | null): { ok: true } | { ok: false; reason: "no_windows" | "no_match"; cwd: string | null } {
    if (!this.live().length) return { ok: false, reason: "no_windows", cwd };
    const w = cwd ? pickWindow(this.windows.values(), cwd) : null;
    if (!w) return { ok: false, reason: "no_match", cwd };
    w.queue.push(session);
    if (w.waiter) this.answer(w);
    return { ok: true };
  }

  private answer(w: Win): void {
    const res = w.waiter!;
    w.waiter = null;
    w.seenAt = Date.now();
    const open = w.queue.splice(0);
    if (!res.writableEnded) res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ open }));
  }
}
