/** Layout shared by the single-file asset viewers, on top of `browserStyles`. */
export const viewerStyles = `
.viewer-heading { display:flex; align-items:center; justify-content:space-between; gap:10px; margin:4px 0 4px; }
.viewer-heading h1 { overflow-wrap:anywhere; font-family:var(--vscode-editor-font-family,monospace); font-size:19px; letter-spacing:0; }
.viewer-actions { display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end; }
.viewer-path { font:11px/1.5 var(--vscode-editor-font-family,monospace); color:var(--vscode-descriptionForeground,#aaa); overflow-wrap:anywhere; margin:0 0 12px; }
.viewer-bar { display:flex; align-items:flex-end; justify-content:space-between; gap:12px; flex-wrap:wrap; }
.viewer-options { display:flex; align-items:center; gap:6px; font-size:11px; color:var(--vscode-descriptionForeground,#aaa); }
.viewer-options select { padding:3px 6px; font-size:11px; }
.tabs { display:flex; gap:2px; flex-wrap:wrap; }
.tabs button { background:transparent; border:0; border-bottom:2px solid transparent; border-radius:0; padding:6px 10px; color:var(--vscode-descriptionForeground,#aaa); }
.tabs button:hover:not(:disabled) { background:transparent; color:var(--vscode-foreground,#ddd); }
.tabs button[aria-selected="true"] { color:var(--vscode-foreground,#ddd); border-bottom-color:var(--vscode-focusBorder,#007fd4); }
.viewer-loading { padding:10px 24px; color:var(--vscode-descriptionForeground,#aaa); font-size:12px; }
.viewer-error { margin:12px 24px; }
.viewer-panel { flex:1; min-height:0; }
.viewer-panel.scroll { overflow:auto; padding:18px 24px; }
.viewer-panel.split { display:grid; grid-template-columns:minmax(0,1fr) minmax(240px,320px); }
.table-pane { display:flex; flex-direction:column; min-width:0; min-height:0; }
.table-tools { display:flex; gap:8px; padding:10px 12px; flex:none; }
.table-tools input { flex:1; }
.table-tools select { max-width:45%; }
.table-scroll { flex:1; min-height:0; overflow:auto; }
table.data { margin:0; font-size:12px; }
table.data th { position:sticky; top:0; z-index:1; white-space:nowrap; }
table.data td { font-family:var(--vscode-editor-font-family,monospace); }
table.data th.num,table.data td.num { text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; }
table.data tbody tr { cursor:pointer; }
table.data tbody tr:hover { background:var(--vscode-list-hoverBackground,#2b2d2e); }
table.data tbody tr[aria-selected="true"] { background:var(--vscode-list-activeSelectionBackground,#04395e); color:var(--vscode-list-activeSelectionForeground,#fff); }
table.data tbody tr:focus-visible { outline:2px solid var(--vscode-focusBorder,#007fd4); outline-offset:-2px; }
td .muted,.muted { color:var(--vscode-descriptionForeground,#aaa); }
table.data tbody tr[aria-selected="true"] .muted { color:inherit; opacity:.8; }
.detail-side { border-left:1px solid var(--vscode-panel-border,#383838); overflow:auto; padding:16px 18px; min-width:0; }
.detail-name { font:600 14px/1.4 var(--vscode-editor-font-family,monospace); overflow-wrap:anywhere; margin:0 0 4px; }
.detail-sub { font-size:11px; color:var(--vscode-descriptionForeground,#aaa); margin:0 0 10px; overflow-wrap:anywhere; }
.facts { display:grid; grid-template-columns:minmax(120px,max-content) minmax(0,1fr); gap:6px 16px; font-size:12px; margin:0 0 16px; }
.facts dt { color:var(--vscode-descriptionForeground,#aaa); }
.facts dd { margin:0; overflow-wrap:anywhere; font-family:var(--vscode-editor-font-family,monospace); }
.facts.compact { grid-template-columns:minmax(70px,max-content) minmax(0,1fr); gap:4px 10px; margin:10px 0; }
.viewer-notes { padding-left:18px; color:var(--vscode-descriptionForeground,#aaa); font-size:12px; overflow-wrap:anywhere; margin:0 0 16px; }
.copy-row { display:flex; flex-wrap:wrap; gap:5px; margin:8px 0; }
.copy-row button { padding:4px 8px; font-size:11px; }
.section-label.first { margin-top:0; }
.link-list { list-style:none; padding:0; margin:0; font-size:12px; }
.link-list li { margin:4px 0; }
.link { padding:0; background:transparent; border:0; border-radius:0; color:var(--vscode-textLink-foreground,#4daafc); text-align:left; overflow-wrap:anywhere; font-family:var(--vscode-editor-font-family,monospace); }
.link:hover:not(:disabled) { background:transparent; text-decoration:underline; }
.card { border:1px solid var(--vscode-panel-border,#383838); border-radius:4px; padding:14px 16px; margin:0 0 16px; }
.card h2 { font:600 15px/1.4 var(--vscode-editor-font-family,monospace); margin:0 0 2px; overflow-wrap:anywhere; }
.card h3 { font-size:12px; font-weight:600; margin:16px 0 6px; }
.card table.data th { position:static; }
.card .table-scroll { overflow-x:auto; }
.row-actions { display:flex; gap:4px; flex-wrap:wrap; justify-content:flex-end; }
.row-actions button { padding:2px 6px; font-size:10px; }
@media(max-width:760px) { .viewer-panel.split { grid-template-columns:1fr; grid-template-rows:minmax(0,1fr) auto; } .detail-side { border-left:0; border-top:1px solid var(--vscode-panel-border,#383838); max-height:45%; } .viewer-panel.scroll { padding:14px 16px; } }
`;
