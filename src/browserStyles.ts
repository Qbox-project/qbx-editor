/** Shared VS Code themed layout for the reference and snippet editor tabs. */
export const browserStyles = `* { box-sizing: border-box; }
html,body { height:100%; }
body { margin:0; color:var(--vscode-foreground,#ddd); background:var(--vscode-editor-background,#1f1f1f); font:var(--vscode-font-size,13px)/1.5 var(--vscode-font-family,system-ui,sans-serif); }
button,input,select { font:inherit; }
button,select { cursor:pointer; }
button,input,select { border:1px solid var(--vscode-input-border,transparent); border-radius:3px; }
button:focus-visible,input:focus-visible,select:focus-visible,[tabindex]:focus-visible,a:focus-visible { outline:2px solid var(--vscode-focusBorder,#007fd4); outline-offset:2px; }
input,select { color:var(--vscode-input-foreground,#eee); background:var(--vscode-input-background,#313131); padding:7px 9px; min-width:0; }
button { background:var(--vscode-button-secondaryBackground,#37373d); color:var(--vscode-button-secondaryForeground,#fff); padding:6px 10px; }
button:hover:not(:disabled) { background:var(--vscode-button-secondaryHoverBackground,#45454d); }
button:disabled { opacity:.5; cursor:default; }
button.primary { color:var(--vscode-button-foreground,#fff); background:var(--vscode-button-background,#0078d4); }
button.primary:hover:not(:disabled) { background:var(--vscode-button-hoverBackground,#026ec1); }
[hidden] { display:none !important; }
.app { height:100%; display:flex; flex-direction:column; }
header { flex:none; padding:20px 24px 16px; border-bottom:1px solid var(--vscode-panel-border,#383838); }
.eyebrow { color:var(--vscode-descriptionForeground,#aaa); font-size:10px; letter-spacing:1.5px; font-weight:600; text-transform:uppercase; }
.heading { display:flex; justify-content:space-between; align-items:center; gap:12px; margin:3px 0 15px; }
h1 { font-size:22px; font-weight:600; margin:0; letter-spacing:-.5px; }
.offline { font-size:11px; color:var(--vscode-descriptionForeground,#aaa); white-space:nowrap; }
.search-row { display:flex; align-items:center; gap:8px; }
.search-field { flex:1; width:100%; padding:10px 12px; font-size:14px; }
.filters { display:flex; align-items:end; gap:12px; flex-wrap:wrap; margin-top:12px; }
.filter { display:flex; flex-direction:column; gap:4px; }
.filter label { font-size:11px; color:var(--vscode-descriptionForeground,#aaa); }
.filter select { min-width:145px; }
.workspace { display:grid; grid-template-columns:minmax(245px,34%) minmax(0,1fr); flex:1; min-height:0; }
.results-pane { display:flex; flex-direction:column; min-width:0; min-height:0; border-right:1px solid var(--vscode-panel-border,#383838); }
.results-heading { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:12px 16px; color:var(--vscode-descriptionForeground,#aaa); font-size:12px; flex:none; min-height:48px; }
.results-heading strong { color:var(--vscode-foreground,#ddd); font-weight:500; }
#results { margin:0; padding:0 6px 6px; list-style:none; overflow:auto; flex:1; }
.result { display:block; text-align:left; width:100%; padding:11px 10px; margin:2px 0; border:1px solid transparent; border-radius:3px; background:transparent; color:inherit; }
.result:hover:not(:disabled) { background:var(--vscode-list-hoverBackground,#2b2d2e); }
.result[aria-selected="true"] { background:var(--vscode-list-activeSelectionBackground,#04395e); color:var(--vscode-list-activeSelectionForeground,#fff); border-color:var(--vscode-focusBorder,#007fd4); }
.result-name { display:block; overflow-wrap:anywhere; font-family:var(--vscode-editor-font-family,monospace); font-size:12px; font-weight:500; }
.result-meta { display:flex; gap:8px; margin-top:5px; font-size:10px; opacity:.75; align-items:center; }
.result-meta .kind { text-transform:uppercase; letter-spacing:.5px; }
.pagination { display:flex; justify-content:space-between; align-items:center; gap:6px; padding:10px 12px; border-top:1px solid var(--vscode-panel-border,#383838); flex:none; font-size:11px; }
.pagination button { padding:4px 8px; }
.detail-pane { overflow:auto; min-height:0; padding:24px 28px; }
.empty { color:var(--vscode-descriptionForeground,#aaa); padding:28px 16px; text-align:center; }
.empty h2 { color:var(--vscode-foreground,#ddd); font-size:17px; font-weight:500; }
.empty p { max-width:330px; margin:8px auto; }
.detail-kind { font-size:11px; text-transform:uppercase; letter-spacing:1px; color:var(--vscode-descriptionForeground,#aaa); }
#detail-name { margin:6px 0 9px; font-size:21px; font-weight:600; line-height:1.35; overflow-wrap:anywhere; }
.badges { display:flex; flex-wrap:wrap; gap:7px; margin-bottom:18px; }
.badge { font-size:11px; padding:2px 7px; border-radius:3px; border:1px solid var(--vscode-panel-border,#454545); color:var(--vscode-descriptionForeground,#aaa); }
.actions { display:flex; gap:7px; flex-wrap:wrap; margin:16px 0 8px; }
.target { font-size:11px; color:var(--vscode-descriptionForeground,#aaa); margin:0 0 18px; overflow-wrap:anywhere; }
.section-label { font-size:12px; font-weight:600; margin:21px 0 7px; }
pre { white-space:pre-wrap; overflow-wrap:anywhere; background:var(--vscode-textCodeBlock-background,#292929); padding:12px; border-radius:4px; margin:10px 0; }
code { font-family:var(--vscode-editor-font-family,monospace); font-size:12px; }
p code,li code,td code { background:var(--vscode-textCodeBlock-background,#292929); padding:1px 3px; border-radius:2px; }
table { width:100%; border-collapse:collapse; font-size:12px; margin:10px 0; }
th,td { text-align:left; vertical-align:top; padding:7px 9px; border:1px solid var(--vscode-panel-border,#383838); overflow-wrap:anywhere; }
th { font-weight:600; background:var(--vscode-sideBar-background,#252526); }
.documentation { line-height:1.65; overflow-wrap:anywhere; margin-top:20px; }
.documentation h1,.documentation h2,.documentation h3 { font-size:16px; margin-top:22px; font-weight:600; }
.documentation h4,.documentation h5,.documentation h6 { font-size:13px; }
.documentation blockquote { margin:12px 0; padding:2px 12px; border-left:3px solid var(--vscode-textBlockQuote-border,#457); background:var(--vscode-textBlockQuote-background,#252526); }
.documentation a { color:var(--vscode-textLink-foreground,#4daafc); text-decoration:underline; }
.documentation a:hover { color:var(--vscode-textLink-activeForeground,#73c2ff); }
.documentation hr { border:0; border-top:1px solid var(--vscode-panel-border,#383838); }
.notice { margin:10px 0; padding:9px 12px; border:1px solid var(--vscode-inputValidation-errorBorder,#be1100); color:var(--vscode-errorForeground,#f48771); border-radius:3px; }
.notice button { margin-top:8px; }
.status-bar { padding:7px 16px; font-size:11px; color:var(--vscode-descriptionForeground,#aaa); border-top:1px solid var(--vscode-panel-border,#383838); min-height:30px; }
@media(max-width:650px) { header { padding:14px 16px; } .workspace { grid-template-columns:minmax(195px,38%) minmax(0,1fr); } .detail-pane { padding:18px 16px; } .offline { display:none; } #detail-name { font-size:17px; } .filter select { min-width:120px; } }
@media(max-width:470px) { .workspace { display:flex; flex-direction:column; } .results-pane { flex:0 0 42%; border-right:0; border-bottom:1px solid var(--vscode-panel-border,#383838); } .detail-pane { flex:1; } .filters { gap:8px; } .filter { flex:1; } .filter select { min-width:0; width:100%; } }
body.vscode-high-contrast button,body.vscode-high-contrast-light button,body.vscode-high-contrast input,body.vscode-high-contrast-light input,body.vscode-high-contrast select,body.vscode-high-contrast-light select { border-color:var(--vscode-contrastBorder); }
`;
