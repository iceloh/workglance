// Workglance depends on things Anthropic doesn't document as a stable API: the transcript format and the
// Claude Code VS Code extension's "open this session" command. These pure checks let `workglance doctor`
// say "this changed" instead of the board silently going quiet.

/** Transcript lines Workglance can read: JSON records with a session, a time and a user/assistant type. */
export function transcriptHealth(lines: string[]): { total: number; recognized: number } {
  let total = 0, recognized = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    total++;
    try {
      const r = JSON.parse(line);
      if (typeof r?.sessionId === "string" && typeof r?.timestamp === "string" && (r.type === "user" || r.type === "assistant")) recognized++;
    } catch {}
  }
  return { total, recognized };
}

/** The Claude extension still opens a session by id: its URI handler path and the command behind it. */
export function claudeExtensionHealth(source: string): { uri: boolean; command: boolean } {
  return { uri: /["']\/open["']/.test(source), command: source.includes("claude-vscode.primaryEditor.open") };
}

/** Models seen in usage that have no price (their cost is left out of every total, never guessed). */
export function unpricedModels(models: string[], priceFor: (m: string) => unknown): string[] {
  return [...new Set(models)].filter((m) => m !== "<synthetic>" && !priceFor(m)).sort();
}
