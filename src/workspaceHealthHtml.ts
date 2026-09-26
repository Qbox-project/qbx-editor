import { browserStyles } from './browserStyles';

function escapeAttribute(value: string): string {
    return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

export function getWorkspaceHealthHtml(scriptUri: string, nonce: string): string {
    const safeNonce = escapeAttribute(nonce);
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${safeNonce}'; style-src 'nonce-${safeNonce}'; img-src 'none'; connect-src 'none'; font-src 'none';">
<title>Workspace Health</title><style nonce="${safeNonce}">
${browserStyles}
.health-heading { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:10px; margin:5px 0 10px; }
.server-state { font-size:11px; padding:2px 7px; border:1px solid var(--vscode-panel-border,#444); border-radius:3px; }
.server-state[data-state=unavailable] { color:var(--vscode-errorForeground,#f48771); border-color:var(--vscode-inputValidation-errorBorder,#be1100); }
.server-message { margin:0 0 14px; font-size:12px; color:var(--vscode-descriptionForeground,#aaa); overflow-wrap:anywhere; }
.health-actions { display:flex; flex-wrap:wrap; gap:8px; }
.health-overview { flex:1; min-height:0; overflow:auto; padding:20px 24px 28px; }
.stats { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:10px; margin:0 0 22px; }
.stat { border:1px solid var(--vscode-panel-border,#383838); border-radius:4px; padding:13px 12px; background:var(--vscode-sideBar-background,#252526); }
.stat dt { font-size:11px; color:var(--vscode-descriptionForeground,#aaa); margin:0; }
.stat dd { font-size:24px; line-height:1.3; font-variant-numeric:tabular-nums; margin:5px 0 0; }
.snapshot-notes { padding:10px 14px; border-left:3px solid var(--vscode-panel-border,#444); background:var(--vscode-textBlockQuote-background,#252526); color:var(--vscode-descriptionForeground,#aaa); font-size:11px; margin-bottom:22px; }
.snapshot-notes p { margin:0; }
.snapshot-notes ul { padding-left:16px; margin:8px 0 0; }
.snapshot-notes li { overflow-wrap:anywhere; }
.section-heading { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; margin-bottom:12px; }
.section-heading h2 { font-size:16px; font-weight:600; margin:0; }
.section-note { color:var(--vscode-descriptionForeground,#aaa); font-size:11px; }
.issue-tools { display:flex; align-items:center; gap:8px; margin-bottom:12px; }
.issue-tools input { flex:1; min-width:0; }
.issue-tools select { max-width:185px; }
.issues { list-style:none; margin:0; padding:0; }
.issue { padding:14px 15px; margin:0 0 10px; border:1px solid var(--vscode-panel-border,#383838); border-radius:4px; }
.issue-heading { display:flex; align-items:baseline; gap:9px; flex-wrap:wrap; margin-bottom:7px; }
.issue-name { margin:0; font:600 13px/1.5 var(--vscode-editor-font-family,monospace); overflow-wrap:anywhere; }
.issue-kind { color:var(--vscode-descriptionForeground,#aaa); font-size:10px; padding:1px 6px; border:1px solid var(--vscode-panel-border,#444); border-radius:3px; }
.issue-description { margin:0 0 8px; font-size:12px; color:var(--vscode-descriptionForeground,#aaa); }
.issue-source { font-size:11px; margin:5px 0; overflow-wrap:anywhere; }
.source-label { color:var(--vscode-descriptionForeground,#aaa); margin-right:6px; }
.source-button { padding:0; border:0; border-radius:0; background:transparent; color:var(--vscode-textLink-foreground,#4daafc); text-align:left; overflow-wrap:anywhere; font:11px/1.6 var(--vscode-editor-font-family,monospace); }
.source-button:hover:not(:disabled) { background:transparent; color:var(--vscode-textLink-activeForeground,#73c2ff); text-decoration:underline; }
.candidates { font-size:11px; margin-top:8px; }
.candidates summary { cursor:pointer; color:var(--vscode-descriptionForeground,#aaa); }
.candidates ul { list-style:none; margin:6px 0 0; padding:0 0 0 12px; border-left:1px solid var(--vscode-panel-border,#444); }
.candidates li { padding:3px 0; overflow-wrap:anywhere; }
.candidate-note { font-size:11px; color:var(--vscode-descriptionForeground,#aaa); margin:7px 0 0; }
.issue-pagination { padding-left:0; padding-right:0; }
.load-note { padding:9px 24px; border-bottom:1px solid var(--vscode-panel-border,#383838); font-size:12px; color:var(--vscode-descriptionForeground,#aaa); }
.failure { padding:16px; margin:0 0 20px; border:1px solid var(--vscode-inputValidation-errorBorder,#be1100); border-radius:4px; }
.failure h2 { margin:0 0 8px; font-size:16px; font-weight:500; }
.failure p { margin:0; color:var(--vscode-descriptionForeground,#aaa); overflow-wrap:anywhere; }
@media(max-width:760px) { .stats { grid-template-columns:repeat(3,minmax(0,1fr)); } }
@media(max-width:650px) { .health-overview { padding:16px; } .health-heading h1 { font-size:20px; } }
@media(max-width:430px) { .stats { grid-template-columns:repeat(2,minmax(0,1fr)); } .stat { padding:10px; } .stat dd { font-size:21px; } .issue-tools { flex-wrap:wrap; } .issue-tools input { flex-basis:100%; } .issue-tools select { max-width:none; width:100%; } .issue { padding:12px; } }
</style></head><body><div class="app">
<header><div class="eyebrow">Qbox Lua / Workspace</div><div class="health-heading"><h1>Workspace health</h1><span id="server-state" class="server-state">Checking…</span></div>
<p id="server-message" class="server-message">Waiting for the language server snapshot.</p>
<div class="health-actions"><button id="refresh" class="primary" disabled>Refresh</button><button id="output">Show Language Server Output</button></div></header>
<div id="loading" class="load-note" role="status">Loading workspace health…</div>
<main id="overview" class="health-overview" aria-busy="true">
<dl class="stats" aria-label="Indexed workspace counts">
<div class="stat"><dt>Resources</dt><dd id="count-resources">—</dd></div><div class="stat"><dt>Indexed files</dt><dd id="count-files">—</dd></div><div class="stat"><dt>Duplicate names</dt><dd id="count-duplicates">—</dd></div><div class="stat"><dt>Missing from index</dt><dd id="count-missing">—</dd></div><div class="stat"><dt>Ambiguous names</dt><dd id="count-ambiguous">—</dd></div>
</dl>
<section id="failure" class="failure" role="alert" hidden><h2>Workspace checks unavailable</h2><p id="failure-message"></p></section>
<aside class="snapshot-notes" aria-label="Snapshot scope"><p>These checks describe the language server’s indexed workspace. They do not check runtime constraints or confirm that a server is running.</p><ul id="notes" hidden></ul></aside>
<section id="issue-section" aria-labelledby="issues-title" hidden>
<div class="section-heading"><h2 id="issues-title">Resource issues</h2><span id="issue-count" class="section-note" aria-live="polite"></span></div>
<div class="issue-tools"><input id="search" type="search" maxlength="256" aria-label="Search resource issues" placeholder="Search resource names or paths…"><select id="kind" aria-label="Issue type"><option value="all">All issues</option><option value="duplicate">Duplicate names</option><option value="missing">Missing from index</option><option value="ambiguous">Ambiguous names</option></select></div>
<div id="empty" class="empty" hidden><h2 id="empty-title">No matching issues</h2><p id="empty-message">Try another search or issue type.</p></div>
<ul id="issues" class="issues" aria-label="Resource issues"></ul>
<nav class="pagination issue-pagination" aria-label="Issue pages"><button id="previous" disabled>Previous</button><span id="page-range">0 issues</span><button id="next" disabled>Next</button></nav>
<p id="issue-note" class="section-note"></p>
</section></main><div id="status" class="status-bar" role="status" aria-live="polite">Loading workspace health…</div>
</div><script nonce="${safeNonce}" src="${escapeAttribute(scriptUri)}"></script></body></html>`;
}
