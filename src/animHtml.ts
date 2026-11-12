import { browserStyles } from './browserStyles';
import { viewerStyles } from './viewerStyles';

function attribute(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!); }
export function getAnimHtml(scriptUri: string, nonce: string): string {
    const safe = attribute(nonce);
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${safe}'; style-src 'nonce-${safe}'; img-src 'none'; connect-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none';">
<title>FiveM Animation Dictionary</title><style nonce="${safe}">${browserStyles}${viewerStyles}
pre.snippet { font-size:11px; margin:6px 0 2px; }
.anim { flex:1; min-height:0; display:grid; grid-template-columns:minmax(230px,32%) minmax(0,1fr); }
.anim .table-pane { border-right:1px solid var(--vscode-panel-border,#383838); }
.anim-side { display:grid; grid-template-rows:minmax(200px,1fr) auto minmax(0,42%); min-width:0; min-height:0; }
.anim-stage { position:relative; min-height:0; overflow:hidden; }
#figure { position:absolute; inset:0; width:100%; height:100%; display:block; touch-action:none; cursor:grab; }
#figure:focus-visible { outline:2px solid var(--vscode-focusBorder,#007fd4); outline-offset:-2px; }
.anim-controls { display:flex; align-items:center; flex-wrap:wrap; gap:8px; padding:8px 14px; border-top:1px solid var(--vscode-panel-border,#383838); border-bottom:1px solid var(--vscode-panel-border,#383838); font-size:11px; }
.anim-controls input[type=range] { flex:1; min-width:120px; padding:0; }
.anim-controls select { padding:3px 6px; font-size:11px; }
.anim-controls label { display:flex; align-items:center; gap:4px; color:var(--vscode-descriptionForeground,#aaa); }
#time { font-family:var(--vscode-editor-font-family,monospace); white-space:nowrap; }
.anim-detail { overflow:auto; padding:14px 18px; min-height:0; }
.stage-message { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; padding:24px; text-align:center; color:var(--vscode-descriptionForeground,#aaa); pointer-events:none; }
@media(max-width:760px) { .anim { grid-template-columns:1fr; grid-template-rows:minmax(120px,30%) minmax(0,1fr); } .anim .table-pane { border-right:0; border-bottom:1px solid var(--vscode-panel-border,#383838); } }
</style></head><body><div class="app"><header><div class="eyebrow">Qbox Lua / Animation dictionary</div>
<div class="viewer-heading"><h1 id="title">Animation dictionary</h1><div class="viewer-actions"><button id="copy-dictionary">Copy dictionary name</button><button id="reload">Reload</button></div></div>
<p id="path" class="viewer-path"></p><p id="summary" class="hint"></p></header>
<div id="loading" class="viewer-loading" role="status">Reading animation dictionary…</div><div id="error" class="notice viewer-error" role="alert" hidden></div>
<main id="clips" class="anim" hidden><section class="table-pane"><div class="table-tools"><input id="search" type="search" maxlength="256" aria-label="Search clips" placeholder="Clip name or hash…"></div>
<div class="table-scroll"><table class="data"><thead><tr><th>Clip</th><th class="num">Length</th><th class="num">Frames</th><th class="num">FPS</th></tr></thead><tbody id="rows"></tbody></table></div>
<nav class="pagination" aria-label="Clip pages"><button id="previous">Previous</button><span id="range"></span><button id="next">Next</button></nav></section>
<section class="anim-side"><div class="anim-stage"><canvas id="figure" tabindex="0" aria-label="Skeleton preview of the selected clip. Drag to orbit, scroll to zoom. Space plays or pauses, the left and right arrow keys step one frame."></canvas><div id="figure-message" class="stage-message" hidden></div></div>
<div class="anim-controls"><button id="play" disabled>Play</button><input id="scrub" type="range" min="0" max="1000" value="0" aria-label="Position in the clip" disabled><span id="time">0.00 s</span>
<label for="speed">Speed</label><select id="speed"><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option></select>
<label><input id="loop" type="checkbox" checked>Loop</label><button id="copy-phase" disabled title="Copy the current position as a phase between 0 and 1">Copy phase</button><button id="reset">Reset view</button></div>
<aside id="detail" class="anim-detail" aria-label="Selected clip"></aside></section></main>
<div id="status" class="status-bar" role="status" aria-live="polite">Read-only view of a local file.</div></div><script nonce="${safe}" src="${attribute(scriptUri)}"></script></body></html>`;
}
