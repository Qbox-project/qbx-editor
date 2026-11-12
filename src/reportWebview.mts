/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { ReportAction, ReportCell, ReportMessage, ReportSection, ReportView } from './reportTypes.js';

declare function acquireVsCodeApi(): { postMessage(message: ReportAction): void; getState(): unknown; setState(state: unknown): void };

const SHOWN_ROWS = 300;
const vscode = acquireVsCodeApi();
function element<T extends HTMLElement = HTMLElement>(id: string): T {
    const found = document.getElementById(id);
    if (!found) { throw new Error(`Missing report element: ${id}`); }
    return found as T;
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
    const result = document.createElement(tag);
    result.textContent = text;
    if (className) { result.className = className; }
    return result;
}
const saved = vscode.getState();
const state = { filter: typeof saved === 'object' && saved !== null && 'filter' in saved && typeof saved.filter === 'string' ? saved.filter.slice(0, 256) : '' };
const filter = element<HTMLInputElement>('filter');
let view: ReportView | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

function cell(value: string | ReportCell): ReportCell { return typeof value === 'string' ? { text: value } : value; }
function tone(value: string | undefined): string { return value === 'error' || value === 'warning' || value === 'ok' || value === 'muted' ? `tone-${value}` : ''; }

function renderSection(section: ReportSection, tokens: string[]): HTMLElement {
    const container = node('section', '', 'report-section');
    container.append(node('h2', section.title));
    if (section.description) { container.append(node('p', section.description, 'section-note')); }
    const matching = tokens.length === 0 ? section.rows : section.rows.filter((row) => {
        const text = `${row.cells.map((value) => cell(value).text).join(' ')} ${row.link?.label ?? ''}`.toLowerCase();
        return tokens.every((token) => text.includes(token));
    });
    if (matching.length === 0) {
        container.append(node('p', section.rows.length === 0 ? section.empty ?? 'Nothing to show.' : 'No row matches the filter.', 'section-note'));
        return container;
    }
    const hasLinks = section.rows.some((row) => row.link);
    const table = node('table'), head = node('tr');
    for (const column of [...section.columns, ...(hasLinks ? ['Location'] : [])]) {
        const heading = node('th', column);
        heading.scope = 'col';
        head.append(heading);
    }
    const header = node('thead'), body = node('tbody');
    header.append(head);
    for (const row of matching.slice(0, SHOWN_ROWS)) {
        const line = node('tr');
        for (const value of row.cells) { line.append(node('td', cell(value).text, tone(cell(value).tone))); }
        if (hasLinks) {
            const location = node('td');
            if (row.link) {
                const id = row.link.id, button = node('button', row.link.label, 'row-link');
                button.title = 'Open this file';
                button.addEventListener('click', () => vscode.postMessage({ type: 'open', id }));
                location.append(button);
            }
            line.append(location);
        }
        body.append(line);
    }
    table.append(header, body);
    container.append(table);
    const hidden = matching.length - Math.min(matching.length, SHOWN_ROWS) + (tokens.length === 0 ? section.omitted ?? 0 : 0);
    if (hidden > 0) { container.append(node('p', `${hidden.toLocaleString()} more rows. Filter the report to narrow it down.`, 'section-note')); }
    return container;
}

function render(): void {
    if (!view) { return; }
    const tokens = state.filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
    element('title').textContent = view.title;
    element('subtitle').textContent = view.subtitle;
    element('stats').replaceChildren(...view.stats.map((stat) => {
        const box = node('div', '', 'stat');
        box.append(node('dt', stat.label), node('dd', stat.value, tone(stat.tone)));
        return box;
    }));
    element('stats').hidden = view.stats.length === 0;
    element('sections').replaceChildren(...view.sections.map((section) => renderSection(section, tokens)));
    element('note-list').replaceChildren(...view.notes.map((note) => node('li', note)));
    element('notes').hidden = view.notes.length === 0;
    const rows = view.sections.reduce((sum, section) => sum + section.rows.length + (section.omitted ?? 0), 0);
    element('status').textContent = `${rows.toLocaleString()} rows in ${view.sections.length} ${view.sections.length === 1 ? 'table' : 'tables'}.`;
}

window.addEventListener('message', (event: MessageEvent<ReportMessage>) => {
    const message = event.data;
    const refresh = element<HTMLButtonElement>('refresh');
    if (message?.type === 'loading') {
        element('title').textContent = message.title;
        element('loading-status').textContent = message.status;
        element('loading').hidden = false;
        element('error').hidden = true;
        refresh.disabled = true;
        element('status').textContent = message.status;
    } else if (message?.type === 'report') {
        view = message.data;
        element('loading').hidden = true;
        element('error').hidden = true;
        refresh.disabled = false;
        render();
    } else if (message?.type === 'error') {
        element('loading').hidden = true;
        element('error').textContent = message.message;
        element('error').hidden = false;
        refresh.disabled = false;
        element('status').textContent = message.message;
    }
});

filter.value = state.filter;
function applyFilter(): void {
    if (timer) { clearTimeout(timer); timer = undefined; }
    state.filter = filter.value.slice(0, 256);
    vscode.setState({ ...state });
    render();
}
filter.addEventListener('input', () => { if (timer) { clearTimeout(timer); } timer = setTimeout(applyFilter, 120); });
filter.addEventListener('keydown', (event) => { if (event.key === 'Enter') { applyFilter(); } });
element('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
vscode.postMessage({ type: 'ready' });
