import { browserStyles } from './browserStyles';

function escapeAttribute(value: string): string {
    return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

export function getResourceDetailsHtml(scriptUri: string, nonce: string): string {
    const safeNonce = escapeAttribute(nonce);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${safeNonce}'; style-src 'nonce-${safeNonce}'; img-src 'none'; connect-src 'none'; font-src 'none';">
<title>Resource Details</title>
<style nonce="${safeNonce}">
${browserStyles}
.resource-heading { display:flex; flex-wrap:wrap; align-items:center; gap:10px; margin:5px 0 8px; }
.resource-heading h1 { flex:1; overflow-wrap:anywhere; min-width:150px; }
.resource-path { font:11px var(--vscode-editor-font-family,monospace); color:var(--vscode-descriptionForeground,#aaa); overflow-wrap:anywhere; margin:0 0 16px; }
.resource-selector { display:flex; gap:8px; align-items:center; }
.resource-selector label { color:var(--vscode-descriptionForeground,#aaa); font-size:12px; }
.resource-selector .selection-note { flex:1; color:var(--vscode-descriptionForeground,#aaa); font-size:11px; }
.overview { flex:1; min-height:0; overflow:auto; padding:20px 24px 28px; }
.stats { display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:10px; margin:0 0 24px; }
.stat { padding:13px 12px; border:1px solid var(--vscode-panel-border,#383838); border-radius:4px; background:var(--vscode-sideBar-background,#252526); }
.stat dt { font-size:11px; color:var(--vscode-descriptionForeground,#aaa); margin:0; }
.stat dd { font-size:24px; line-height:1.3; margin:5px 0 0; font-variant-numeric:tabular-nums; }
.section-heading { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; margin:0 0 12px; }
.section-heading h2 { font-size:16px; font-weight:600; margin:0; }
.section-note { color:var(--vscode-descriptionForeground,#aaa); font-size:11px; margin:6px 0 12px; }
.relationships { margin:0 0 26px; }
.dependency-diagram { display:grid; grid-template-columns:minmax(0,1fr) 24px minmax(110px,.7fr) 24px minmax(0,1fr); gap:8px; align-items:center; }
.relation-group { min-width:0; align-self:stretch; border:1px solid var(--vscode-panel-border,#383838); border-radius:4px; padding:10px; }
.relation-group h3 { font-size:11px; font-weight:500; color:var(--vscode-descriptionForeground,#aaa); margin:0 0 8px; }
.relation-group ul { list-style:none; padding:0; margin:0; max-height:160px; overflow:auto; }
.relation-group li { padding:3px 0; font-size:12px; overflow-wrap:anywhere; }
.relation-group .empty-relation { color:var(--vscode-descriptionForeground,#aaa); font-size:11px; padding:5px 0; }
.relation-current { border:1px solid var(--vscode-focusBorder,#007fd4); border-radius:4px; background:var(--vscode-list-inactiveSelectionBackground,#37373d); padding:14px 10px; text-align:center; overflow-wrap:anywhere; font-family:var(--vscode-editor-font-family,monospace); font-size:12px; }
.direction { color:var(--vscode-descriptionForeground,#aaa); text-align:center; font-size:22px; }
.source-button { text-align:left; padding:0; border:0; border-radius:0; color:var(--vscode-textLink-foreground,#4daafc); background:transparent; overflow-wrap:anywhere; }
.source-button:hover:not(:disabled) { background:transparent; color:var(--vscode-textLink-activeForeground,#73c2ff); text-decoration:underline; }
.source-button:disabled { opacity:.6; }
.unresolved { color:var(--vscode-descriptionForeground,#aaa); font-size:10px; display:block; }
.relation-more { font-size:10px; color:var(--vscode-descriptionForeground,#aaa); margin:8px 0 0; }
.all-relations { margin-top:12px; }
.all-relations summary { cursor:pointer; font-size:12px; }
.relation-lists { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; margin-top:10px; }
.relation-lists ul { max-height:280px; }
.relation-targets { display:flex; flex-direction:column; gap:4px; margin:5px 0 6px 8px; }
.constraints { margin-top:14px; }
.constraints h3 { font-size:12px; margin:0 0 7px; }
.constraint-list { display:flex; flex-wrap:wrap; gap:6px; }
.snapshot-notes { padding:10px 14px; border-left:3px solid var(--vscode-panel-border,#444); background:var(--vscode-textBlockQuote-background,#252526); margin:0 0 22px; font-size:11px; color:var(--vscode-descriptionForeground,#aaa); }
.snapshot-notes ul { margin:0; padding-left:16px; }
.snapshot-notes li { overflow-wrap:anywhere; }
.entry-tools { display:flex; gap:8px; align-items:center; margin-bottom:10px; }
.entry-tools input { flex:1; min-width:0; }
.entry-tools select { max-width:150px; }
.entries-table { table-layout:fixed; margin:0; }
.entries-table th:nth-child(1) { width:40%; }
.entries-table th:nth-child(2) { width:23%; }
.entries-table th:nth-child(3) { width:37%; }
.entry-name { font-family:var(--vscode-editor-font-family,monospace); font-size:12px; }
.entry-meta { color:var(--vscode-descriptionForeground,#aaa); display:block; font-size:10px; margin-top:4px; }
.entry-type { font-size:11px; }
.entry-source { font-family:var(--vscode-editor-font-family,monospace); font-size:11px; }
.entry-pagination { padding-left:0; padding-right:0; }
#error { margin:0; border-radius:0; flex:none; }
#loading { padding:9px 24px; font-size:12px; color:var(--vscode-descriptionForeground,#aaa); border-bottom:1px solid var(--vscode-panel-border,#383838); }
.index-note { margin-top:10px; }
@media(max-width:800px) { .stats { grid-template-columns:repeat(3,minmax(0,1fr)); } }
@media(max-width:650px) { .overview { padding:16px; } .resource-heading { align-items:flex-start; } .resource-heading h1 { font-size:19px; } .dependency-diagram,.relation-lists { grid-template-columns:minmax(0,1fr); gap:5px; } .relation-group ul { max-height:120px; } .direction { transform:rotate(90deg); line-height:1; } .relation-current { padding:9px; } .entries-table th,.entries-table td { padding:7px 6px; } }
@media(max-width:420px) { .stat { padding:10px 8px; } .stat dd { font-size:21px; } .resource-selector { flex-wrap:wrap; } .resource-selector label { flex-basis:100%; } .entry-tools { flex-wrap:wrap; } .entry-tools input { flex-basis:100%; } .entry-tools select { max-width:none; width:100%; } .entries-table th:nth-child(1) { width:35%; } .entries-table th:nth-child(2) { width:25%; } .entries-table th:nth-child(3) { width:40%; } }
</style>
</head>
<body><div class="app">
<header>
<div class="eyebrow">Qbox Lua / Resource</div>
<div class="resource-heading"><h1 id="resource-name">Resource details</h1><button id="manifest" disabled>Open manifest</button></div>
<p id="resource-path" class="resource-path">Choose a resource to explore its code and dependencies.</p>
<div class="resource-selector"><button id="choose">Choose resource…</button><span class="selection-note">Files, events and direct dependencies</span><button id="refresh">Refresh</button></div>
</header>
<div id="loading" role="status">Loading resource details…</div>
<div id="error" class="notice" role="alert" hidden></div>
<main class="overview" id="overview" aria-busy="true">
<div id="empty" class="empty" hidden><h2>No resource selected</h2><p>Open a FiveM resource folder, then refresh to explore it.</p></div>
<div id="details" hidden>
<dl class="stats" aria-label="Resource counts">
<div class="stat"><dt>Client files</dt><dd id="count-client">0</dd></div><div class="stat"><dt>Server files</dt><dd id="count-server">0</dd></div><div class="stat"><dt>Shared files</dt><dd id="count-shared">0</dd></div><div class="stat"><dt>Module files</dt><dd id="count-modules">0</dd></div><div class="stat"><dt>Events / callbacks</dt><dd id="count-events">0</dd></div><div class="stat"><dt>Exports</dt><dd id="count-exports">0</dd></div>
</dl>
<aside id="notes" class="snapshot-notes" aria-label="Resource notes" hidden><ul id="note-list"></ul></aside>
<section class="relationships" aria-labelledby="relationships-title">
<div class="section-heading"><h2 id="relationships-title">Dependencies</h2></div>
<p class="section-note" id="direction-note">Arrows point from a resource to the resources it requires. Only direct relationships are shown.</p>
<div class="dependency-diagram" aria-describedby="direction-note">
<section class="relation-group" aria-labelledby="dependents-title"><h3 id="dependents-title">Used by</h3><ul id="dependents"></ul><p class="relation-more" id="dependents-more" hidden></p></section>
<span class="direction" aria-hidden="true">→</span><div class="relation-current" id="current-node"></div><span class="direction" aria-hidden="true">→</span>
<section class="relation-group" aria-labelledby="dependencies-title"><h3 id="dependencies-title">Requires</h3><ul id="dependencies"></ul><p class="relation-more" id="dependencies-more" hidden></p></section>
</div>
<details id="all-relations" class="all-relations"><summary id="all-relations-summary">All relationships</summary><div class="relation-lists"><section class="relation-group"><h3>Dependencies</h3><ul id="all-dependencies"></ul></section><section class="relation-group"><h3>Dependents</h3><ul id="all-dependents"></ul></section></div><p id="relation-note" class="section-note"></p></details>
<div id="constraints" class="constraints" hidden><h3>Manifest constraints</h3><div id="constraint-list" class="constraint-list"></div></div>
</section>
<section aria-labelledby="entries-title">
<div class="section-heading"><h2 id="entries-title">Events &amp; exports</h2><span id="entry-count" class="section-note" aria-live="polite"></span></div>
<div class="entry-tools"><input id="search" type="search" maxlength="256" aria-label="Search events and exports" placeholder="Search names, types or source files…"><select id="kind" aria-label="Entry type"><option value="all">All entries</option><option value="event">Events / callbacks</option><option value="export">Exports</option></select></div>
<div id="no-entries" class="empty" hidden><h2>No matching entries</h2><p>Try another search or entry type.</p></div>
<table class="entries-table" id="entries-table"><thead><tr><th scope="col">Name</th><th scope="col">Type / side</th><th scope="col">Source</th></tr></thead><tbody id="entries"></tbody></table>
<nav class="pagination entry-pagination" aria-label="Entry pages"><button id="previous" disabled>Previous</button><span id="page-range">—</span><button id="next" disabled>Next</button></nav>
<p id="index-note" class="section-note index-note"></p>
</section>
</div>
</main>
<div id="status" class="status-bar" role="status" aria-live="polite">Choose a resource to view its details.</div>
</div><script nonce="${safeNonce}" src="${escapeAttribute(scriptUri)}"></script></body></html>`;
}
