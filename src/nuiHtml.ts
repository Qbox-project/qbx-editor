import { browserStyles } from './browserStyles';

function escapeAttribute(value: string): string {
    return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

function localFrameOrigin(value: string | undefined): string {
    if (!value) { return ''; }
    try {
        const parsed = new URL(value);
        return parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
            && !parsed.username && !parsed.password && parsed.pathname === '/' && !parsed.search && !parsed.hash
            ? parsed.origin : '';
    } catch { return ''; }
}

export function getNuiHtml(scriptUri: string, nonce: string, frameOrigin?: string): string {
    const safeNonce = escapeAttribute(nonce);
    const origin = localFrameOrigin(frameOrigin);
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${safeNonce}'; style-src 'nonce-${safeNonce}'; frame-src ${origin || "'none'"}; img-src 'none'; connect-src 'none'; font-src 'none';">
<title>FiveM NUI Preview</title><style nonce="${safeNonce}">
${browserStyles}
textarea { box-sizing:border-box; width:100%; resize:vertical; min-height:115px; padding:9px 10px; border:1px solid var(--vscode-input-border,transparent); border-radius:3px; color:var(--vscode-input-foreground,#eee); background:var(--vscode-input-background,#313131); font:12px/1.5 var(--vscode-editor-font-family,monospace); tab-size:2; }
textarea:focus-visible,summary:focus-visible { outline:2px solid var(--vscode-focusBorder,#007fd4); outline-offset:2px; }
textarea:disabled { opacity:.5; }
.nui-heading { display:flex; justify-content:space-between; align-items:center; gap:12px; margin:5px 0 8px; }
.nui-heading h1 { overflow-wrap:anywhere; min-width:0; }
.preview-state { font-size:11px; color:var(--vscode-descriptionForeground,#aaa); padding:2px 7px; border:1px solid var(--vscode-panel-border,#444); border-radius:3px; white-space:nowrap; }
.resource-path { font:11px/1.5 var(--vscode-editor-font-family,monospace); color:var(--vscode-descriptionForeground,#aaa); overflow-wrap:anywhere; margin:0 0 5px; }
.ui-page { margin:0 0 13px; font-size:12px; overflow-wrap:anywhere; }
.ui-page span { color:var(--vscode-descriptionForeground,#aaa); margin-right:7px; }
.header-actions { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.build-note { flex:1; color:var(--vscode-descriptionForeground,#aaa); font-size:11px; }
.nui-main { flex:1; min-height:0; overflow:auto; padding:18px 24px 26px; }
.preview-workspace { display:grid; grid-template-columns:minmax(0,1fr) minmax(290px,340px); gap:18px; align-items:start; }
.section-heading { display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; margin:0 0 10px; }
.section-heading h2 { margin:0; font-size:15px; font-weight:600; }
.section-note { color:var(--vscode-descriptionForeground,#aaa); font-size:11px; margin:6px 0 10px; }
.preview-pane { min-width:0; }
.preview-box { display:flex; flex-direction:column; height:max(390px,55vh); border:1px solid var(--vscode-panel-border,#383838); border-radius:4px; background:var(--vscode-sideBar-background,#252526); overflow:hidden; }
.preview-box iframe { width:100%; height:100%; flex:1; border:0; background:#fff; }
.preview-box .empty { margin:auto; }
.preview-box .empty p { max-width:390px; }
.notes { font-size:11px; color:var(--vscode-descriptionForeground,#aaa); padding:0 0 0 17px; margin:10px 0 0; }
.notes li { overflow-wrap:anywhere; }
.workbench { min-width:0; }
.tool-section { margin-bottom:18px; padding-bottom:17px; border-bottom:1px solid var(--vscode-panel-border,#383838); }
.tool-section:last-child { border-bottom:0; margin-bottom:0; padding-bottom:0; }
.tool-section h2 { font-size:14px; margin:0 0 10px; font-weight:600; }
.tool-section label { display:block; font-size:11px; color:var(--vscode-descriptionForeground,#aaa); margin:8px 0 5px; }
.preset-row { display:flex; gap:7px; align-items:center; }
.preset-row select,.preset-row input { flex:1; min-width:0; width:100%; }
.payload-actions { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:7px; margin-top:7px; }
.payload-size { color:var(--vscode-descriptionForeground,#aaa); font-size:10px; }
.draft-note { min-height:17px; font-size:11px; color:var(--vscode-descriptionForeground,#aaa); margin:7px 0 0; }
.validation { color:var(--vscode-errorForeground,#f48771); font-size:11px; overflow-wrap:anywhere; margin:7px 0 0; }
.audit-workspace { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:18px; margin-top:23px; }
.audit-panel { min-width:0; border-top:1px solid var(--vscode-panel-border,#383838); padding-top:16px; }
.callback-search { width:100%; margin-bottom:8px; }
.callback-list,.activity-list { list-style:none; padding:0; margin:0; max-height:310px; overflow:auto; }
.callback-item { display:flex; justify-content:space-between; align-items:center; gap:9px; padding:9px 0; border-bottom:1px solid var(--vscode-panel-border,#383838); }
.callback-item > div { min-width:0; }
.callback-name { display:block; font:12px/1.5 var(--vscode-editor-font-family,monospace); overflow-wrap:anywhere; }
.callback-source { display:block; font-size:10px; color:var(--vscode-descriptionForeground,#aaa); overflow-wrap:anywhere; margin-top:3px; }
.callback-item button { white-space:nowrap; padding:4px 7px; font-size:11px; }
.audit-empty { color:var(--vscode-descriptionForeground,#aaa); padding:14px 0; font-size:12px; }
.activity-item { padding:9px 0; border-bottom:1px solid var(--vscode-panel-border,#383838); }
.activity-item summary { cursor:pointer; overflow-wrap:anywhere; font-size:12px; }
.activity-name { font-family:var(--vscode-editor-font-family,monospace); }
.activity-meta { color:var(--vscode-descriptionForeground,#aaa); font-size:10px; margin-left:7px; }
.activity-item pre { max-height:160px; overflow:auto; font-size:11px; margin:5px 0 9px; padding:8px; }
.activity-label { font-size:10px; color:var(--vscode-descriptionForeground,#aaa); margin:8px 0 3px; }
.activity-sources { display:flex; flex-direction:column; align-items:flex-start; gap:5px; margin:8px 0; }
.activity-sources button { text-align:left; font-size:11px; overflow-wrap:anywhere; }
.activity-error { color:var(--vscode-errorForeground,#f48771); font-size:11px; white-space:pre-wrap; overflow-wrap:anywhere; margin:4px 0; }
.notice-bar { margin:0; padding:8px 24px; border-bottom:1px solid var(--vscode-panel-border,#383838); font-size:12px; overflow-wrap:anywhere; }
.notice-bar[data-kind=error] { color:var(--vscode-errorForeground,#f48771); }
@media(max-width:920px) { .preview-workspace { grid-template-columns:minmax(0,1fr); } .preview-box { height:420px; } .workbench { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:16px; } .tool-section:first-child { grid-column:1/-1; } .tool-section { margin:0; padding-bottom:0; border-bottom:0; } .tool-section:first-child { padding-bottom:13px; border-bottom:1px solid var(--vscode-panel-border,#383838); } }
@media(max-width:650px) { .nui-main { padding:16px; } .nui-heading h1 { font-size:19px; } .audit-workspace { grid-template-columns:minmax(0,1fr); } .preview-box { height:350px; } .build-note { flex-basis:100%; } }
@media(max-width:470px) { .workbench { display:block; } .tool-section { padding:0 0 16px; margin:0 0 16px; border-bottom:1px solid var(--vscode-panel-border,#383838); } .preview-state { white-space:normal; } .preset-row { flex-wrap:wrap; } .preview-box { height:300px; } }
body.vscode-high-contrast textarea,body.vscode-high-contrast-light textarea { border-color:var(--vscode-contrastBorder); }
</style></head><body data-frame-origin="${escapeAttribute(origin)}"><div class="app">
<header><div class="eyebrow">Qbox Lua / NUI</div><div class="nui-heading"><h1 id="resource-name">NUI preview</h1><span id="preview-state" class="preview-state">No preview</span></div>
<p id="resource-path" class="resource-path">Choose a resource with a local NUI page.</p><p class="ui-page"><span>UI page</span><code id="ui-page">—</code></p>
<div class="header-actions"><button id="choose">Choose resource…</button><button id="reload" disabled>Reload preview</button><span class="build-note">Build your UI locally, then reload to see its latest files.</span></div></header>
<div id="notice" class="notice-bar" role="status" aria-live="polite" hidden></div>
<main class="nui-main"><div class="preview-workspace"><section class="preview-pane" aria-labelledby="preview-title"><div class="section-heading"><h2 id="preview-title">Preview</h2><span class="section-note">Isolated local UI</span></div>
<div class="preview-box"><div id="preview-empty" class="empty"><h2 id="empty-title">Choose a NUI resource</h2><p id="empty-description">Preview a local built UI, send messages and try mocked callback responses.</p></div><iframe id="preview" title="FiveM NUI preview" sandbox="allow-scripts" referrerpolicy="no-referrer" hidden></iframe></div><ul id="notes" class="notes" hidden></ul></section>
<aside class="workbench" aria-label="NUI controls"><section class="tool-section"><h2>Presets</h2><label for="presets">Saved for this resource</label><div class="preset-row"><select id="presets" disabled><option value="">Unsaved draft</option></select><button id="delete-preset" disabled>Delete</button></div><label for="preset-name">Preset name</label><div class="preset-row"><input id="preset-name" type="text" maxlength="80" placeholder="Inventory open" disabled><button id="save-preset" disabled>Save</button></div><p id="draft-note" class="draft-note">Select a resource to use presets.</p></section>
<section class="tool-section"><h2>Message</h2><label for="message">JSON sent to the page’s message listener</label><textarea id="message" spellcheck="false" disabled>{}</textarea><div class="payload-actions"><span id="message-size" class="payload-size">0 / 65,536 bytes</span><button id="send" class="primary" disabled>Send message</button></div><p id="message-error" class="validation" role="status" hidden></p></section>
<section class="tool-section"><h2>Mock responses</h2><label for="mocks">JSON object keyed by NUI callback name</label><textarea id="mocks" spellcheck="false" disabled>{}</textarea><div class="payload-actions"><span id="mocks-size" class="payload-size">0 / 65,536 bytes</span><button id="apply-mocks" disabled>Apply mocks</button></div><p class="section-note">Each matching callback receives its configured JSON value. Mocks stay in this preview.</p><p id="mocks-error" class="validation" role="status" hidden></p></section></aside></div>
<div class="audit-workspace"><section class="audit-panel" aria-labelledby="callbacks-title"><div class="section-heading"><h2 id="callbacks-title">Lua callbacks</h2><span id="callback-count" class="section-note">0 callbacks</span></div><input id="callback-search" class="callback-search" type="search" maxlength="256" aria-label="Filter Lua callbacks" placeholder="Filter callback names or source files…"><ul id="callbacks" class="callback-list"></ul><p id="callback-empty" class="audit-empty">Select a resource to view its indexed callbacks.</p><p id="callback-note" class="section-note"></p></section>
<section class="audit-panel" aria-labelledby="activity-title"><div class="section-heading"><h2 id="activity-title">Callback activity</h2><span id="activity-count" class="section-note">Latest 30</span></div><p id="activity-empty" class="audit-empty">Requests and mock responses will appear here when the preview calls a callback.</p><ul id="activity" class="activity-list"></ul><p class="section-note">Activity is limited to this preview. Lua handlers are not executed.</p></section></div></main>
<div id="status" class="status-bar" role="status" aria-live="polite">Choose a resource to begin.</div></div><script nonce="${safeNonce}" src="${escapeAttribute(scriptUri)}"></script></body></html>`;
}
