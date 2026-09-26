import { browserStyles } from './browserStyles';

function attribute(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!); }
export function getAssetHtml(scriptUri: string, nonce: string): string {
    const safe = attribute(nonce);
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${safe}'; style-src 'nonce-${safe}'; img-src data:; media-src data:; connect-src 'none'; font-src 'none';">
<title>FiveM Resource Assets</title><style nonce="${safe}">${browserStyles}
.asset-heading { display:flex; align-items:center; justify-content:space-between; gap:10px; margin:4px 0 8px; }
.asset-heading h1 { overflow-wrap:anywhere; }
.resource-path { font:11px/1.5 var(--vscode-editor-font-family,monospace); color:var(--vscode-descriptionForeground,#aaa); overflow-wrap:anywhere; margin:0 0 12px; }
.toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.toolbar select { margin-left:auto; }
.counts { font-size:11px; color:var(--vscode-descriptionForeground,#aaa); margin:10px 0 0; }
.asset-tools { display:flex; gap:8px; padding:10px 12px; }
.asset-tools input { width:100%; }
.asset-tools select { max-width:120px; }
.detail-pane { padding:20px 22px; }
.asset-title { font:600 17px/1.5 var(--vscode-editor-font-family,monospace); overflow-wrap:anywhere; margin:0 0 10px; }
.asset-actions { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:18px; }
.asset-actions button { padding:5px 8px; font-size:11px; }
.metadata { display:grid; grid-template-columns:minmax(95px,.35fr) minmax(0,1fr); gap:5px 12px; font-size:12px; margin:15px 0; }
.metadata dt { color:var(--vscode-descriptionForeground,#aaa); }
.metadata dd { margin:0; overflow-wrap:anywhere; }
.notes { padding-left:18px; color:var(--vscode-descriptionForeground,#aaa); font-size:11px; overflow-wrap:anywhere; }
.texture-controls { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin:12px 0; }
.texture-controls label { font-size:11px; color:var(--vscode-descriptionForeground,#aaa); }
.texture-controls select { min-width:0; max-width:100%; }
#textures { flex:1; width:100%; }
#texture-search { width:100%; }
.preview { overflow:auto; max-height:440px; min-height:80px; border:1px solid var(--vscode-panel-border,#383838); border-radius:4px; display:flex; align-items:center; justify-content:center; background-color:#aaa; background-image:linear-gradient(45deg,#ccc 25%,transparent 25%),linear-gradient(-45deg,#ccc 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#ccc 75%),linear-gradient(-45deg,transparent 75%,#ccc 75%); background-size:20px 20px; background-position:0 0,0 10px,10px -10px,-10px 0; }
.preview canvas,.preview img,.preview video { display:block; max-width:100%; max-height:420px; object-fit:contain; }
.preview canvas { image-rendering:pixelated; }
.preview[data-zoom="actual"] { justify-content:flex-start; align-items:flex-start; }
.preview[data-zoom="actual"] canvas,.preview[data-zoom="actual"] img { max-width:none; max-height:none; flex-shrink:0; }
.preview audio { width:100%; margin:20px 10px; }
.preview-note { color:var(--vscode-descriptionForeground,#aaa); font-size:11px; margin:8px 0; }
.text-preview { max-height:360px; overflow:auto; font-size:11px; }
.report { flex:1; min-height:0; overflow:auto; padding:20px 24px; }
.report-tools { display:flex; gap:8px; margin-bottom:12px; }
.report-tools input { flex:1; min-width:0; }
.report-list { list-style:none; padding:0; margin:0; }
.report-item { border:1px solid var(--vscode-panel-border,#383838); border-radius:4px; padding:12px 14px; margin:0 0 9px; }
.report-name { display:block; font:12px/1.5 var(--vscode-editor-font-family,monospace); overflow-wrap:anywhere; }
.report-note { display:block; font-size:11px; color:var(--vscode-descriptionForeground,#aaa); overflow-wrap:anywhere; margin:5px 0; }
.source-button { padding:0; background:transparent; border:0; border-radius:0; color:var(--vscode-textLink-foreground,#4daafc); text-align:left; overflow-wrap:anywhere; font-size:11px; }
.source-button:hover:not(:disabled) { background:transparent; text-decoration:underline; }
.target-links { display:flex; flex-direction:column; align-items:flex-start; gap:5px; margin-top:7px; }
.issue-level { font-size:10px; text-transform:uppercase; color:var(--vscode-descriptionForeground,#aaa); display:block; margin-bottom:4px; }
.snapshot-notes { font-size:11px; color:var(--vscode-descriptionForeground,#aaa); padding:10px 14px; border-left:3px solid var(--vscode-panel-border,#444); margin:0 0 20px; }
.snapshot-notes ul { margin:0; padding-left:15px; }
.reference-focus { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin:12px 0; font-size:12px; overflow-wrap:anywhere; }
.reference-focus button { margin-left:auto; font-size:11px; }
#error { margin:0; border-radius:0; }
#loading { padding:10px 24px; color:var(--vscode-descriptionForeground,#aaa); font-size:12px; }
@media(max-width:650px) { .asset-tools { flex-wrap:wrap; } .asset-tools select { max-width:none; width:100%; } .report { padding:16px; } .asset-heading h1 { font-size:19px; } }
</style></head><body><div class="app"><header><div class="eyebrow">Qbox Lua / Assets</div><div class="asset-heading"><h1 id="resource-name">Resource assets</h1><button id="refresh" disabled>Refresh</button></div><p id="resource-path" class="resource-path">Choose a resource to inspect its assets.</p><div class="toolbar"><button id="choose">Choose resource…</button><select id="mode" aria-label="Asset browser view"><option value="assets">Assets</option><option value="references">References</option><option value="health">Health checks</option></select></div><p id="counts" class="counts">Inventory and local source references</p></header>
<div id="loading" role="status">Loading resource assets…</div><div id="error" class="notice" role="alert" hidden></div>
<main id="workspace" class="workspace" hidden><section class="results-pane" aria-label="Asset files"><div class="asset-tools"><input id="search" type="search" maxlength="256" aria-label="Search assets" placeholder="Name, path, hash…"><select id="category" aria-label="Asset type"><option value="all">All types</option><option value="texture">YTD / DDS</option><option value="model">Models</option><option value="map">Maps / particles</option><option value="image">Images</option><option value="audio">Audio</option><option value="video">Video</option><option value="metadata">Metadata</option><option value="other">Other</option></select></div><div class="results-heading"><span id="result-count">0 assets</span></div><ul id="results" role="listbox" aria-label="Assets"></ul><nav class="pagination" aria-label="Asset pages"><button id="previous" disabled>Previous</button><span id="page-range">0</span><button id="next" disabled>Next</button></nav></section>
<section class="detail-pane" aria-label="Asset details"><div id="empty" class="empty"><h2>Select an asset</h2><p>Inspect textures, media, metadata and their local source references.</p></div><div id="detail" hidden><h2 id="detail-title" class="asset-title"></h2><div class="asset-actions"><button id="open-asset">Open file</button><button id="copy-name">Copy name</button><button id="copy-hash">Copy hash</button><button id="find-references">Show references</button></div><dl id="metadata" class="metadata"></dl><ul id="detail-notes" class="notes"></ul>
<div id="texture-tools" hidden><input id="texture-search" type="search" maxlength="256" aria-label="Find texture in dictionary" placeholder="Filter texture names…"><div class="texture-controls"><select id="textures" aria-label="Texture"></select><label for="mip">Mip</label><select id="mip"></select><select id="channels" aria-label="Preview channels"><option value="rgba">RGBA</option><option value="rgb">RGB</option><option value="alpha">Alpha</option></select><select id="zoom" aria-label="Preview scale"><option value="fit">Fit</option><option value="actual">100%</option></select></div></div><div id="preview" class="preview" hidden></div><p id="preview-note" class="preview-note"></p><pre id="text-preview" class="text-preview" hidden></pre></div></section></main>
<main id="report" class="report" hidden><aside id="snapshot-notes" class="snapshot-notes"><ul id="note-list"></ul></aside><div class="report-tools"><input id="report-search" type="search" maxlength="256" aria-label="Search references or health checks" placeholder="Search names, paths or findings…"><select id="report-filter" aria-label="Report filter"><option value="all">All entries</option><option value="unresolved">Without local match</option><option value="warning">Warnings</option></select></div><div id="reference-focus" class="reference-focus" hidden><span id="reference-focus-label"></span><button id="reference-focus-clear">Show all references</button></div><p id="report-count" class="preview-note"></p><ul id="report-list" class="report-list"></ul><nav class="pagination" aria-label="Report pages"><button id="report-previous" disabled>Previous</button><span id="report-range">0</span><button id="report-next" disabled>Next</button></nav></main><div id="status" class="status-bar" role="status" aria-live="polite">Read-only local asset inspection.</div></div><script nonce="${safe}" src="${attribute(scriptUri)}"></script></body></html>`;
}
