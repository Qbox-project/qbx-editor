import { browserStyles } from './browserStyles';

function escapeAttribute(value: string): string {
    return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

/** The same markup is used in VS Code and in the local browser verification harness. */
export function getReferenceHtml(scriptUri: string, nonce: string): string {
    const safeNonce = escapeAttribute(nonce);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${safeNonce}'; style-src 'nonce-${safeNonce}'; img-src 'none'; connect-src 'none'; font-src 'none';">
<title>FiveM Reference</title>
<style nonce="${safeNonce}">
${browserStyles}</style>
</head>
<body><div class="app">
<header>
<div class="eyebrow">Qbox Lua / Reference</div>
<div class="heading"><h1>FiveM reference</h1><span class="offline">Available offline</span></div>
<div class="search-row"><input id="search" class="search-field" type="search" maxlength="256" aria-label="Search the FiveM reference" placeholder="Search names, hashes, IDs or bindings…"><button id="refresh" title="Refresh search" aria-label="Refresh search">Refresh</button></div>
<div class="filters">
<div class="filter"><label for="catalog">Catalog</label><select id="catalog"><option value="all">All references</option><option value="native">Natives</option><option value="control">Controls</option><option value="pedFlag">Ped config flags</option></select></div>
<div class="filter" id="side-filter"><label for="side">Availability</label><select id="side"><option value="all">All sides</option><option value="client">Client + shared</option><option value="server">Server + shared</option><option value="shared">Shared only</option></select></div>
<div class="filter" id="namespace-filter" hidden><label for="namespace">Namespace</label><select id="namespace"><option value="">All namespaces</option></select></div>
</div>
</header>
<main class="workspace">
<section class="results-pane" aria-label="Search results">
<div class="results-heading"><strong id="result-count" aria-live="polite">Loading reference…</strong><span id="page-size">50 per page</span></div>
<div id="search-error" class="notice" role="alert" hidden></div>
<div id="no-results" class="empty" hidden><h2>No matching references</h2><p>Try a name, numeric ID, native hash or another filter.</p></div>
<ul id="results" role="listbox" aria-label="Reference results" aria-busy="true"></ul>
<nav class="pagination" aria-label="Result pages"><button id="previous" disabled>Previous</button><span id="page-range">—</span><button id="next" disabled>Next</button></nav>
</section>
<section class="detail-pane" aria-label="Reference details">
<div id="detail-empty" class="empty"><h2>Explore the FiveM API</h2><p>Select a reference to read its documentation, copy it or insert it into your Lua file.</p></div>
<div id="detail-error" class="notice" role="alert" hidden></div>
<article id="detail" hidden>
<div id="detail-kind" class="detail-kind"></div><h2 id="detail-name"></h2><div id="detail-badges" class="badges"></div>
<pre id="signature-box" hidden><code id="signature"></code></pre>
<div class="actions"><button id="insert" class="primary">Insert</button><button id="copy">Copy</button><button id="copy-hash" hidden>Copy hash</button><button id="source">Documentation ↗</button></div>
<p id="target" class="target">Open a Lua file to insert references.</p>
<div id="parameters-section" hidden><h3 class="section-label">Parameters</h3><table><thead><tr><th scope="col">Name</th><th scope="col">Type</th></tr></thead><tbody id="parameters"></tbody></table></div>
<div id="returns-section" hidden><h3 class="section-label">Returns</h3><code id="returns"></code></div>
<div id="documentation" class="documentation"></div>
</article>
</section>
</main>
<div id="status" class="status-bar" role="status" aria-live="polite">Search the bundled reference.</div>
</div><script nonce="${safeNonce}" src="${escapeAttribute(scriptUri)}"></script></body></html>`;
}
