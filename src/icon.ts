// The Workglance mark: three board columns on the board's indigo, with a status dot. One drawing for the
// browser tab (favicon) and the VS Code extension (vscode/icon.png is rendered from it, see scripts/icon.mjs).
// When a tab needs you, the dot turns orange and grows, so the browser tab shows it at a glance.
export function iconSvg(needsYou = false): string {
  const dot = needsYou
    ? `<circle cx="96" cy="94" r="22" fill="#ffffff"/><circle cx="96" cy="94" r="17" fill="#f97316"/>`
    : `<circle cx="96" cy="94" r="13" fill="#34d399"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
<rect width="128" height="128" rx="28" fill="#4f46e5"/>
<rect x="24" y="26" width="22" height="76" rx="7" fill="#ffffff"/>
<rect x="53" y="26" width="22" height="54" rx="7" fill="#ffffff" fill-opacity=".78"/>
<rect x="82" y="26" width="22" height="34" rx="7" fill="#ffffff" fill-opacity=".56"/>
${dot}
</svg>`;
}
