import { browserStyles } from './browserStyles';

function escapeAttribute(value: string): string {
    return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

export function getSnippetHtml(scriptUri: string, nonce: string): string {
    const safeNonce = escapeAttribute(nonce);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${safeNonce}'; style-src 'nonce-${safeNonce}'; img-src 'none'; connect-src 'none'; font-src 'none';">
<title>FiveM Snippets</title>
<style nonce="${safeNonce}">
${browserStyles}
.toolbar { display:flex; flex-wrap:wrap; align-items:end; gap:8px; margin-top:12px; }
.toolbar .filter { margin-right:auto; }
.toolbar button,.toolbar select { min-height:34px; }
.description { white-space:pre-wrap; overflow-wrap:anywhere; margin:12px 0; }
.source-label { color:var(--vscode-descriptionForeground,#aaa); font-size:11px; overflow-wrap:anywhere; }
.preview-heading { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; margin-top:22px; }
.preview-heading h3 { margin:0; }
.preview-toggle { display:flex; align-items:center; gap:6px; font-size:11px; cursor:pointer; }
.preview-toggle input { accent-color:var(--vscode-focusBorder,#007fd4); }
.code-note { color:var(--vscode-descriptionForeground,#aaa); font-size:11px; margin:8px 0; }
.prefixes { display:flex; flex-wrap:wrap; gap:6px; }
.prefixes code { border:1px solid var(--vscode-panel-border,#454545); border-radius:3px; padding:2px 6px; overflow-wrap:anywhere; }
.issues { flex:none; margin:0; border:0; border-bottom:1px solid var(--vscode-inputValidation-warningBorder,#9d8b10); border-radius:0; color:var(--vscode-inputValidation-warningForeground,var(--vscode-foreground,#ddd)); background:var(--vscode-inputValidation-warningBackground,#352a05); padding:8px 16px; }
.issues summary { cursor:pointer; font-size:12px; }
.issues ul { margin:8px 0 2px; padding-left:20px; max-height:105px; overflow:auto; font-size:11px; }
.issues li { overflow-wrap:anywhere; }
#catalog-error { margin:0; border-radius:0; }
@media(max-width:650px) { .toolbar { align-items:center; } .toolbar .filter { flex:1; min-width:110px; } .toolbar button,.toolbar select { padding:5px 7px; font-size:12px; } }
</style>
</head>
<body><div class="app">
<header>
<div class="eyebrow">Qbox Lua / Snippets</div>
<div class="heading"><h1>FiveM snippets</h1><span class="offline">Built-in recipes &amp; your library</span></div>
<div class="search-row"><input id="search" class="search-field" type="search" maxlength="256" aria-label="Search snippets" placeholder="Search names, prefixes or code…"><button id="refresh" title="Reload snippets" aria-label="Reload snippets">Refresh</button></div>
<div class="toolbar">
<div class="filter"><label for="source">Source</label><select id="source"><option value="all">All snippets</option><option value="builtin">Built-in recipes</option><option value="personal">Personal</option><option value="workspace">Workspace</option></select></div>
<button id="new" class="primary">New snippet</button><button id="save-selection" title="Save the selection from your last Lua editor">Save selection</button>
<select id="manage" aria-label="Open snippet JSON"><option value="">Manage JSON…</option><option value="personal">Personal JSON</option><option value="workspace">Workspace JSON</option></select>
</div>
</header>
<details id="issues" class="issues" hidden><summary id="issues-summary"></summary><ul id="issue-list"></ul></details>
<div id="catalog-error" class="notice" role="alert" hidden></div>
<main class="workspace">
<section class="results-pane" aria-label="Snippet results">
<div class="results-heading"><strong id="result-count" aria-live="polite">Loading snippets…</strong><span>50 per page</span></div>
<div id="no-results" class="empty" hidden><h2>No matching snippets</h2><p>Try another search or source, or create a new snippet.</p></div>
<ul id="results" role="listbox" aria-label="Snippets" aria-busy="true"></ul>
<nav class="pagination" aria-label="Snippet pages"><button id="previous" disabled>Previous</button><span id="page-range">—</span><button id="next" disabled>Next</button></nav>
</section>
<section class="detail-pane" aria-label="Snippet details">
<div id="detail-empty" class="empty"><h2>Your FiveM recipe library</h2><p>Select a snippet to preview its code, copy it or insert it into your Lua file.</p></div>
<article id="detail" hidden>
<div id="detail-kind" class="detail-kind"></div><h2 id="detail-name"></h2><p id="source-label" class="source-label"></p><p id="description" class="description"></p>
<div id="prefix-section"><h3 class="section-label">Prefixes</h3><div id="prefixes" class="prefixes"></div></div>
<div class="actions"><button id="insert" class="primary" disabled>Insert snippet</button><button id="copy" title="Copy the exact snippet body, including placeholders">Copy snippet</button><button id="edit" hidden>Edit</button><button id="duplicate">Duplicate…</button></div>
<p id="target" class="target">Open a Lua file and place the cursor to insert snippets.</p>
<div class="preview-heading"><h3 id="code-heading" class="section-label">Snippet syntax</h3><label id="preview-toggle" class="preview-toggle" hidden><input id="show-body" type="checkbox">Show snippet syntax</label></div>
<p id="code-note" class="code-note"></p><pre><code id="code"></code></pre>
</article>
</section>
</main>
<div id="status" class="status-bar" role="status" aria-live="polite">Loading your snippet library.</div>
</div><script nonce="${safeNonce}" src="${escapeAttribute(scriptUri)}"></script></body></html>`;
}
