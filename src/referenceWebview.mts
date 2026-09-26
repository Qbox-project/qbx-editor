/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { marked, type Token, type Tokens } from 'marked';
import { decodeMarkdownEntities } from './referenceMarkdown.js';
import { normalizeReferenceLink, normalizeReferenceSearch } from './referenceSession.js';
import type {
    ReferenceAction, ReferenceDetail, ReferenceHostMessage, ReferenceItem, ReferenceSearchParams, ReferenceWebviewMessage,
} from './referenceTypes.js';

declare function acquireVsCodeApi(): {
    postMessage(message: ReferenceWebviewMessage | { type: 'ready' }): void;
    getState(): unknown;
    setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();
function element<T extends HTMLElement = HTMLElement>(id: string): T {
    const found = document.getElementById(id);
    if (!found) { throw new Error(`Missing reference element: ${id}`); }
    return found as T;
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
    const result = document.createElement(tag);
    if (text !== undefined) { result.textContent = text; }
    return result;
}

const searchInput = element<HTMLInputElement>('search');
const catalogInput = element<HTMLSelectElement>('catalog');
const sideInput = element<HTMLSelectElement>('side');
const namespaceInput = element<HTMLSelectElement>('namespace');
const resultsList = element<HTMLUListElement>('results');
const previous = element<HTMLButtonElement>('previous');
const next = element<HTMLButtonElement>('next');
const status = element('status');
const saved = vscode.getState();
let state: ReferenceSearchParams = normalizeReferenceSearch(saved) ?? { query: '', kind: 'all', side: 'all', namespace: '', offset: 0, limit: 50 };
let selectedId = typeof saved === 'object' && saved !== null && 'selectedId' in saved && typeof saved.selectedId === 'string' ? saved.selectedId : '';
let sequence = 0;
let searchRequest = -1;
let detailRequest = -1;
let actionRequest = -1;
let timer: ReturnType<typeof setTimeout> | undefined;
let items: ReferenceItem[] = [];
let selectedDetail: ReferenceDetail | undefined;
let total = 0;
let insertionTarget: string | undefined;

function saveState(): void { vscode.setState({ ...state, selectedId }); }

function updateFilters(): void {
    const native = catalogInput.value === 'native';
    const sided = catalogInput.value === 'all' || native;
    element('namespace-filter').hidden = !native;
    element('side-filter').hidden = !sided;
    if (!native) { namespaceInput.value = ''; }
    if (!sided) { sideInput.value = 'all'; }
}

function sendSearch(offset = 0): void {
    if (timer) { clearTimeout(timer); timer = undefined; }
    updateFilters();
    state = normalizeReferenceSearch({
        query: searchInput.value, kind: catalogInput.value, side: sideInput.value,
        namespace: namespaceInput.value, offset,
    }) ?? { query: '', kind: 'all', side: 'all', offset: 0, limit: 50 };
    saveState();
    searchRequest = ++sequence;
    detailRequest = ++sequence;
    actionRequest = ++sequence;
    selectedDetail = undefined;
    element('detail').hidden = true;
    element('detail-empty').hidden = false;
    element('detail-error').hidden = true;
    element('search-error').hidden = true;
    element('no-results').hidden = true;
    element('result-count').textContent = 'Searching…';
    resultsList.setAttribute('aria-busy', 'true');
    resultsList.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    previous.disabled = true;
    next.disabled = true;
    status.textContent = 'Searching the reference…';
    vscode.postMessage({ type: 'search', requestId: searchRequest, params: state });
}

function kindLabel(kind: ReferenceItem['kind']): string {
    return kind === 'native' ? 'Native' : kind === 'control' ? 'Control' : 'Ped config flag';
}

function selectReference(item: ReferenceItem, focus = false): void {
    selectedId = item.id;
    saveState();
    selectedDetail = undefined;
    detailRequest = ++sequence;
    actionRequest = ++sequence;
    element('detail').hidden = true;
    element('detail-error').hidden = true;
    const empty = element('detail-empty');
    empty.hidden = false;
    empty.replaceChildren(node('p', 'Loading documentation…'));
    for (const button of resultsList.querySelectorAll<HTMLButtonElement>('button')) {
        const selected = button.dataset.id === selectedId;
        button.setAttribute('aria-selected', String(selected));
        button.tabIndex = selected ? 0 : -1;
        if (selected && focus) { button.focus(); }
    }
    vscode.postMessage({ type: 'detail', requestId: detailRequest, id: item.id });
}

function renderResults(): void {
    resultsList.replaceChildren();
    for (const [index, item] of items.entries()) {
        const li = node('li');
        li.setAttribute('role', 'none');
        const button = node('button');
        button.className = 'result';
        button.dataset.id = item.id;
        button.dataset.index = String(index);
        button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', String(item.id === selectedId));
        button.tabIndex = item.id === selectedId || (!items.some((entry) => entry.id === selectedId) && index === 0) ? 0 : -1;
        const name = node('span', item.name);
        name.className = 'result-name';
        const meta = node('span');
        meta.className = 'result-meta';
        const kind = node('span', kindLabel(item.kind));
        kind.className = 'kind';
        meta.append(kind, node('span', item.kind === 'native' ? `${item.namespace ?? ''} · ${item.side}` : `ID ${item.numericId}`));
        button.append(name, meta);
        button.addEventListener('click', () => selectReference(item));
        button.addEventListener('keydown', (event) => {
            let destination: number;
            switch (event.key) {
                case 'ArrowDown': destination = Math.min(items.length - 1, index + 1); break;
                case 'ArrowUp': destination = Math.max(0, index - 1); break;
                case 'Home': destination = 0; break;
                case 'End': destination = items.length - 1; break;
                default: return;
            }
            event.preventDefault();
            selectReference(items[destination], true);
        });
        li.append(button);
        resultsList.append(li);
    }
}

function updateTarget(): void {
    element('target').textContent = insertionTarget ? `Insert into ${insertionTarget}` : 'Open a Lua file and place the cursor to insert references.';
}

function action(action: ReferenceAction): void {
    if (!selectedDetail) { return; }
    actionRequest = ++sequence;
    status.textContent = action === 'insert' ? 'Inserting reference…' : 'Working…';
    vscode.postMessage({ type: 'action', requestId: actionRequest, id: selectedDetail.id, action });
}

/** Render Marked's token tree using DOM construction: documentation never becomes executable HTML. */
function renderMarkdown(container: HTMLElement, markdown: string, links: string[]): void {
    const decoder = document.createElement('textarea');
    function prose(text: string): Text {
        return document.createTextNode(decodeMarkdownEntities(text, (entity) => {
            // The decoder receives one regex-validated entity, never documentation or HTML markup.
            decoder.innerHTML = entity;
            return decoder.value;
        }));
    }
    function appendTokens(parent: HTMLElement, tokens: Token[]): void {
        for (const generic of tokens) {
            const token = generic as Tokens.Generic;
            switch (token.type) {
                case 'space': case 'def': case 'html': break;
                case 'image': parent.append(prose(token.text ? `[Image: ${token.text}]` : '[Image]')); break;
                case 'hr': parent.append(node('hr')); break;
                case 'br': parent.append(node('br')); break;
                case 'code': {
                    const pre = node('pre');
                    pre.append(node('code', token.text));
                    parent.append(pre);
                    break;
                }
                case 'codespan': parent.append(node('code', token.text)); break;
                case 'heading': {
                    const heading = node(`h${Math.min(6, Math.max(2, Number(token.depth)))}` as 'h2');
                    appendTokens(heading, token.tokens ?? []);
                    parent.append(heading);
                    break;
                }
                case 'paragraph': case 'blockquote': case 'strong': case 'em': case 'del': {
                    const tags = { paragraph: 'p', blockquote: 'blockquote', strong: 'strong', em: 'em', del: 'del' } as const;
                    const child = node(tags[token.type as keyof typeof tags]);
                    appendTokens(child, token.tokens ?? []);
                    parent.append(child);
                    break;
                }
                case 'list': {
                    const list = node(token.ordered ? 'ol' : 'ul');
                    if (token.ordered && Number.isSafeInteger(token.start) && token.start > 1) {
                        (list as HTMLOListElement).start = token.start;
                    }
                    for (const item of token.items as Tokens.ListItem[]) {
                        const li = node('li');
                        if (item.task) { li.append(document.createTextNode(item.checked ? '☑ ' : '☐ ')); }
                        appendTokens(li, item.tokens);
                        list.append(li);
                    }
                    parent.append(list);
                    break;
                }
                case 'table': {
                    const tableToken = generic as Tokens.Table;
                    const table = node('table');
                    const head = node('thead');
                    const headRow = node('tr');
                    for (const cell of tableToken.header) {
                        const th = node('th');
                        th.scope = 'col';
                        appendTokens(th, cell.tokens);
                        headRow.append(th);
                    }
                    head.append(headRow);
                    const body = node('tbody');
                    for (const row of tableToken.rows) {
                        const tr = node('tr');
                        for (const cell of row) {
                            const td = node('td');
                            appendTokens(td, cell.tokens);
                            tr.append(td);
                        }
                        body.append(tr);
                    }
                    table.append(head, body);
                    parent.append(table);
                    break;
                }
                case 'link': {
                    const index = links.indexOf(normalizeReferenceLink(token.href) ?? '');
                    if (index < 0) {
                        appendTokens(parent, token.tokens ?? []);
                        break;
                    }
                    const anchor = node('a');
                    anchor.href = '#';
                    anchor.title = links[index];
                    appendTokens(anchor, token.tokens ?? []);
                    anchor.addEventListener('click', (event) => {
                        event.preventDefault();
                        if (selectedDetail) {
                            actionRequest = ++sequence;
                            vscode.postMessage({ type: 'link', requestId: actionRequest, id: selectedDetail.id, index });
                        }
                    });
                    parent.append(anchor);
                    break;
                }
                case 'text':
                    if (token.tokens) { appendTokens(parent, token.tokens); }
                    else { parent.append(prose(token.text ?? '')); }
                    break;
                case 'escape':
                    parent.append(document.createTextNode(token.text ?? ''));
                    break;
                default: parent.append(document.createTextNode(token.text ?? ''));
            }
        }
    }
    container.replaceChildren();
    try { appendTokens(container, marked.lexer(markdown, { gfm: true })); }
    catch { container.append(node('pre', markdown)); }
}

function renderDetail(detail: ReferenceDetail, links: string[]): void {
    selectedDetail = detail;
    element('detail-empty').hidden = true;
    element('detail-error').hidden = true;
    element('detail').hidden = false;
    element('detail-kind').textContent = kindLabel(detail.kind);
    element('detail-name').textContent = detail.name;
    const badges = element('detail-badges');
    badges.replaceChildren();
    for (const text of [detail.namespace, detail.side, detail.kind === 'native' ? detail.hash : `ID ${detail.numericId}`]) {
        if (text) { const badge = node('span', text); badge.className = 'badge'; badges.append(badge); }
    }
    element('signature-box').hidden = !detail.signature;
    element('signature').textContent = detail.signature ?? '';
    element('copy').textContent = detail.kind === 'native' ? 'Copy name' : 'Copy ID';
    element('insert').textContent = detail.kind === 'native' ? 'Insert Lua call' : 'Insert ID';
    element('copy-hash').hidden = detail.kind !== 'native' || !detail.hash;
    updateTarget();
    const parameters = element('parameters');
    parameters.replaceChildren();
    element('parameters-section').hidden = !detail.parameters?.length;
    for (const parameter of detail.parameters ?? []) {
        const tr = node('tr');
        const name = node('td');
        const type = node('td');
        name.append(node('code', parameter.name));
        type.append(node('code', parameter.type));
        tr.append(name, type);
        parameters.append(tr);
    }
    element('returns-section').hidden = !detail.returns?.length;
    element('returns').textContent = detail.returns?.join(', ') ?? '';
    renderMarkdown(element('documentation'), detail.documentation || 'No additional documentation is available for this reference.', links);
    status.textContent = `${kindLabel(detail.kind)} selected. Use Copy or Insert to continue.`;
}

function showError(scope: 'search' | 'detail' | 'action', message: string): void {
    status.textContent = message;
    if (scope === 'action') { return; }
    const error = element(scope === 'search' ? 'search-error' : 'detail-error');
    error.hidden = false;
    const retry = node('button', 'Retry');
    retry.addEventListener('click', () => {
        if (scope === 'search') { sendSearch(state.offset ?? 0); }
        else {
            const selected = items.find((item) => item.id === selectedId);
            if (selected) { selectReference(selected); }
        }
    });
    error.replaceChildren(node('div', message), retry);
    if (scope === 'search') {
        resultsList.setAttribute('aria-busy', 'false');
        element('result-count').textContent = 'Search unavailable';
        resultsList.replaceChildren();
    } else {
        element('detail-empty').hidden = true;
    }
}

window.addEventListener('message', (event: MessageEvent<ReferenceHostMessage>) => {
    const message = event.data;
    if (!message || typeof message !== 'object') { return; }
    if (message.type === 'target') {
        insertionTarget = message.name;
        updateTarget();
    } else if (message.type === 'results' && message.requestId === searchRequest) {
        items = message.result.items;
        total = message.result.total;
        state.offset = message.result.offset;
        saveState();
        element('result-count').textContent = `${total.toLocaleString()} ${total === 1 ? 'reference' : 'references'}`;
        element('page-range').textContent = total ? `${(state.offset + 1).toLocaleString()}–${(state.offset + items.length).toLocaleString()} of ${total.toLocaleString()}` : '0 results';
        previous.disabled = state.offset === 0;
        next.disabled = state.offset + items.length >= total;
        element('no-results').hidden = items.length > 0;
        resultsList.setAttribute('aria-busy', 'false');
        namespaceInput.replaceChildren(new Option('All namespaces', ''));
        for (const namespace of message.result.namespaces) { namespaceInput.append(new Option(namespace, namespace)); }
        namespaceInput.value = state.namespace ?? '';
        renderResults();
        const selected = items.find((item) => item.id === selectedId) ?? items[0];
        if (selected) { selectReference(selected); }
        else {
            const empty = element('detail-empty');
            empty.hidden = false;
            empty.replaceChildren(node('h2', 'No reference selected'), node('p', 'Adjust your search or filters to find a reference.'));
            status.textContent = 'No matches. Try another search.';
        }
    } else if (message.type === 'detail' && message.requestId === detailRequest) {
        renderDetail(message.detail, message.links);
    } else if (message.type === 'error') {
        if ((message.scope === 'search' && message.requestId === searchRequest)
            || (message.scope === 'detail' && message.requestId === detailRequest)
            || (message.scope === 'action' && message.requestId === actionRequest)) {
            showError(message.scope, message.message);
        }
    } else if (message.type === 'actionComplete' && message.requestId === actionRequest) {
        status.textContent = message.message;
    }
});

searchInput.value = state.query ?? '';
catalogInput.value = state.kind ?? 'all';
sideInput.value = state.side ?? 'all';
if (state.namespace) { namespaceInput.append(new Option(state.namespace, state.namespace)); namespaceInput.value = state.namespace; }
searchInput.addEventListener('input', () => {
    if (timer) { clearTimeout(timer); }
    timer = setTimeout(() => sendSearch(), 180);
});
searchInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { sendSearch(); } });
for (const filter of [catalogInput, sideInput, namespaceInput]) { filter.addEventListener('change', () => sendSearch()); }
element('refresh').addEventListener('click', () => sendSearch(state.offset ?? 0));
previous.addEventListener('click', () => sendSearch(Math.max(0, (state.offset ?? 0) - 50)));
next.addEventListener('click', () => sendSearch((state.offset ?? 0) + 50));
element('copy').addEventListener('click', () => action('copy'));
element('copy-hash').addEventListener('click', () => action('copyHash'));
element('insert').addEventListener('click', () => action('insert'));
element('source').addEventListener('click', () => action('source'));
vscode.postMessage({ type: 'ready' });
sendSearch(state.offset ?? 0);
