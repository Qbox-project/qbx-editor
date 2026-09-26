/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { NuiAction, NuiMessage, NuiPreset, NuiView } from './nuiTypes.js';

declare function acquireVsCodeApi(): { postMessage(message: NuiAction): void; getState(): unknown; setState(state: unknown): void };
interface Draft { message: string; mocks: string; appliedMocks: string; name: string; selectedPreset: string; query: string }
interface SavedDraft { uri: string; draft: Draft }
type Activity = { kind: 'callback'; name: string; request: string; response: string; matched: boolean }
    | { kind: 'error'; message: string };

const vscode = acquireVsCodeApi();
const MAX_JSON_BYTES = 64 * 1024;
const encoder = new TextEncoder();
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function element<T extends HTMLElement = HTMLElement>(id: string): T {
    const found = document.getElementById(id);
    if (!found) { throw new Error(`Missing NUI element: ${id}`); }
    return found as T;
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
    const result = document.createElement(tag);
    if (text !== undefined) { result.textContent = text; }
    return result;
}
function bounded(value: unknown, fallback: string, limit = MAX_JSON_BYTES): string {
    return typeof value === 'string' && value.length <= limit && encoder.encode(value).length <= limit ? value : fallback;
}
function short(value: unknown, limit: number): string { return typeof value === 'string' ? value.slice(0, limit) : ''; }
function newDraft(value?: unknown): Draft {
    const data = record(value) ? value : {};
    return { message: bounded(data.message, '{}'), mocks: bounded(data.mocks, '{}'), appliedMocks: bounded(data.appliedMocks, '{}'),
        name: short(data.name, 80), selectedPreset: short(data.selectedPreset, 80), query: short(data.query, 256) };
}
const stored = vscode.getState();
const drafts: SavedDraft[] = record(stored) && Array.isArray(stored.drafts) ? stored.drafts.slice(-4).flatMap((entry: unknown) =>
    record(entry) && typeof entry.uri === 'string' && entry.uri.length <= 4096
        ? [{ uri: entry.uri, draft: newDraft(entry.draft) }] : []) : [];
const frame = element<HTMLIFrameElement>('preview');
const frameOrigin = document.body.dataset.frameOrigin || '';
const messageInput = element<HTMLTextAreaElement>('message');
const mocksInput = element<HTMLTextAreaElement>('mocks');
const presetInput = element<HTMLSelectElement>('presets');
const nameInput = element<HTMLInputElement>('preset-name');
const queryInput = element<HTMLInputElement>('callback-search');
const status = element('status');
let view: NuiView | undefined;
let draft = newDraft();
let frameReady = false;
let activeFrameUrl = '';
let activeToken = '';
let activeFrameResource = '';
let startupTimer: ReturnType<typeof setTimeout> | undefined;
let queryTimer: ReturnType<typeof setTimeout> | undefined;
let pendingPreset = false;
let activity: Activity[] = [];
const activityNodes = new WeakMap<Activity, HTMLLIElement>();

function notice(message: string, kind: 'notice' | 'error' = 'notice'): void {
    const target = element('notice');
    target.textContent = message;
    target.dataset.kind = kind;
    target.hidden = !message;
    status.textContent = message;
}
function saveDraft(): void {
    if (!view || view.resource.uri.length > 4096) { return; }
    // Oversized in-progress input stays in the textarea, but never enlarges persisted state.
    draft.message = bounded(messageInput.value, draft.message);
    draft.mocks = bounded(mocksInput.value, draft.mocks);
    draft.name = nameInput.value.slice(0, 80);
    draft.query = queryInput.value.slice(0, 256);
    const previous = drafts.findIndex((entry) => entry.uri === view!.resource.uri);
    if (previous >= 0) { drafts.splice(previous, 1); }
    drafts.push({ uri: view.resource.uri, draft: { ...draft } });
    while (drafts.length > 4) { drafts.shift(); }
    vscode.setState({ drafts });
}
function applyDraft(): void {
    messageInput.value = draft.message;
    mocksInput.value = draft.mocks;
    nameInput.value = draft.name;
    queryInput.value = draft.query;
}
function json(text: string, mocks: boolean): { value?: unknown; error?: string } {
    if (encoder.encode(text).length > MAX_JSON_BYTES) { return { error: 'JSON exceeds 65,536 bytes. Shorten it before sending, saving or retaining this draft.' }; }
    let value: unknown;
    try { value = JSON.parse(text) as unknown; }
    catch (error) { return { error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}` }; }
    if (mocks) {
        if (!record(value)) { return { error: 'Mock responses must be a JSON object keyed by callback name.' }; }
        const names = Object.keys(value);
        if (names.length > 100 || names.some((name) => name.length < 1 || name.length > 256 || /[\x00-\x1f\x7f]/.test(name))) {
            return { error: 'Use at most 100 mock callbacks, with names between 1 and 256 printable characters.' };
        }
    }
    const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
    let nodes = 0;
    while (pending.length) {
        const entry = pending.pop()!;
        if (++nodes > 10_000 || entry.depth > 64) { return { error: 'JSON is too deeply nested or has too many values.' }; }
        if (entry.value !== null && typeof entry.value === 'object') {
            for (const child of Object.values(entry.value)) { pending.push({ value: child, depth: entry.depth + 1 }); }
        }
    }
    return { value };
}
function validate(showErrors = false): { message: ReturnType<typeof json>; mocks: ReturnType<typeof json> } {
    const message = json(messageInput.value, false);
    const mocks = json(mocksInput.value, true);
    for (const [id, result] of [['message', message], ['mocks', mocks]] as const) {
        element(`${id}-size`).textContent = `${encoder.encode(id === 'message' ? messageInput.value : mocksInput.value).length.toLocaleString()} / 65,536 bytes`;
        const error = element(`${id}-error`);
        error.textContent = result.error ?? '';
        error.hidden = !showErrors || !result.error;
    }
    return { message, mocks };
}
function updateButtons(): void {
    const present = !!view;
    for (const input of [messageInput, mocksInput, nameInput, presetInput]) { input.disabled = !present; }
    const parsed = validate();
    element<HTMLButtonElement>('reload').disabled = !present;
    element<HTMLButtonElement>('send').disabled = !frameReady || !!parsed.message.error;
    element<HTMLButtonElement>('apply-mocks').disabled = !frameReady || !!parsed.mocks.error;
    element<HTMLButtonElement>('save-preset').disabled = !present || pendingPreset || !nameInput.value.trim() || /[\x00-\x1f\x7f]/.test(nameInput.value)
        || !!parsed.message.error || !!parsed.mocks.error;
    element<HTMLButtonElement>('delete-preset').disabled = !present || pendingPreset || !view?.presets.some((preset) => preset.name === draft.selectedPreset);
    element('draft-note').textContent = !view ? 'Select a resource to use presets.' : pendingPreset ? 'Updating presets…'
        : 'Drafts stay with this resource. Loading a preset does not send a message or apply mocks.';
}
function presets(): void {
    const items = view?.presets ?? [];
    if (!items.some((preset) => preset.name === draft.selectedPreset)) { draft.selectedPreset = ''; }
    const options = [node('option', 'Unsaved draft')];
    options[0].value = '';
    for (const preset of items) { const option = node('option', preset.name); option.value = preset.name; options.push(option); }
    presetInput.replaceChildren(...options);
    presetInput.value = draft.selectedPreset;
}

function renderCallbacks(): void {
    const tokens = queryInput.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (view?.callbacks ?? []).filter((callback) => {
        const text = `${callback.name}\n${callback.source}`.toLowerCase();
        return tokens.every((token) => text.includes(token));
    });
    const shown = matches.slice(0, 200);
    element('callbacks').replaceChildren(...shown.map((callback) => {
        const li = node('li');
        li.className = 'callback-item';
        const text = node('div');
        const name = node('span', callback.name);
        name.className = 'callback-name';
        const source = node('span', callback.source);
        source.className = 'callback-source';
        text.append(name, source);
        const button = node('button', 'Open Lua');
        button.setAttribute('aria-label', `Open Lua callback ${callback.name} at ${callback.source}`);
        button.addEventListener('click', () => {
            if (view?.callbacks.some((entry) => entry.id === callback.id)) { vscode.postMessage({ type: 'openSource', id: callback.id }); }
        });
        li.append(text, button);
        return li;
    }));
    element('callback-count').textContent = `${matches.length.toLocaleString()} ${matches.length === 1 ? 'callback' : 'callbacks'}`;
    element('callback-empty').hidden = matches.length > 0;
    element('callback-empty').textContent = !view ? 'Select a resource to view its indexed callbacks.'
        : tokens.length ? 'No indexed callbacks match your filter.' : 'No Lua NUI callbacks are indexed in this resource.';
    const notes: string[] = [];
    if (matches.length > shown.length) { notes.push(`First 200 matches shown. Refine the filter to find another callback.`); }
    if (view?.truncated) { notes.push(`${view.truncated.toLocaleString()} further callbacks are not included in this snapshot.`); }
    element('callback-note').textContent = notes.join(' ');
}
function clipped(value: string, limit: number): string {
    if (value.length <= limit) { return value; }
    const end = /[\uD800-\uDBFF]/.test(value[limit - 1]) ? limit - 1 : limit;
    return `${value.slice(0, end)}\n… [truncated]`;
}
function renderActivity(): void {
    element('activity-empty').hidden = activity.length > 0;
    element('activity-count').textContent = `${activity.length} / 30 recent entries`;
    const nodes = activity.map((entry) => {
        const existing = activityNodes.get(entry);
        if (existing) { return existing; }
        const li = node('li');
        li.className = 'activity-item';
        if (entry.kind === 'error') {
            const error = node('p', entry.message);
            error.className = 'activity-error';
            li.append(error);
        } else {
            const details = node('details');
            const summary = node('summary');
            const name = node('span', entry.name);
            name.className = 'activity-name';
            const state = node('span', entry.matched ? 'Mock matched' : 'No mock configured');
            state.className = 'activity-meta';
            summary.append(name, state);
            const request = node('p', 'Request');
            request.className = 'activity-label';
            const response = node('p', 'Response');
            response.className = 'activity-label';
            details.append(summary, request, node('pre', entry.request), response, node('pre', entry.response));
            const handlers = view?.callbacks.filter((callback) => callback.name === entry.name) ?? [];
            if (handlers.length) {
                const sources = node('div');
                sources.className = 'activity-sources';
                for (const handler of handlers) {
                    const button = node('button', handlers.length > 1 ? `Open Lua handler · ${handler.source}` : 'Open Lua handler');
                    button.title = handler.source;
                    button.setAttribute('aria-label', `Open Lua handler for ${entry.name} at ${handler.source}`);
                    button.addEventListener('click', () => {
                        if (view?.callbacks.some((callback) => callback.id === handler.id && callback.name === entry.name)) {
                            vscode.postMessage({ type: 'openSource', id: handler.id });
                        }
                    });
                    sources.append(button);
                }
                details.append(sources);
            }
            li.append(details);
        }
        activityNodes.set(entry, li);
        return li;
    });
    const container = element('activity');
    let cursor = container.firstChild;
    for (const child of nodes) {
        if (child === cursor) { cursor = cursor.nextSibling; }
        else { container.insertBefore(child, cursor); }
    }
    while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
}
function addActivity(entry: Activity): void { activity.unshift(entry); activity = activity.slice(0, 30); renderActivity(); }
function configure(beforeReady = false): void {
    if ((!frameReady && !beforeReady) || !activeToken) { return; }
    const mocks = json(draft.appliedMocks, true);
    frame.contentWindow?.postMessage({ channel: 'qbx-nui', token: activeToken, type: 'configure', mocks: mocks.error ? {} : mocks.value }, '*');
}
function stopStartupTimer(): void { if (startupTimer) { clearTimeout(startupTimer); startupTimer = undefined; } }
function setFrame(data: NuiView): void {
    let url = '';
    if (data.frameUrl && data.token && frameOrigin) {
        try { const parsed = new URL(data.frameUrl); if (parsed.origin === frameOrigin && !parsed.username && !parsed.password) { url = parsed.href; } }
        catch { /* Invalid host URLs cannot become iframe navigation. */ }
    }
    const token = url ? data.token! : '';
    if (url === activeFrameUrl && token === activeToken && data.resource.uri === activeFrameResource) { return; }
    stopStartupTimer();
    frameReady = false;
    activeFrameUrl = url;
    activeToken = token;
    activeFrameResource = data.resource.uri;
    activity = [];
    renderActivity();
    frame.hidden = !url;
    element('preview-empty').hidden = !!url;
    if (url) {
        frame.title = `NUI preview for ${data.resource.name}`;
        // The preview is on a separate loopback origin, so its own storage does not expose the parent.
        frame.setAttribute('sandbox', new URL(url).origin !== window.location.origin
            ? 'allow-scripts allow-same-origin' : 'allow-scripts');
        frame.src = url;
        element('preview-state').textContent = 'Starting preview…';
        status.textContent = 'Waiting for the preview bridge…';
        const expectedToken = activeToken;
        startupTimer = setTimeout(() => {
            startupTimer = undefined;
            if (activeToken !== expectedToken || frameReady) { return; }
            element('preview-state').textContent = 'Bridge unavailable';
            const message = 'Preview bridge did not start; check local asset paths and page CSP, then reload the preview.';
            notice(message, 'error');
            addActivity({ kind: 'error', message });
        }, 10_000);
    } else {
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.removeAttribute('src');
        element('preview-state').textContent = 'No preview';
        element('empty-title').textContent = data.uiPage ? 'Preview unavailable' : 'No NUI page';
        element('empty-description').textContent = data.uiPage
            ? 'Check the resource notes below. A local built UI page is required for this preview.'
            : 'This resource has no indexed ui_page declaration. Choose a resource with a local NUI page.';
        status.textContent = 'The selected resource has no available local preview.';
    }
}
function renderState(data: NuiView): void {
    const changedResource = view?.resource.uri !== data.resource.uri;
    if (changedResource) {
        saveDraft();
        draft = newDraft(drafts.find((entry) => entry.uri === data.resource.uri)?.draft);
    }
    view = data;
    pendingPreset = false;
    if (changedResource) { applyDraft(); notice(''); }
    element('resource-name').textContent = data.resource.name;
    element('resource-path').textContent = data.resource.path;
    element('ui-page').textContent = data.uiPage ?? '—';
    element('notes').hidden = data.notes.length === 0;
    element('notes').replaceChildren(...data.notes.map((text) => node('li', text)));
    presets();
    renderCallbacks();
    setFrame(data);
    updateButtons();
    saveDraft();
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (frame.contentWindow && event.source === frame.contentWindow) {
        const child = event.data;
        if (!activeToken || !record(child) || child.channel !== 'qbx-nui' || child.token !== activeToken) { return; }
        if (child.type === 'configureRequest') {
            configure(true);
        } else if (child.type === 'ready') {
            if (frameReady) { configure(); return; }
            stopStartupTimer();
            frameReady = true;
            element('preview-state').textContent = 'Preview ready';
            configure();
            updateButtons();
            notice('Preview ready. Send a JSON message or apply mock responses.');
            vscode.postMessage({ type: 'previewReady', token: activeToken });
        } else if (child.type === 'callback' && typeof child.name === 'string' && child.name.length > 0 && child.name.length <= 256
            && typeof child.request === 'string' && typeof child.response === 'string' && typeof child.matched === 'boolean') {
            addActivity({ kind: 'callback', name: child.name, request: clipped(child.request, 4096), response: clipped(child.response, 4096), matched: child.matched });
        } else if (child.type === 'error' && typeof child.message === 'string') {
            const message = clipped(child.message, 2048);
            addActivity({ kind: 'error', message });
            notice(message, 'error');
        }
        return;
    }
    // VS Code rewrites window.parent to window, so the actual wrapper cannot be compared by identity.
    // Its forwarded host messages retain this webview's exact origin. The separate-origin preview
    // is handled above and must never enter this host channel.
    if (event.source !== null && event.source !== window && event.origin !== window.location.origin) { return; }
    if (!record(event.data)) { return; }
    const message = event.data as unknown as NuiMessage;
    if (message.type === 'state') { renderState(message.data); }
    else if ((message.type === 'notice' || message.type === 'error') && typeof message.message === 'string') {
        pendingPreset = false;
        updateButtons();
        notice(message.message, message.type);
    }
});

for (const input of [messageInput, mocksInput]) {
    input.maxLength = MAX_JSON_BYTES;
    input.addEventListener('input', () => { saveDraft(); updateButtons(); validate(true); });
}
nameInput.addEventListener('input', () => { saveDraft(); updateButtons(); });
presetInput.addEventListener('change', () => {
    const selected = view?.presets.find((preset) => preset.name === presetInput.value);
    draft.selectedPreset = selected?.name ?? '';
    if (selected) {
        messageInput.value = selected.message;
        mocksInput.value = selected.mocks;
        nameInput.value = selected.name;
        notice(`Loaded preset “${selected.name}”. Send message or Apply mocks when ready.`);
    }
    saveDraft(); updateButtons(); validate(true);
});
element('save-preset').addEventListener('click', () => {
    if (!view || pendingPreset) { return; }
    const parsed = validate(true);
    const name = nameInput.value.trim();
    if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name) || parsed.message.error || parsed.mocks.error) { notice('Enter a printable preset name and valid JSON before saving.', 'error'); return; }
    const preset: NuiPreset = { name, message: messageInput.value, mocks: mocksInput.value };
    pendingPreset = true;
    draft.selectedPreset = name;
    nameInput.value = name;
    saveDraft(); updateButtons();
    notice(`Saving preset “${name}”…`);
    vscode.postMessage({ type: 'savePreset', preset });
});
element('delete-preset').addEventListener('click', () => {
    const name = draft.selectedPreset;
    if (pendingPreset || !view?.presets.some((preset) => preset.name === name)) { return; }
    pendingPreset = true; updateButtons();
    notice(`Deleting preset “${name}”…`);
    vscode.postMessage({ type: 'deletePreset', name });
});
element('send').addEventListener('click', () => {
    if (!frameReady || !activeToken) { return; }
    const parsed = validate(true).message;
    if (parsed.error) { return; }
    saveDraft();
    frame.contentWindow?.postMessage({ channel: 'qbx-nui', token: activeToken, type: 'message', data: parsed.value }, '*');
    notice('Message sent to the preview.');
});
element('apply-mocks').addEventListener('click', () => {
    if (!frameReady) { return; }
    const parsed = validate(true).mocks;
    if (parsed.error) { return; }
    draft.appliedMocks = mocksInput.value;
    saveDraft(); configure();
    const count = Object.keys(parsed.value as Record<string, unknown>).length;
    notice(`${count} mock ${count === 1 ? 'response' : 'responses'} applied to the preview.`);
});
function filterCallbacks(): void {
    if (queryTimer) { clearTimeout(queryTimer); queryTimer = undefined; }
    saveDraft(); renderCallbacks();
}
queryInput.addEventListener('input', () => { if (queryTimer) { clearTimeout(queryTimer); } queryTimer = setTimeout(filterCallbacks, 120); });
queryInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { filterCallbacks(); } });
element('choose').addEventListener('click', () => { saveDraft(); vscode.postMessage({ type: 'chooseResource' }); });
element('reload').addEventListener('click', () => { if (view) { saveDraft(); vscode.postMessage({ type: 'reload' }); } });
window.addEventListener('pagehide', () => { stopStartupTimer(); if (queryTimer) { clearTimeout(queryTimer); } });
applyDraft(); updateButtons();
vscode.postMessage({ type: 'ready' });
