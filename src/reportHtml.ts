import { browserStyles } from './browserStyles';

function escapeAttribute(value: string): string {
    return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

/** The page of a report tab: figures, a filter and tables, filled in by `reportWebview`. */
export function getReportHtml(scriptUri: string, nonce: string): string {
    const safeNonce = escapeAttribute(nonce);
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${safeNonce}'; style-src 'nonce-${safeNonce}'; img-src 'none'; connect-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none';">
<title>Report</title><style nonce="${safeNonce}">
${browserStyles}
.report-heading { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:10px; margin:5px 0 4px; }
.report-subtitle { margin:0 0 12px; font-size:12px; color:var(--vscode-descriptionForeground,#aaa); overflow-wrap:anywhere; }
.report-tools { display:flex; align-items:center; gap:8px; }
.report-tools input { flex:1; min-width:0; }
.report-body { flex:1; min-height:0; overflow:auto; padding:18px 24px 28px; }
.stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin:0 0 20px; }
.stat { border:1px solid var(--vscode-panel-border,#383838); border-radius:4px; padding:11px 12px; background:var(--vscode-sideBar-background,#252526); }
.stat dt { font-size:11px; color:var(--vscode-descriptionForeground,#aaa); margin:0; }
.stat dd { font-size:21px; line-height:1.3; font-variant-numeric:tabular-nums; margin:4px 0 0; }
.report-section { margin:0 0 26px; }
.report-section h2 { font-size:15px; font-weight:600; margin:0 0 4px; }
.section-note { color:var(--vscode-descriptionForeground,#aaa); font-size:11px; margin:0 0 8px; }
.tone-error { color:var(--vscode-errorForeground,#f48771); }
.tone-warning { color:var(--vscode-editorWarning-foreground,#cca700); }
.tone-ok { color:var(--vscode-testing-iconPassed,#73c991); }
.tone-muted { color:var(--vscode-descriptionForeground,#aaa); }
.row-link { padding:0; border:0; background:transparent; color:var(--vscode-textLink-foreground,#4daafc); font:inherit; text-align:left; overflow-wrap:anywhere; }
.row-link:hover:not(:disabled) { background:transparent; color:var(--vscode-textLink-activeForeground,#73c2ff); text-decoration:underline; }
.report-notes { padding:10px 14px; border-left:3px solid var(--vscode-panel-border,#444); background:var(--vscode-textBlockQuote-background,#252526); color:var(--vscode-descriptionForeground,#aaa); font-size:11px; }
.report-notes ul { padding-left:16px; margin:0; }
td { font-variant-numeric:tabular-nums; }
@media(max-width:560px) { .report-body { padding:14px 12px 20px; } th,td { padding:5px 6px; } }
</style></head><body><div class="app">
<header><div class="eyebrow">Qbox Lua / Checks</div><div class="report-heading"><h1 id="title">Report</h1><button id="refresh" disabled>Check again</button></div>
<p id="subtitle" class="report-subtitle"></p>
<div class="report-tools"><input id="filter" type="search" maxlength="256" aria-label="Filter the rows of this report" placeholder="Filter by resource, file or text…"></div></header>
<main id="body" class="report-body" aria-live="polite">
<div id="loading" class="empty" role="status"><h2>Checking…</h2><p id="loading-status"></p></div>
<div id="error" class="notice" role="alert" hidden></div>
<dl id="stats" class="stats" hidden></dl>
<div id="sections"></div>
<aside id="notes" class="report-notes" hidden><ul id="note-list"></ul></aside>
</main><div id="status" class="status-bar" role="status"></div>
</div><script nonce="${safeNonce}" src="${escapeAttribute(scriptUri)}"></script></body></html>`;
}
