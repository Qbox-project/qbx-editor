/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { ResourceDetailsMessage, ResourceDetailsView, ResourceRelationView, ResourceSymbolView, ResourceTargetView } from './resourceDetailsTypes.js';

type Outgoing = { type: 'ready' | 'refresh' | 'choose' } | { type: 'openSource' | 'openResource'; id: string };
declare function acquireVsCodeApi(): {
    postMessage(message: Outgoing): void;
    getState(): unknown;
    setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();
function element<T extends HTMLElement = HTMLElement>(id: string): T {
    const found = document.getElementById(id);
    if (!found) { throw new Error(`Missing resource details element: ${id}`); }
    return found as T;
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
    const result = document.createElement(tag);
    if (text !== undefined) { result.textContent = text; }
    return result;
}

const saved = vscode.getState();
const prior = typeof saved === 'object' && saved !== null && !Array.isArray(saved) ? saved as Record<string, unknown> : {};
const state = {
    query: typeof prior.query === 'string' ? prior.query.slice(0, 256) : '',
    kind: typeof prior.kind === 'string' && ['all', 'event', 'export'].includes(prior.kind) ? prior.kind : 'all',
    offset: typeof prior.offset === 'number' && Number.isSafeInteger(prior.offset) && prior.offset >= 0 ? Math.floor(prior.offset / 50) * 50 : 0,
    resourcePath: typeof prior.resourcePath === 'string' ? prior.resourcePath : '',
    expanded: prior.expanded === true,
};
const searchInput = element<HTMLInputElement>('search');
const kindInput = element<HTMLSelectElement>('kind');
const previous = element<HTMLButtonElement>('previous');
const next = element<HTMLButtonElement>('next');
const status = element('status');
const expanded = element<HTMLDetailsElement>('all-relations');
let snapshot: ResourceDetailsView | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
type Entry = ResourceSymbolView & { category: 'event' | 'export' };
let entries: Entry[] = [];

function saveState(): void { vscode.setState({ ...state }); }
function openSource(id: string): void {
    if (snapshot) { vscode.postMessage({ type: 'openSource', id }); }
}
function resourceButton(target: ResourceTargetView, label = target.name): HTMLButtonElement {
    const button = node('button', label);
    button.className = 'source-button';
    button.title = target.path;
    button.setAttribute('aria-label', `Show resource ${target.name}: ${target.path}`);
    button.addEventListener('click', () => {
        if (!snapshot) { return; }
        vscode.postMessage({ type: 'openResource', id: target.id });
    });
    return button;
}

function renderRelations(container: HTMLElement, relations: ResourceRelationView[], full: boolean): void {
    container.replaceChildren();
    if (!relations.length) {
        const empty = node('li', 'None');
        empty.className = 'empty-relation';
        container.append(empty);
        return;
    }
    for (const relation of relations.slice(0, full ? 200 : 12)) {
        const li = node('li');
        if (relation.status === 'resolved' && relation.targets.length === 1) {
            li.append(resourceButton(relation.targets[0], relation.name));
        } else {
            li.append(node('span', relation.name));
        }
        const note = relation.status === 'missing' ? 'Not found in the workspace'
            : relation.status === 'ambiguous' ? relation.targetCount > 1
                ? `${relation.targetCount} matching resources` : 'References an ambiguous resource name' : '';
        if (note) { const description = node('span', note); description.className = 'unresolved'; li.append(description); }
        if (full && relation.kinds.length) {
            const kinds = node('span', relation.kinds.join(' · '));
            kinds.className = 'entry-meta';
            li.append(kinds);
        }
        if (full && (relation.status === 'ambiguous' || relation.targets.length > 1)) {
            const targets = node('div');
            targets.className = 'relation-targets';
            for (const target of relation.targets) { targets.append(resourceButton(target, target.path || target.name)); }
            if (relation.targetCount > relation.targets.length) {
                const more = node('span', `${relation.targetCount - relation.targets.length} further matches are not shown.`);
                more.className = 'unresolved';
                targets.append(more);
            }
            li.append(targets);
        }
        container.append(li);
    }
}

function renderRelationships(data: ResourceDetailsView): void {
    element('current-node').textContent = data.resource.name;
    for (const kind of ['dependencies', 'dependents'] as const) {
        renderRelations(element(kind), data[kind], false);
        renderRelations(element(`all-${kind}`), data[kind], true);
        const more = element(`${kind}-more`);
        more.hidden = data[kind].length <= 12;
        more.textContent = `First 12 of ${data[kind].length.toLocaleString()}; expand all relationships below.`;
    }
    element('all-relations-summary').textContent = `All relationships · ${data.dependencies.length.toLocaleString()} ${data.dependencies.length === 1 ? 'dependency' : 'dependencies'}, ${data.dependents.length.toLocaleString()} ${data.dependents.length === 1 ? 'dependent' : 'dependents'}`;
    const omitted: string[] = [];
    if (data.truncated.dependencies) { omitted.push(`${data.truncated.dependencies.toLocaleString()} additional dependencies`); }
    if (data.truncated.dependents) { omitted.push(`${data.truncated.dependents.toLocaleString()} additional dependents`); }
    element('relation-note').textContent = omitted.length ? `${omitted.join(' and ')} are not shown in this overview.` : '';
    element('constraints').hidden = data.constraints.length === 0;
    element('constraint-list').replaceChildren(...data.constraints.map((constraint) => {
        const badge = node('code', constraint);
        badge.className = 'badge';
        return badge;
    }));
}

function readableKind(value: string): string {
    const known: Record<string, string> = {
        netEvent: 'Network event', net_event: 'Network event', handler: 'Event handler', trigger: 'Trigger',
        callback: 'Callback', export: 'Export', event: 'Event',
    };
    return known[value] ?? value;
}

function renderEntries(): void {
    if (!snapshot) { return; }
    const tokens = state.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = entries.filter((entry) => {
        if (state.kind !== 'all' && entry.category !== state.kind) { return false; }
        const text = [entry.name, entry.kind, entry.side, entry.source, entry.signature ?? ''].join('\n').toLowerCase();
        return tokens.every((token) => text.includes(token));
    });
    const lastPage = Math.max(0, Math.ceil(matches.length / 50) - 1) * 50;
    state.offset = Math.min(state.offset, lastPage);
    const page = matches.slice(state.offset, state.offset + 50);
    const body = element('entries');
    body.replaceChildren();
    for (const entry of page) {
        const row = node('tr');
        const name = node('td');
        const title = node('span', entry.name);
        title.className = 'entry-name';
        name.append(title);
        if (entry.signature) {
            const signature = node('span', entry.signature);
            signature.className = 'entry-meta';
            name.append(signature);
        }
        const type = node('td');
        const kind = node('span', readableKind(entry.kind));
        kind.className = 'entry-type';
        const side = node('span', entry.side || 'Unknown side');
        side.className = 'entry-meta';
        type.append(kind, side);
        const source = node('td');
        const button = node('button', entry.source);
        button.className = 'source-button entry-source';
        button.setAttribute('aria-label', `Open ${entry.name} at ${entry.source}`);
        button.addEventListener('click', () => openSource(entry.id));
        source.append(button);
        row.append(name, type, source);
        body.append(row);
    }
    element('entry-count').textContent = `${matches.length.toLocaleString()} ${matches.length === 1 ? 'loaded entry' : 'loaded entries'}`;
    element('no-entries').hidden = matches.length > 0;
    element('entries-table').hidden = matches.length === 0;
    previous.disabled = state.offset === 0;
    next.disabled = state.offset + page.length >= matches.length;
    element('page-range').textContent = matches.length
        ? `${(state.offset + 1).toLocaleString()}–${(state.offset + page.length).toLocaleString()} of ${matches.length.toLocaleString()}` : '0 entries';
    const missing = snapshot.truncated.events + snapshot.truncated.exports;
    element('index-note').textContent = missing
        ? `${entries.length.toLocaleString()} of ${(snapshot.counts.events + snapshot.counts.exports).toLocaleString()} indexed entries are loaded. Search covers these loaded entries; ${missing.toLocaleString()} additional entries are not shown.`
        : 'Search covers event and callback registrations and exports in this resource. Select a source location to open its code.';
    saveState();
}

function applySearch(reset = true): void {
    if (timer) { clearTimeout(timer); timer = undefined; }
    state.query = searchInput.value.slice(0, 256);
    state.kind = ['all', 'event', 'export'].includes(kindInput.value) ? kindInput.value : 'all';
    if (reset) { state.offset = 0; }
    saveState();
    renderEntries();
}

function clearSnapshot(): void {
    snapshot = undefined;
    entries = [];
    element('details').hidden = true;
    element('entries').replaceChildren();
    element<HTMLButtonElement>('manifest').disabled = true;
    previous.disabled = true;
    next.disabled = true;
}

function beginLoading(name: string): void {
    clearSnapshot();
    element('error').hidden = true;
    element('empty').hidden = true;
    element('loading').hidden = false;
    element('loading').textContent = name ? `Loading ${name}…` : 'Loading resource details…';
    element('resource-name').textContent = name || 'Resource details';
    element('resource-path').textContent = '';
    element('overview').setAttribute('aria-busy', 'true');
    element<HTMLButtonElement>('refresh').disabled = true;
    status.textContent = 'Loading resource details…';
}

function renderDetails(data: ResourceDetailsView): void {
    snapshot = data;
    if (state.resourcePath !== data.resource.path) { state.offset = 0; }
    state.resourcePath = data.resource.path;
    element('resource-name').textContent = data.resource.name;
    element('resource-path').textContent = data.resource.path;
    element('loading').hidden = true;
    element('error').hidden = true;
    element('empty').hidden = true;
    element('details').hidden = false;
    element('overview').setAttribute('aria-busy', 'false');
    element<HTMLButtonElement>('manifest').disabled = false;
    element<HTMLButtonElement>('refresh').disabled = false;
    for (const [id, count] of [
        ['client', data.files.client], ['server', data.files.server], ['shared', data.files.shared],
        ['modules', data.files.module], ['events', data.counts.events], ['exports', data.counts.exports],
    ] as const) { element(`count-${id}`).textContent = count.toLocaleString(); }
    element('notes').hidden = data.notes.length === 0;
    element('note-list').replaceChildren(...data.notes.map((note) => node('li', note)));
    renderRelationships(data);
    entries = [...data.events.map((entry) => ({ ...entry, category: 'event' as const })),
        ...data.exports.map((entry) => ({ ...entry, category: 'export' as const }))]
        .sort((a, b) => a.name.localeCompare(b.name) || a.category.localeCompare(b.category) || a.source.localeCompare(b.source));
    renderEntries();
    status.textContent = `${data.resource.name} · ${data.files.total.toLocaleString()} files · ${data.counts.events.toLocaleString()} events / callbacks · ${data.counts.exports.toLocaleString()} exports`;
}

window.addEventListener('message', (event: MessageEvent<ResourceDetailsMessage>) => {
    const message = event.data;
    if (!message || typeof message !== 'object') { return; }
    if (message.type === 'loading') { beginLoading(message.name); }
    else if (message.type === 'details') { renderDetails(message.data); }
    else if (message.type === 'error') {
        clearSnapshot();
        element('loading').hidden = true;
        element('resource-path').textContent = '';
        element('overview').setAttribute('aria-busy', 'false');
        element<HTMLButtonElement>('refresh').disabled = false;
        const error = element('error');
        error.hidden = false;
        const retry = node('button', 'Retry');
        retry.addEventListener('click', refresh);
        error.replaceChildren(node('div', message.message), retry);
        element('empty').hidden = false;
        status.textContent = message.message;
    }
});

function refresh(): void {
    vscode.postMessage({ type: 'refresh' });
}
searchInput.value = state.query;
kindInput.value = state.kind;
expanded.open = state.expanded;
expanded.addEventListener('toggle', () => { state.expanded = expanded.open; saveState(); });
searchInput.addEventListener('input', () => {
    if (timer) { clearTimeout(timer); }
    timer = setTimeout(() => applySearch(), 120);
});
searchInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { applySearch(); } });
kindInput.addEventListener('change', () => applySearch());
previous.addEventListener('click', () => { state.offset = Math.max(0, state.offset - 50); applySearch(false); });
next.addEventListener('click', () => { state.offset += 50; applySearch(false); });
element('manifest').addEventListener('click', () => { if (snapshot) { openSource(snapshot.resource.manifestId); } });
element('choose').addEventListener('click', () => vscode.postMessage({ type: 'choose' }));
element('refresh').addEventListener('click', refresh);
vscode.postMessage({ type: 'ready' });
