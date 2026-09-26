/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { RuntimeLogMessage, RuntimeLogView } from './runtimeToolsTypes.js';

type Outgoing = { type: 'ready' | 'chooseFile' | 'togglePause' | 'clear' } | { type: 'openSource'; id: string };
declare function acquireVsCodeApi(): { postMessage(message: Outgoing): void; getState(): unknown; setState(state: unknown): void };

const vscode = acquireVsCodeApi();
function element<T extends HTMLElement = HTMLElement>(id: string): T {
    const found = document.getElementById(id);
    if (!found) { throw new Error(`Missing log element: ${id}`); }
    return found as T;
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text: string): HTMLElementTagNameMap[K] {
    const result = document.createElement(tag);
    result.textContent = text;
    return result;
}
const saved = vscode.getState();
const prior = typeof saved === 'object' && saved !== null && !Array.isArray(saved) ? saved as Record<string, unknown> : {};
const state = { query: typeof prior.query === 'string' ? prior.query.slice(0, 256) : '', autoScroll: prior.autoScroll !== false };
const search = element<HTMLInputElement>('search');
const autoscroll = element<HTMLInputElement>('autoscroll');
const viewport = element('viewport');
const lines = element('lines');
const rendered = new Map<string, { text: string; links: string; node: HTMLElement }>();
let view: RuntimeLogView | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

function save(): void { vscode.setState({ ...state }); }
function renderLine(line: RuntimeLogView['lines'][number]): HTMLElement {
    const fingerprint = JSON.stringify(line.links);
    const cached = rendered.get(line.id);
    if (cached?.text === line.text && cached.links === fingerprint) { return cached.node; }
    const container = node('div', '');
    container.className = 'log-line';
    let cursor = 0;
    for (const link of [...line.links].sort((a, b) => a.start - b.start)) {
        if (!Number.isSafeInteger(link.start) || !Number.isSafeInteger(link.end) || link.start < cursor
            || link.end <= link.start || link.end > line.text.length || typeof link.id !== 'string' || !link.id) { continue; }
        container.append(document.createTextNode(line.text.slice(cursor, link.start)));
        const button = node('button', line.text.slice(link.start, link.end));
        button.className = 'log-source';
        button.title = 'Open source location';
        button.setAttribute('aria-label', `Open source location ${button.textContent}`);
        button.addEventListener('click', () => { if (view?.hasFile) { vscode.postMessage({ type: 'openSource', id: link.id }); } });
        container.append(button);
        cursor = link.end;
    }
    container.append(document.createTextNode(line.text.slice(cursor)));
    rendered.set(line.id, { text: line.text, links: fingerprint, node: container });
    return container;
}

function renderLines(): void {
    if (!view) { return; }
    const tokens = state.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matching = view.lines.filter((line) => {
        const text = line.text.toLowerCase();
        return tokens.every((token) => text.includes(token));
    });
    const visible = matching.slice(-300);
    const visibleIds = new Set(visible.map((line) => line.id));
    for (const id of rendered.keys()) { if (!visibleIds.has(id)) { rendered.delete(id); } }
    // Reuse unchanged line nodes so incoming output does not replace selected text unnecessarily.
    let cursor = lines.firstChild;
    for (const line of visible) {
        const entry = renderLine(line);
        if (entry === cursor) { cursor = cursor.nextSibling; }
        else { lines.insertBefore(entry, cursor); }
    }
    while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
    element('empty').hidden = view.hasFile;
    element('no-matches').hidden = !view.hasFile || visible.length > 0;
    if (view.hasFile && !view.lines.length) {
        element('no-matches').replaceChildren(node('h2', 'No retained lines'), node('p', view.paused ? 'Resume the log to follow new output.' : 'New log output will appear here.'));
    } else {
        element('no-matches').replaceChildren(node('h2', 'No matching lines'), node('p', 'Change your filter to search the retained log history.'));
    }
    element('line-count').textContent = `${visible.length.toLocaleString()} shown · ${matching.length.toLocaleString()} matches · ${view.lines.length.toLocaleString()} retained lines`;
    element('history-note').textContent = matching.length > 300
        ? `Showing the latest 300 matching lines from ${view.lines.length.toLocaleString()} retained lines. History is bounded; older lines may be discarded.`
        : `Search covers ${view.lines.length.toLocaleString()} retained lines in this tab. History is bounded; older lines may be discarded.`;
    if (state.autoScroll && visible.length) { viewport.scrollTop = viewport.scrollHeight; }
}

window.addEventListener('message', (event: MessageEvent<RuntimeLogMessage>) => {
    if (event.data?.type !== 'state') { return; }
    view = event.data.data;
    element('log-path').textContent = view.path || 'Choose a local log file to follow its output.';
    element('log-status').textContent = view.status;
    element('read-state').textContent = !view.hasFile ? 'No file selected' : view.paused ? 'Paused' : 'Following';
    const pause = element<HTMLButtonElement>('pause');
    pause.disabled = !view.hasFile;
    pause.textContent = view.paused ? 'Resume' : 'Pause';
    pause.setAttribute('aria-pressed', String(view.paused));
    element<HTMLButtonElement>('clear').disabled = view.lines.length === 0;
    renderLines();
});

search.value = state.query;
autoscroll.checked = state.autoScroll;
function filter(): void {
    if (timer) { clearTimeout(timer); timer = undefined; }
    state.query = search.value.slice(0, 256);
    save();
    renderLines();
}
search.addEventListener('input', () => { if (timer) { clearTimeout(timer); } timer = setTimeout(filter, 100); });
search.addEventListener('keydown', (event) => { if (event.key === 'Enter') { filter(); } });
autoscroll.addEventListener('change', () => { state.autoScroll = autoscroll.checked; save(); if (state.autoScroll) { viewport.scrollTop = viewport.scrollHeight; } });
for (const id of ['choose', 'empty-choose']) { element(id).addEventListener('click', () => vscode.postMessage({ type: 'chooseFile' })); }
element('pause').addEventListener('click', () => { if (view?.hasFile) { vscode.postMessage({ type: 'togglePause' }); } });
element('clear').addEventListener('click', () => vscode.postMessage({ type: 'clear' }));
vscode.postMessage({ type: 'ready' });
