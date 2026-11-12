import { browserStyles } from './browserStyles';
import { viewerStyles } from './viewerStyles';

function attribute(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!); }
export function getTextureHtml(scriptUri: string, nonce: string): string {
    const safe = attribute(nonce);
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${safe}'; style-src 'nonce-${safe}'; img-src 'none'; connect-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none';">
<title>FiveM Texture Viewer</title><style nonce="${safe}">${browserStyles}${viewerStyles}
.textures { flex:1; min-height:0; display:grid; grid-template-columns:minmax(230px,34%) minmax(0,1fr); }
.textures .table-pane { border-right:1px solid var(--vscode-panel-border,#383838); }
.texture-side { display:flex; flex-direction:column; min-width:0; min-height:0; }
.texture-tools { display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding:8px 14px; border-bottom:1px solid var(--vscode-panel-border,#383838); font-size:11px; }
.texture-tools select { padding:3px 6px; font-size:11px; }
.texture-tools label { color:var(--vscode-descriptionForeground,#aaa); }
.texture-tools .divider { width:1px; align-self:stretch; background:var(--vscode-panel-border,#383838); }
.texture-stage { flex:1; min-height:120px; overflow:auto; display:flex; align-items:center; justify-content:center; background-color:#aaa; background-image:linear-gradient(45deg,#ccc 25%,transparent 25%),linear-gradient(-45deg,#ccc 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#ccc 75%),linear-gradient(-45deg,transparent 75%,#ccc 75%); background-size:20px 20px; background-position:0 0,0 10px,10px -10px,-10px 0; }
.texture-stage canvas { display:block; max-width:100%; max-height:100%; object-fit:contain; image-rendering:pixelated; }
.texture-stage[data-zoom="actual"] { justify-content:flex-start; align-items:flex-start; }
.texture-stage[data-zoom="actual"] canvas { max-width:none; max-height:none; flex-shrink:0; }
.texture-stage p { margin:0; padding:16px; color:#222; text-align:center; }
.texture-detail { flex:none; max-height:40%; overflow:auto; padding:12px 18px; border-top:1px solid var(--vscode-panel-border,#383838); }
.texture-detail .copy-row + .copy-row { margin-top:6px; }
.unsaved { color:var(--vscode-editorWarning-foreground,#cca700); }
@media(max-width:760px) { .textures { grid-template-columns:1fr; grid-template-rows:minmax(110px,28%) minmax(0,1fr); } .textures .table-pane { border-right:0; border-bottom:1px solid var(--vscode-panel-border,#383838); } }
</style></head><body><div class="app"><header><div class="eyebrow">Qbox Lua / Textures</div>
<div class="viewer-heading"><h1 id="title">Texture file</h1><div class="viewer-actions"><button id="add" hidden>Add or replace from PNG…</button><button id="export-all" hidden>Export all as PNG…</button><button id="copy-dictionary">Copy dictionary name</button><button id="reload">Reload</button></div></div>
<p id="path" class="viewer-path"></p><p id="summary" class="hint"></p><p id="unsaved" class="hint unsaved" hidden>Unsaved changes: save the file to keep them, or undo to step back.</p></header>
<div id="loading" class="viewer-loading" role="status">Reading textures…</div><div id="error" class="notice viewer-error" role="alert" hidden></div>
<main id="textures" class="textures" hidden><section class="table-pane"><div class="table-tools"><input id="search" type="search" maxlength="256" aria-label="Search textures" placeholder="Texture name or format…"></div>
<div class="table-scroll"><table class="data"><thead><tr><th>Texture</th><th class="num">Size</th><th>Format</th><th class="num">Mips</th></tr></thead><tbody id="rows"></tbody></table></div>
<nav class="pagination" aria-label="Texture pages"><button id="previous">Previous</button><span id="range"></span><button id="next">Next</button></nav></section>
<section class="texture-side"><div class="texture-tools"><label for="mip">Mip</label><select id="mip"></select><label for="channels">Channels</label><select id="channels"><option value="rgba">RGBA</option><option value="rgb">RGB</option><option value="alpha">Alpha</option></select>
<label for="zoom">Scale</label><select id="zoom"><option value="fit">Fit</option><option value="actual">100%</option></select>
<span id="import-tools" hidden><span class="divider"></span> <label for="compression">New images as</label> <select id="compression"><option value="auto">Automatic</option><option value="BC1">BC1 (DXT1), no transparency</option><option value="BC3">BC3 (DXT5), with transparency</option><option value="BC7">BC7, highest quality</option><option value="BGRA8">Uncompressed</option></select>
<label for="mipmaps">Mip levels</label> <select id="mipmaps"><option value="auto">Automatic</option><option value="all">Always generate</option><option value="none">None</option></select></span></div>
<div id="stage" class="texture-stage" data-zoom="fit"><p id="stage-message">Select a texture.</p></div><aside id="detail" class="texture-detail" aria-label="Selected texture"></aside></section></main>
<div id="status" class="status-bar" role="status" aria-live="polite">Reading the file.</div></div><script nonce="${safe}" src="${attribute(scriptUri)}"></script></body></html>`;
}
