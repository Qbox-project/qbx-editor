import { browserStyles } from './browserStyles';
import { viewerStyles } from './viewerStyles';

function attribute(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!); }
export function getModelHtml(scriptUri: string, nonce: string): string {
    const safe = attribute(nonce);
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${safe}'; style-src 'nonce-${safe}'; img-src data:; connect-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none';">
<title>FiveM Model Viewer</title><style nonce="${safe}">${browserStyles}${viewerStyles}
.model-tools { display:flex; flex-wrap:wrap; align-items:center; gap:8px 12px; font-size:12px; }
.model-tools select { padding:4px 8px; max-width:260px; }
.model-tools label { display:flex; align-items:center; gap:5px; color:var(--vscode-descriptionForeground,#aaa); }
.model-tools .spacer { flex:1; }
.stage { flex:1; min-height:0; display:grid; grid-template-columns:minmax(0,1fr) minmax(240px,320px); }
.stage-view { position:relative; min-width:0; min-height:0; overflow:hidden; background:var(--vscode-editor-background,#1f1f1f); }
#scene { position:absolute; inset:0; width:100%; height:100%; display:block; touch-action:none; cursor:grab; }
#scene:active { cursor:grabbing; }
#scene:focus-visible { outline:2px solid var(--vscode-focusBorder,#007fd4); outline-offset:-2px; }
.stage-note { position:absolute; left:10px; bottom:8px; right:10px; font-size:11px; color:var(--vscode-descriptionForeground,#aaa); pointer-events:none; }
.stage-message { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; padding:24px; text-align:center; color:var(--vscode-descriptionForeground,#aaa); }
.materials { list-style:none; margin:0; padding:0; font-size:12px; }
.materials li { display:grid; grid-template-columns:12px minmax(0,1fr); gap:2px 8px; padding:6px 0; border-bottom:1px solid var(--vscode-panel-border,#383838); }
.materials .swatch { width:10px; height:10px; border-radius:2px; margin-top:4px; }
.materials .name { font-family:var(--vscode-editor-font-family,monospace); overflow-wrap:anywhere; }
.materials .where { grid-column:2; font-size:11px; color:var(--vscode-descriptionForeground,#aaa); overflow-wrap:anywhere; }
@media(max-width:760px) { .stage { grid-template-columns:1fr; grid-template-rows:minmax(240px,1fr) auto; } .stage .detail-side { border-left:0; border-top:1px solid var(--vscode-panel-border,#383838); max-height:42%; } }
</style></head><body><div class="app"><header><div class="eyebrow">Qbox Lua / 3D model</div>
<div class="viewer-heading"><h1 id="title">Model file</h1><div class="viewer-actions"><button id="reload">Reload</button></div></div>
<p id="path" class="viewer-path"></p>
<div class="model-tools"><select id="drawable" aria-label="Drawable" hidden></select><select id="lod" aria-label="Detail level"></select>
<select id="shading" aria-label="Shading"><option value="textured">Textured</option><option value="solid">Solid</option><option value="materials">Material colours</option><option value="normals">Normals</option></select>
<label><input id="wireframe" type="checkbox">Wireframe</label><label><input id="grid" type="checkbox" checked>Grid</label><label><input id="box" type="checkbox">Bounding box</label>
<span class="spacer"></span><button id="reset">Reset view</button></div></header>
<div id="loading" class="viewer-loading" role="status">Reading model…</div><div id="error" class="notice viewer-error" role="alert" hidden></div>
<main id="stage" class="stage" hidden><div class="stage-view"><canvas id="scene" tabindex="0" aria-label="3D preview. Drag to orbit, hold Shift or use the right button to pan, scroll to zoom. Arrow keys orbit, plus and minus zoom, zero resets the view."></canvas>
<div id="stage-message" class="stage-message" hidden></div><div class="stage-note">Drag to orbit · Shift-drag or right-drag to pan · scroll to zoom · Z is up, the green axis is north (+Y)</div></div>
<aside class="detail-side" aria-label="Model details"><h2 id="drawable-name" class="detail-name"></h2><p id="drawable-sub" class="detail-sub"></p><dl id="facts" class="facts compact"></dl><div id="copy" class="copy-row"></div>
<div id="materials-section"><h2 id="materials-title" class="section-label">Materials</h2><ul id="materials" class="materials"></ul></div><ul id="notes" class="viewer-notes"></ul></aside></main>
<div id="status" class="status-bar" role="status" aria-live="polite">Read-only preview of a local file.</div></div><script nonce="${safe}" src="${attribute(scriptUri)}"></script></body></html>`;
}
