/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { HealthResource, WorkspaceHealthMessage, WorkspaceHealthView } from './runtimeToolsTypes.js';

type Outgoing = { type: 'ready' | 'refresh' | 'output' } | { type: 'openSource'; id: string };
declare function acquireVsCodeApi(): { postMessage(message: Outgoing): void; getState(): unknown; setState(state: unknown): void };

const vscode = acquireVsCodeApi();
function element<T extends HTMLElement = HTMLElement>(id: string): T {
    const found = document.getElementById(id);
    if (!found) { throw new Error(`Missing workspace health element: ${id}`); }
    return found as T;
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
    const result = document.createElement(tag);
    if (text !== undefined) { result.textContent = text; }
    return result;
}
const saved = vscode.getState();
const prior = typeof saved === 'object' && saved !== null && !Array.isArray(saved) ? saved as Record<string, unknown> : {};
const kinds = ['all', 'duplicate', 'missing', 'ambiguous'];
const state = {
    query: typeof prior.query === 'string' ? prior.query.slice(0, 256) : '',
    kind: typeof prior.kind === 'string' && kinds.includes(prior.kind) ? prior.kind : 'all',
    offset: typeof prior.offset === 'number' && Number.isSafeInteger(prior.offset) && prior.offset >= 0
        ? Math.min(1_000_000, Math.floor(prior.offset / 50) * 50) : 0,
};
const search = element<HTMLInputElement>('search');
const kind = element<HTMLSelectElement>('kind');
const previous = element<HTMLButtonElement>('previous');
const next = element<HTMLButtonElement>('next');
const status = element('status');
let snapshot: WorkspaceHealthView | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

function save(): void { vscode.setState({ ...state }); }
function sourceButton(resource: HealthResource): HTMLButtonElement {
    const button = node('button', resource.path || resource.name);
    button.className = 'source-button';
    button.title = resource.path;
    button.setAttribute('aria-label', `Open manifest for ${resource.name}: ${resource.path}`);
    button.addEventListener('click', () => {
        if (snapshot?.server.ok) { vscode.postMessage({ type: 'openSource', id: resource.id }); }
    });
    return button;
}

const kindLabels = { duplicate: 'Duplicate name', missing: 'Missing from index', ambiguous: 'Ambiguous name' };
function renderIssue(issue: WorkspaceHealthView['issues'][number]): HTMLLIElement {
    const li = node('li');
    li.className = 'issue';
    const heading = node('div');
    heading.className = 'issue-heading';
    const name = node('h3', issue.name);
    name.className = 'issue-name';
    const badge = node('span', kindLabels[issue.kind]);
    badge.className = 'issue-kind';
    heading.append(name, badge);
    const description = node('p', issue.kind === 'duplicate'
        ? `${issue.targetCount.toLocaleString()} indexed resources share this name.`
        : issue.kind === 'missing' ? 'This dependency was not found in the current index.'
            : `${issue.targetCount.toLocaleString()} indexed resources match this dependency name.`);
    description.className = 'issue-description';
    li.append(heading, description);
    if (issue.resource) {
        const source = node('div');
        source.className = 'issue-source';
        const label = node('span', `Declared by ${issue.resource.name}:`);
        label.className = 'source-label';
        source.append(label, sourceButton(issue.resource));
        li.append(source);
    }
    if (issue.kinds.length) {
        const declarations = node('p', `Manifest references: ${issue.kinds.join(' · ')}`);
        declarations.className = 'candidate-note';
        li.append(declarations);
    }
    if (issue.targets.length) {
        const candidates = node('details');
        candidates.className = 'candidates';
        candidates.open = issue.targets.length === 1;
        const summary = node('summary', `${issue.kind === 'duplicate' ? 'Resource' : 'Candidate'} manifests (${issue.targetCount.toLocaleString()})`);
        const list = node('ul');
        for (const target of issue.targets) { const row = node('li'); row.append(sourceButton(target)); list.append(row); }
        candidates.append(summary, list);
        if (issue.targetCount > issue.targets.length) {
            const note = node('p', `${(issue.targetCount - issue.targets.length).toLocaleString()} further matches are not included in this snapshot.`);
            note.className = 'candidate-note';
            candidates.append(note);
        }
        li.append(candidates);
    }
    return li;
}

function renderIssues(): void {
    if (!snapshot?.server.ok) { return; }
    const tokens = state.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = snapshot.issues.filter((issue) => {
        if (state.kind !== 'all' && state.kind !== issue.kind) { return false; }
        const text = [issue.name, kindLabels[issue.kind], issue.resource?.name ?? '', issue.resource?.path ?? '',
            ...issue.targets.flatMap((target) => [target.name, target.path]), ...issue.kinds].join('\n').toLowerCase();
        return tokens.every((token) => text.includes(token));
    });
    state.offset = Math.min(state.offset, Math.max(0, Math.ceil(matches.length / 50) - 1) * 50);
    const page = matches.slice(state.offset, state.offset + 50);
    element('issues').replaceChildren(...page.map(renderIssue));
    element('issue-count').textContent = `${matches.length.toLocaleString()} ${matches.length === 1 ? 'loaded issue' : 'loaded issues'}`;
    element('empty').hidden = matches.length > 0;
    const total = snapshot.counts.duplicates + snapshot.counts.missing + snapshot.counts.ambiguous;
    const unfiltered = !tokens.length && state.kind === 'all';
    element('empty-title').textContent = !unfiltered ? 'No matching issues'
        : snapshot.resources === 0 ? 'No indexed resources'
            : total === 0 ? 'No resource issues found in this snapshot' : 'No issues loaded';
    element('empty-message').textContent = !unfiltered ? 'Try another search or issue type.'
        : snapshot.resources === 0 ? 'Open a workspace containing FiveM resource manifests, then refresh.'
            : total === 0 ? 'No duplicate names, missing indexed dependencies or ambiguous dependencies were found.'
                : 'The reported issues are not included in the loaded snapshot.';
    previous.disabled = state.offset === 0;
    next.disabled = state.offset + page.length >= matches.length;
    element('page-range').textContent = matches.length
        ? `${(state.offset + 1).toLocaleString()}–${(state.offset + page.length).toLocaleString()} of ${matches.length.toLocaleString()}` : '0 issues';
    element('issue-note').textContent = snapshot.truncated
        ? `Search covers ${snapshot.issues.length.toLocaleString()} loaded issues. ${snapshot.truncated.toLocaleString()} additional issues are not shown.`
        : 'Search covers issues in this indexed snapshot. Select a manifest to inspect its declaration.';
    save();
}

function clearSnapshot(): void {
    snapshot = undefined;
    element('issue-section').hidden = true;
    element('issues').replaceChildren();
    element('notes').replaceChildren();
    element('notes').hidden = true;
    previous.disabled = true;
    next.disabled = true;
    for (const id of ['resources', 'files', 'duplicates', 'missing', 'ambiguous']) { element(`count-${id}`).textContent = '—'; }
}
function loading(): void {
    clearSnapshot();
    element('loading').hidden = false;
    element('failure').hidden = true;
    element('overview').setAttribute('aria-busy', 'true');
    element('server-state').textContent = 'Checking…';
    element('server-state').removeAttribute('data-state');
    element('server-message').textContent = 'Waiting for the language server snapshot.';
    element<HTMLButtonElement>('refresh').disabled = true;
    status.textContent = 'Loading workspace health…';
}
function renderHealth(data: WorkspaceHealthView): void {
    clearSnapshot();
    element('loading').hidden = true;
    element('overview').setAttribute('aria-busy', 'false');
    element<HTMLButtonElement>('refresh').disabled = false;
    element('server-state').textContent = data.server.ok ? 'Language server ready' : 'Unavailable';
    element('server-state').setAttribute('data-state', data.server.ok ? 'ready' : 'unavailable');
    element('server-message').textContent = data.server.message;
    element('notes').hidden = data.notes.length === 0;
    element('notes').replaceChildren(...data.notes.map((note) => node('li', note)));
    element('failure').hidden = data.server.ok;
    if (!data.server.ok) {
        element('failure-message').textContent = data.server.message || 'The language server could not provide a workspace snapshot. View its output for details, then try Refresh.';
        status.textContent = 'Workspace checks unavailable. View the language server output or refresh to retry.';
        return;
    }
    snapshot = data;
    for (const [id, count] of [['resources', data.resources], ['files', data.files], ['duplicates', data.counts.duplicates],
        ['missing', data.counts.missing], ['ambiguous', data.counts.ambiguous]] as const) { element(`count-${id}`).textContent = count.toLocaleString(); }
    element('issue-section').hidden = false;
    renderIssues();
    const total = data.counts.duplicates + data.counts.missing + data.counts.ambiguous;
    status.textContent = `${data.resources.toLocaleString()} indexed resources · ${data.files.toLocaleString()} files · ${total.toLocaleString()} resource ${total === 1 ? 'issue' : 'issues'}`;
}

window.addEventListener('message', (event: MessageEvent<WorkspaceHealthMessage>) => {
    if (event.data?.type === 'loading') { loading(); }
    else if (event.data?.type === 'health') { renderHealth(event.data.data); }
});
function applySearch(reset = true): void {
    if (timer) { clearTimeout(timer); timer = undefined; }
    state.query = search.value.slice(0, 256);
    state.kind = kinds.includes(kind.value) ? kind.value : 'all';
    if (reset) { state.offset = 0; }
    save();
    renderIssues();
}
search.value = state.query;
kind.value = state.kind;
search.addEventListener('input', () => { if (timer) { clearTimeout(timer); } timer = setTimeout(() => applySearch(), 120); });
search.addEventListener('keydown', (event) => { if (event.key === 'Enter') { applySearch(); } });
kind.addEventListener('change', () => applySearch());
previous.addEventListener('click', () => { state.offset = Math.max(0, state.offset - 50); applySearch(false); });
next.addEventListener('click', () => { state.offset += 50; applySearch(false); });
element('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
element('output').addEventListener('click', () => vscode.postMessage({ type: 'output' }));
vscode.postMessage({ type: 'ready' });
