import { browserStyles } from './browserStyles';

function escapeAttribute(value: string): string {
    return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

export function getRuntimeLogHtml(scriptUri: string, nonce: string): string {
    const safeNonce = escapeAttribute(nonce);
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${safeNonce}'; style-src 'nonce-${safeNonce}'; img-src 'none'; connect-src 'none'; font-src 'none';">
<title>Runtime Log</title><style nonce="${safeNonce}">
${browserStyles}
.log-heading { display:flex; align-items:center; justify-content:space-between; gap:12px; margin:5px 0 10px; }
.log-path { font:11px var(--vscode-editor-font-family,monospace); color:var(--vscode-descriptionForeground,#aaa); overflow-wrap:anywhere; margin:0 0 12px; }
.log-actions { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px; }
.log-search { display:flex; align-items:center; gap:12px; }
.log-search input[type=search] { flex:1; min-width:0; }
.follow { display:flex; align-items:center; gap:5px; font-size:12px; white-space:nowrap; cursor:pointer; }
.follow input { accent-color:var(--vscode-focusBorder,#007fd4); }
.log-status { font-size:12px; color:var(--vscode-descriptionForeground,#aaa); margin:10px 0 0; overflow-wrap:anywhere; }
.read-state { font-size:11px; color:var(--vscode-descriptionForeground,#aaa); border:1px solid var(--vscode-panel-border,#444); padding:2px 7px; border-radius:3px; white-space:nowrap; }
.log-toolbar { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px; padding:9px 24px; font-size:11px; color:var(--vscode-descriptionForeground,#aaa); border-bottom:1px solid var(--vscode-panel-border,#383838); }
.log-viewport { flex:1; min-height:0; overflow:auto; padding:12px 16px; }
.log-lines { font:12px/1.65 var(--vscode-editor-font-family,monospace); tab-size:4; }
.log-line { white-space:pre-wrap; overflow-wrap:anywhere; padding:2px 7px; border-left:2px solid transparent; min-height:1.65em; }
.log-line:hover { background:var(--vscode-list-hoverBackground,#2b2d2e); border-left-color:var(--vscode-panel-border,#444); }
.log-source { display:inline; padding:0; border:0; border-radius:0; color:var(--vscode-textLink-foreground,#4daafc); background:transparent; font:inherit; white-space:pre-wrap; overflow-wrap:anywhere; text-align:left; vertical-align:baseline; }
.log-source:hover:not(:disabled) { background:transparent; color:var(--vscode-textLink-activeForeground,#73c2ff); text-decoration:underline; }
.empty button { margin-top:10px; }
@media(max-width:500px) { .log-search { flex-wrap:wrap; gap:8px; } .log-search input[type=search] { flex-basis:100%; } .log-toolbar { padding:8px 16px; } .log-viewport { padding:10px 8px; } }
</style></head><body><div class="app">
<header><div class="eyebrow">Qbox Lua / Runtime</div><div class="log-heading"><h1>Runtime log</h1><span id="read-state" class="read-state">No file selected</span></div>
<p id="log-path" class="log-path">Choose a local log file to follow its output.</p>
<div class="log-actions"><button id="choose" class="primary">Choose log file…</button><button id="pause" aria-pressed="false" disabled>Pause</button><button id="clear" disabled>Clear view</button></div>
<div class="log-search"><input id="search" type="search" maxlength="256" aria-label="Filter retained log lines" placeholder="Filter text or resource names…"><label class="follow"><input id="autoscroll" type="checkbox" checked>Autoscroll</label></div>
<p id="log-status" class="log-status" role="status" aria-live="polite">Select a log file to begin.</p></header>
<div class="log-toolbar"><span id="line-count">0 retained lines</span><span>Up to 300 matching lines shown</span></div>
<main id="viewport" class="log-viewport" aria-label="Log output" tabindex="0">
<div id="empty" class="empty"><h2>Follow a FiveM log</h2><p>Select an existing local log file. Source locations in recognized stack traces can open directly in your editor.</p><button id="empty-choose">Choose log file…</button></div>
<div id="no-matches" class="empty" hidden><h2>No matching lines</h2><p>Change your filter to search the retained log history.</p></div>
<div id="lines" class="log-lines" aria-label="Matching log lines"></div>
</main><div id="history-note" class="status-bar">Search covers the log history retained in this tab.</div>
</div><script nonce="${safeNonce}" src="${escapeAttribute(scriptUri)}"></script></body></html>`;
}
