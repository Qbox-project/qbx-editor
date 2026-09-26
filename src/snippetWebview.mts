/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { filterSnippetCatalog, normalizeSnippetViewState, snippetPage } from './snippetViewState.js';
import type { RecipeSnippet, SnippetHostMessage, SnippetWebviewMessage } from './snippetTypes.js';

declare function acquireVsCodeApi(): {
    postMessage(message: SnippetWebviewMessage | { type: 'ready' }): void;
    getState(): unknown;
    setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();
function element<T extends HTMLElement = HTMLElement>(id: string): T {
    const found = document.getElementById(id);
    if (!found) { throw new Error(`Missing snippet element: ${id}`); }
    return found as T;
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
    const result = document.createElement(tag);
    if (text !== undefined) { result.textContent = text; }
    return result;
}

const searchInput = element<HTMLInputElement>('search');
const sourceInput = element<HTMLSelectElement>('source');
const manageInput = element<HTMLSelectElement>('manage');
const bodyInput = element<HTMLInputElement>('show-body');
const resultsList = element<HTMLUListElement>('results');
const previous = element<HTMLButtonElement>('previous');
const next = element<HTMLButtonElement>('next');
const status = element('status');
const saved = vscode.getState();
const state = normalizeSnippetViewState(saved);
let catalog: RecipeSnippet[] = [];
let pageItems: RecipeSnippet[] = [];
let selected: RecipeSnippet | undefined;
let insertionTarget: string | undefined;
let sequence = typeof saved === 'object' && saved !== null && 'lastRequest' in saved
    && typeof saved.lastRequest === 'number' && Number.isSafeInteger(saved.lastRequest)
    && saved.lastRequest >= 0 && saved.lastRequest < Number.MAX_SAFE_INTEGER - 1000 ? saved.lastRequest : 0;
let loadRequest = -1;
let actionRequest = -1;
let loading = true;
let actionPending = false;
let loaded = false;
let catalogUsable = false;
let timer: ReturnType<typeof setTimeout> | undefined;

function saveState(): void { vscode.setState({ ...state, lastRequest: sequence }); }
function nextRequest(): number { ++sequence; saveState(); return sequence; }
function sourceName(source: RecipeSnippet['source']): string {
    return source === 'builtin' ? 'Built-in recipe' : source === 'personal' ? 'Personal snippet' : 'Workspace snippet';
}

function updateButtons(): void {
    const busy = loading || actionPending || !catalogUsable;
    for (const id of ['copy', 'duplicate']) { element<HTMLButtonElement>(id).disabled = busy || !selected; }
    element<HTMLButtonElement>('insert').disabled = busy || !selected || !insertionTarget;
    element<HTMLButtonElement>('edit').disabled = busy || !selected || selected.source === 'builtin';
    element<HTMLButtonElement>('new').disabled = actionPending;
    element<HTMLButtonElement>('save-selection').disabled = actionPending || !insertionTarget;
    manageInput.disabled = actionPending;
    element<HTMLButtonElement>('refresh').disabled = loading || actionPending;
    element('target').textContent = insertionTarget
        ? `Insert into ${insertionTarget}` : 'Open a Lua file and place the cursor to insert snippets.';
}

function renderCode(): void {
    if (!selected) { return; }
    const hasPreview = selected.source === 'builtin' && selected.preview !== undefined;
    element('preview-toggle').hidden = !hasPreview;
    bodyInput.checked = state.showBody;
    const preview = hasPreview && !state.showBody;
    element('code-heading').textContent = preview ? 'Example preview' : 'Snippet syntax';
    element('code').textContent = preview ? selected.preview! : selected.body;
    element('code-note').textContent = preview
        ? 'An example with placeholder defaults. Copy snippet always copies the original snippet syntax.'
        : 'Copy keeps the exact syntax shown below. Insert expands placeholders in your Lua editor.';
}

function selectSnippet(item: RecipeSnippet, focus = false): void {
    selected = item;
    state.selectedId = item.id;
    saveState();
    element('detail').hidden = false;
    element('detail-empty').hidden = true;
    element('detail-kind').textContent = sourceName(item.source);
    element('detail-name').textContent = item.label;
    element('source-label').textContent = item.sourceLabel;
    element('description').textContent = item.description;
    element('description').hidden = !item.description;
    element('edit').hidden = item.source === 'builtin';
    element('prefix-section').hidden = item.prefix.length === 0;
    const prefixes = element('prefixes');
    prefixes.replaceChildren(...item.prefix.map((prefix) => node('code', prefix)));
    for (const button of resultsList.querySelectorAll<HTMLButtonElement>('button')) {
        const active = button.dataset.id === item.id;
        button.setAttribute('aria-selected', String(active));
        button.tabIndex = active ? 0 : -1;
        if (active && focus) { button.focus(); }
    }
    renderCode();
    updateButtons();
    if (!actionPending) { status.textContent = `${sourceName(item.source)} selected. Copy snippet syntax or insert it into Lua.`; }
}

function renderResults(preserveSelectedPage = false): void {
    const matches = filterSnippetCatalog(catalog, state);
    if (preserveSelectedPage) {
        const selectedIndex = matches.findIndex((item) => item.id === state.selectedId);
        if (selectedIndex >= 0) { state.offset = Math.floor(selectedIndex / 50) * 50; }
    }
    const page = snippetPage(matches, state.offset);
    pageItems = page.items;
    state.offset = page.offset;
    resultsList.replaceChildren();
    for (const [index, item] of pageItems.entries()) {
        const li = node('li');
        li.setAttribute('role', 'none');
        const button = node('button');
        button.className = 'result';
        button.dataset.id = item.id;
        button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', String(item.id === state.selectedId));
        button.tabIndex = index === 0 ? 0 : -1;
        const name = node('span', item.label);
        name.className = 'result-name';
        const meta = node('span');
        meta.className = 'result-meta';
        const kind = node('span', sourceName(item.source));
        kind.className = 'kind';
        meta.append(kind);
        if (item.prefix.length) { meta.append(node('span', item.prefix[0])); }
        button.append(name, meta);
        button.addEventListener('click', () => selectSnippet(item));
        button.addEventListener('keydown', (event) => {
            let destination: number;
            switch (event.key) {
                case 'ArrowDown': destination = Math.min(pageItems.length - 1, index + 1); break;
                case 'ArrowUp': destination = Math.max(0, index - 1); break;
                case 'Home': destination = 0; break;
                case 'End': destination = pageItems.length - 1; break;
                default: return;
            }
            event.preventDefault();
            selectSnippet(pageItems[destination], true);
        });
        li.append(button);
        resultsList.append(li);
    }
    resultsList.setAttribute('aria-busy', String(loading));
    element('result-count').textContent = `${page.total.toLocaleString()} ${page.total === 1 ? 'snippet' : 'snippets'}`;
    element('page-range').textContent = page.total
        ? `${(page.offset + 1).toLocaleString()}–${(page.offset + page.items.length).toLocaleString()} of ${page.total.toLocaleString()}` : '0 results';
    previous.disabled = page.offset === 0;
    next.disabled = page.offset + page.items.length >= page.total;
    element('no-results').hidden = page.total > 0;
    const item = pageItems.find((entry) => entry.id === state.selectedId) ?? pageItems[0];
    if (item) { selectSnippet(item); }
    else {
        selected = undefined;
        element('detail').hidden = true;
        element('detail-empty').hidden = false;
        element('detail-empty').replaceChildren(node('h2', 'No snippet selected'), node('p', 'Adjust your search or source, or create a new snippet.'));
        if (!actionPending) { status.textContent = 'No matching snippets. Try another search or create a new one.'; }
        updateButtons();
    }
    saveState();
}

function applySearch(resetPage = true): void {
    if (timer) { clearTimeout(timer); timer = undefined; }
    state.query = searchInput.value;
    state.source = normalizeSnippetViewState({ source: sourceInput.value }).source;
    if (resetPage) { state.offset = 0; }
    saveState();
    if (loaded) { renderResults(); }
}

function loadCatalog(): void {
    loadRequest = nextRequest();
    loading = true;
    catalogUsable = false;
    element('catalog-error').hidden = true;
    resultsList.setAttribute('aria-busy', 'true');
    if (!loaded) { element('result-count').textContent = 'Loading snippets…'; }
    status.textContent = 'Loading your snippet library…';
    updateButtons();
    vscode.postMessage({ type: 'load', requestId: loadRequest });
}

function sendAction(action: 'insert' | 'copy' | 'edit' | 'duplicate'): void {
    if (loading || actionPending || !catalogUsable || !selected || (action === 'insert' && !insertionTarget)) { return; }
    if (action === 'edit' && selected.source === 'builtin') { return; }
    actionRequest = nextRequest();
    actionPending = true;
    status.textContent = action === 'insert' ? 'Inserting snippet…' : action === 'copy' ? 'Copying snippet syntax…' : 'Continue in the editor prompt.';
    updateButtons();
    vscode.postMessage({ type: 'action', requestId: actionRequest, id: selected.id, action });
}

function manage(action: 'new' | 'personal' | 'workspace' | 'saveSelection'): void {
    if (actionPending || (action === 'saveSelection' && !insertionTarget)) { return; }
    actionRequest = nextRequest();
    actionPending = true;
    status.textContent = action === 'personal' || action === 'workspace' ? 'Opening snippet JSON…' : 'Continue in the editor prompt.';
    updateButtons();
    vscode.postMessage({ type: 'manage', requestId: actionRequest, action });
}

function showCatalogError(message: string): void {
    const error = element('catalog-error');
    error.hidden = false;
    const retry = node('button', 'Retry');
    retry.addEventListener('click', loadCatalog);
    error.replaceChildren(node('div', message), retry);
    if (!loaded) { element('result-count').textContent = 'Snippets unavailable'; }
}

window.addEventListener('message', (event: MessageEvent<SnippetHostMessage>) => {
    const message = event.data;
    if (!message || typeof message !== 'object') { return; }
    if (message.type === 'target') {
        insertionTarget = message.name;
        updateButtons();
    } else if (message.type === 'invalidate') {
        loadCatalog();
    } else if (message.type === 'catalog' && message.requestId === loadRequest) {
        loading = false;
        loaded = true;
        catalogUsable = true;
        catalog = message.catalog.items;
        const issues = message.catalog.issues;
        element('issues').hidden = issues.length === 0;
        element('issues-summary').textContent = `${issues.length} ${issues.length === 1 ? 'library issue' : 'library issues'} — available snippets are shown below`;
        element('issue-list').replaceChildren(...issues.map((issue) => node('li', issue)));
        renderResults(true);
    } else if (message.type === 'error') {
        if (message.requestId === loadRequest) {
            loading = false;
            resultsList.setAttribute('aria-busy', 'false');
            showCatalogError(message.message);
        } else if (message.requestId === actionRequest) {
            actionPending = false;
        } else { return; }
        status.textContent = message.message;
        updateButtons();
    } else if (message.type === 'actionComplete' && message.requestId === actionRequest) {
        actionPending = false;
        status.textContent = message.message;
        updateButtons();
    }
});

searchInput.value = state.query;
sourceInput.value = state.source;
searchInput.addEventListener('input', () => {
    if (timer) { clearTimeout(timer); }
    timer = setTimeout(() => applySearch(), 120);
});
searchInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { applySearch(); } });
sourceInput.addEventListener('change', () => applySearch());
previous.addEventListener('click', () => { state.offset = Math.max(0, state.offset - 50); applySearch(false); });
next.addEventListener('click', () => { state.offset += 50; applySearch(false); });
bodyInput.addEventListener('change', () => { state.showBody = bodyInput.checked; saveState(); renderCode(); });
element('refresh').addEventListener('click', loadCatalog);
element('new').addEventListener('click', () => manage('new'));
element('save-selection').addEventListener('click', () => manage('saveSelection'));
manageInput.addEventListener('change', () => {
    const action = manageInput.value;
    manageInput.value = '';
    if (action === 'personal' || action === 'workspace') { manage(action); }
});
for (const action of ['insert', 'copy', 'edit', 'duplicate'] as const) {
    element(action).addEventListener('click', () => sendAction(action));
}
updateButtons();
vscode.postMessage({ type: 'ready' });
loadCatalog();
