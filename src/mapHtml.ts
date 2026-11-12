import { browserStyles } from './browserStyles';
import { viewerStyles } from './viewerStyles';

function attribute(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!); }
export function getMapHtml(scriptUri: string, nonce: string): string {
    const safe = attribute(nonce);
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${safe}'; style-src 'nonce-${safe}'; img-src data:; connect-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none';">
<title>FiveM Map Viewer</title><style nonce="${safe}">${browserStyles}${viewerStyles}
.plot { flex:1; min-height:0; display:grid; grid-template-columns:minmax(0,1fr) minmax(230px,300px); }
.plot-stage { position:relative; min-width:0; min-height:0; overflow:hidden; }
#plot { position:absolute; inset:0; width:100%; height:100%; display:block; cursor:crosshair; touch-action:none; }
#plot:focus-visible { outline:2px solid var(--vscode-focusBorder,#007fd4); outline-offset:-2px; }
.plot-readout { position:absolute; left:10px; bottom:8px; padding:3px 8px; border-radius:3px; font:11px/1.5 var(--vscode-editor-font-family,monospace); background:var(--vscode-editorWidget-background,#252526); border:1px solid var(--vscode-panel-border,#383838); pointer-events:none; }
.plot-tools { position:absolute; right:10px; top:8px; display:flex; gap:4px; }
.plot-tools button { padding:3px 8px; font-size:11px; }
.plot-side { border-left:1px solid var(--vscode-panel-border,#383838); overflow:auto; padding:14px 16px; min-width:0; }
.layers { list-style:none; margin:0 0 6px; padding:0; }
.layers label { display:flex; gap:7px; align-items:center; padding:2px 0; font-size:12px; overflow-wrap:anywhere; }
.swatch { flex:none; width:9px; height:9px; border-radius:50%; }
.hint { font-size:11px; color:var(--vscode-descriptionForeground,#aaa); margin:6px 0; }
@media(max-width:760px) { .plot { grid-template-columns:1fr; grid-template-rows:minmax(220px,1fr) auto; } .plot-side { border-left:0; border-top:1px solid var(--vscode-panel-border,#383838); max-height:45%; } }
</style></head><body><div class="app"><header><div class="eyebrow">Qbox Lua / Map data</div>
<div class="viewer-heading"><h1 id="title">Map file</h1><div class="viewer-actions"><button id="reload">Reload</button><button id="export">Open as XML</button></div></div>
<p id="path" class="viewer-path"></p>
<div class="viewer-bar"><div id="tabs" class="tabs" role="tablist" aria-label="Map file views"></div>
<div class="viewer-options"><label for="style">Copy as</label><select id="style"><option value="vec">vec3(x, y, z)</option><option value="vector">vector3(x, y, z)</option><option value="table">{ x =, y =, z = }</option><option value="plain">x, y, z</option></select>
<label for="precision">Decimals</label><select id="precision"><option>1</option><option>2</option><option>3</option><option>4</option></select></div></div></header>
<div id="loading" class="viewer-loading" role="status">Reading map file…</div><div id="error" class="notice viewer-error" role="alert" hidden></div>
<main id="panel-overview" class="viewer-panel scroll" role="tabpanel" hidden><dl id="facts" class="facts"></dl><ul id="notes" class="viewer-notes"></ul><div id="related" hidden><h2 class="section-label">Related files in this resource</h2><ul id="related-list" class="link-list"></ul></div></main>
<main id="panel-entities" class="viewer-panel split" role="tabpanel" hidden><section class="table-pane"><div class="table-tools"><input id="entity-search" type="search" maxlength="256" aria-label="Search entities" placeholder="Model name or hash…"><select id="entity-group" aria-label="Entity group"></select></div>
<div class="table-scroll"><table class="data"><thead><tr><th>Model</th><th>Where</th><th class="num">X</th><th class="num">Y</th><th class="num">Z</th><th class="num">Heading</th></tr></thead><tbody id="entity-rows"></tbody></table></div>
<nav class="pagination" aria-label="Entity pages"><button id="entity-previous">Previous</button><span id="entity-range"></span><button id="entity-next">Next</button></nav></section>
<aside id="entity-detail" class="detail-side" aria-label="Selected entity"></aside></main>
<main id="panel-plot" class="viewer-panel plot" role="tabpanel" hidden><div class="plot-stage"><canvas id="plot" tabindex="0" aria-label="Top-down map of entity positions. North is up. Use the Entities tab for a keyboard-accessible list."></canvas>
<div class="plot-tools"><button id="plot-fit" title="Fit everything">Fit</button><button id="plot-in" aria-label="Zoom in">+</button><button id="plot-out" aria-label="Zoom out">−</button></div><div id="plot-readout" class="plot-readout" aria-hidden="true"></div></div>
<aside class="plot-side"><h2 class="section-label first">Layers</h2><ul id="layers" class="layers"></ul><p class="hint">Drag to pan, scroll to zoom. Click an entity to select it. Click empty space to pick a point; hold Shift and drag to pick a point with a heading.</p><div id="plot-detail"></div></aside></main>
<main id="panel-interiors" class="viewer-panel scroll" role="tabpanel" hidden><div id="interiors"></div></main>
<main id="panel-archetypes" class="viewer-panel split" role="tabpanel" hidden><section class="table-pane"><div class="table-tools"><input id="archetype-search" type="search" maxlength="256" aria-label="Search archetypes" placeholder="Name, hash or dictionary…"></div>
<div class="table-scroll"><table class="data"><thead><tr><th>Name</th><th>Kind</th><th class="num">Size (m)</th><th class="num">LOD</th><th>Textures</th><th class="num">Placed</th></tr></thead><tbody id="archetype-rows"></tbody></table></div>
<nav class="pagination" aria-label="Archetype pages"><button id="archetype-previous">Previous</button><span id="archetype-range"></span><button id="archetype-next">Next</button></nav></section>
<aside id="archetype-detail" class="detail-side" aria-label="Selected archetype"></aside></main>
<main id="panel-cars" class="viewer-panel scroll" role="tabpanel" hidden><table class="data"><thead><tr><th>Model or group</th><th class="num">X</th><th class="num">Y</th><th class="num">Z</th><th class="num">Heading</th><th></th></tr></thead><tbody id="car-rows"></tbody></table></main>
<div id="status" class="status-bar" role="status" aria-live="polite">Read-only view of a local file.</div></div><script nonce="${safe}" src="${attribute(scriptUri)}"></script></body></html>`;
}
