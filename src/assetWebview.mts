/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { decodeAssetTexture } from './assetTextureDecode.mjs';
import type { AssetAction, AssetDetail, AssetEntry, AssetMessage, AssetPixels, AssetTexture, AssetView } from './assetTypes.js';

declare function acquireVsCodeApi(): { postMessage(message: AssetAction): void; getState(): unknown; setState(value: unknown): void };
const vscode = acquireVsCodeApi();
function element<T extends HTMLElement = HTMLElement>(id: string): T { const value = document.getElementById(id); if (!value) { throw new Error(`Missing asset element ${id}`); } return value as T; }
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] { const value = document.createElement(tag); if (text !== undefined) { value.textContent = text; } return value; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
const saved = vscode.getState();
const prior = record(saved) ? saved : {};
const categories = ['all', 'texture', 'model', 'map', 'image', 'audio', 'video', 'metadata', 'other'];
const state = { query: typeof prior.query === 'string' ? prior.query.slice(0, 256) : '',
    category: typeof prior.category === 'string' && categories.includes(prior.category) ? prior.category : 'all',
    mode: typeof prior.mode === 'string' && ['assets', 'references', 'health'].includes(prior.mode) ? prior.mode : 'assets',
    offset: typeof prior.offset === 'number' && Number.isSafeInteger(prior.offset) && prior.offset >= 0 ? Math.min(5000, Math.floor(prior.offset / 50) * 50) : 0,
    selectedPath: typeof prior.selectedPath === 'string' ? prior.selectedPath.slice(0, 4096) : '',
    resourcePath: typeof prior.resourcePath === 'string' ? prior.resourcePath.slice(0, 4096) : '',
    reportQuery: typeof prior.reportQuery === 'string' ? prior.reportQuery.slice(0, 256) : '',
    referencePath: typeof prior.referencePath === 'string' ? prior.referencePath.slice(0, 4096) : '', reportFilter: 'all', reportOffset: 0 };
let view: AssetView | undefined;
let detail: AssetDetail | undefined;
let selected: AssetEntry | undefined;
let sequence = 0, detailRequest = 0, pixelRequest = 0, referenceRequest = 0;
let referenceFocus: { assetId: string; path: string; ids?: Set<string>; incomplete?: boolean } | undefined;
let pixels: { data: Uint8Array; width: number; height: number } | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
const search = element<HTMLInputElement>('search'), category = element<HTMLSelectElement>('category'), mode = element<HTMLSelectElement>('mode');
const textureSelect = element<HTMLSelectElement>('textures'), mipSelect = element<HTMLSelectElement>('mip');
function save(): void { vscode.setState({ ...state }); }
function tokens(value: string): string[] { return value.trim().toLowerCase().split(/\s+/).filter(Boolean); }
function matches(text: string, query: string[]): boolean { const lower = text.toLowerCase(); return query.every((token) => lower.includes(token)); }
function error(message: string): void { element('error').textContent = message; element('error').hidden = !message; }
function status(message: string): void { element('status').textContent = message; }
function bytes(value: number): string { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 / 1024).toFixed(1)} MiB`; }
function action(type: 'openAsset' | 'copyName' | 'copyHash'): void { if (selected && view) { vscode.postMessage({ type, id: selected.id }); } }
function sourceButton(id: string, label: string): HTMLButtonElement {
    const button = node('button', label); button.className = 'source-button';
    button.addEventListener('click', () => { if (view) { vscode.postMessage({ type: 'openSource', id }); } }); return button;
}
function targetButton(id: string, label: string): HTMLButtonElement {
    const button = node('button', label); button.className = 'source-button';
    button.addEventListener('click', () => { const entry = view?.entries.find((entry) => entry.id === id); if (entry) { state.mode = 'assets'; mode.value = state.mode; changeMode(); select(entry); } }); return button;
}
function renderAssets(): void {
    if (!view) { return; }
    const query = tokens(state.query);
    const entries = view.entries.filter((entry) => (state.category === 'all' || entry.category === state.category)
        && matches(`${entry.path} ${entry.format} ${entry.category} ${entry.hash ?? ''} ${entry.hash === undefined ? '' : `0x${entry.hash.toString(16).padStart(8, '0')}`}`, query));
    state.offset = Math.min(state.offset, Math.max(0, Math.ceil(entries.length / 50) - 1) * 50);
    const page = entries.slice(state.offset, state.offset + 50);
    const selectionOnPage = page.some((entry) => selected?.id === entry.id);
    element('results').replaceChildren(...page.map((entry) => {
        const li = node('li'); li.setAttribute('role', 'presentation');
        const button = node('button'); button.className = 'result'; button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', String(selected?.id === entry.id)); button.tabIndex = selected?.id === entry.id || (!selectionOnPage && entry === page[0]) ? 0 : -1;
        const name = node('span', entry.path); name.className = 'result-name'; const meta = node('span', `${entry.format} · ${bytes(entry.size)}${entry.issues.length ? ' · Check notes' : ''}`); meta.className = 'result-meta';
        button.append(name, meta); button.addEventListener('click', () => select(entry));
        button.addEventListener('keydown', (event) => {
            const index = page.indexOf(entry);
            const nextIndex = event.key === 'ArrowDown' ? Math.min(page.length - 1, index + 1) : event.key === 'ArrowUp' ? Math.max(0, index - 1)
                : event.key === 'Home' ? 0 : event.key === 'End' ? page.length - 1 : -1;
            if (nextIndex >= 0) { event.preventDefault(); select(page[nextIndex]); element('results').querySelectorAll<HTMLButtonElement>('button')[nextIndex]?.focus(); }
        });
        li.append(button); return li;
    }));
    element('result-count').textContent = `${entries.length.toLocaleString()} matching assets`;
    element<HTMLButtonElement>('previous').disabled = state.offset === 0;
    element<HTMLButtonElement>('next').disabled = state.offset + page.length >= entries.length;
    element('page-range').textContent = entries.length ? `${state.offset + 1}–${state.offset + page.length} / ${entries.length}` : '0 assets'; save();
}
function clearPreview(): void {
    for (const media of element('preview').querySelectorAll<HTMLMediaElement>('audio,video')) { media.pause(); media.removeAttribute('src'); media.load(); }
    pixels = undefined; element('preview').replaceChildren(); element('preview').hidden = true; element('preview-note').textContent = '';
}
function select(entry: AssetEntry): void {
    selected = entry; state.selectedPath = entry.path; detail = undefined; clearPreview();
    detailRequest = ++sequence; pixelRequest = ++sequence;
    element('detail').hidden = true; element('empty').hidden = false;
    element('empty').replaceChildren(node('h2', 'Loading asset…'), node('p', entry.path)); error(''); renderAssets();
    vscode.postMessage({ type: 'detail', id: entry.id, requestId: detailRequest });
}
function texture(): AssetTexture | undefined { return textureSelect.value === '' ? undefined : detail?.textures?.find((texture) => texture.id === Number(textureSelect.value)); }
function requestTexture(): void {
    const current = texture(); clearPreview(); pixelRequest = ++sequence;
    if (!current) { const message = 'No textures match this filter.'; element('preview-note').textContent = message; status(message); return; }
    if (!current || !selected || !current.encoding || current.previewMip === undefined) {
        element('preview-note').textContent = current.notes.join(' ') || 'No preview is available for this texture.';
        status('Texture metadata loaded; preview unavailable.'); return;
    }
    const mip = Number(mipSelect.value);
    if (!Number.isInteger(mip) || mip < 0 || mip >= current.mipCount) { return; }
    pixelRequest = ++sequence; status('Decoding texture preview…');
    vscode.postMessage({ type: 'texture', id: selected.id, textureId: current.id, mip, requestId: pixelRequest });
}
function chooseTexture(): void {
    const current = texture(); mipSelect.replaceChildren();
    if (current) {
        for (let mip = 0; mip < current.mipCount; mip++) {
            const width = Math.max(1, current.width >> mip), height = Math.max(1, current.height >> mip);
            const option = node('option', `${mip} · ${width} × ${height}`); option.value = String(mip); option.disabled = width * height > 1024 * 1024; mipSelect.append(option);
        }
        mipSelect.value = String(current.previewMip ?? 0);
    }
    requestTexture();
}
function filterTextures(): void {
    const previous = textureSelect.value, query = tokens(element<HTMLInputElement>('texture-search').value);
    const textures = detail?.textures?.filter((texture) => matches(`${texture.name} ${texture.format}`, query)) ?? [];
    textureSelect.replaceChildren(...textures.map((texture) => { const option = node('option', `${texture.name} · ${texture.width} × ${texture.height} · ${texture.format}`); option.value = String(texture.id); return option; }));
    if (textures.some((texture) => String(texture.id) === previous)) { textureSelect.value = previous; }
    chooseTexture();
}
function renderDetail(data: AssetDetail): void {
    detail = data; element('empty').hidden = true; element('detail').hidden = false;
    element<HTMLButtonElement>('copy-hash').disabled = selected?.hash === undefined;
    element('detail-title').textContent = data.title;
    element('metadata').replaceChildren(...data.metadata.flatMap((row) => [node('dt', row.name), node('dd', row.value)]));
    element('detail-notes').replaceChildren(...data.notes.map((note) => node('li', note)));
    element('texture-tools').hidden = !data.textures;
    element('text-preview').hidden = data.text === undefined; element('text-preview').textContent = data.text ?? '';
    clearPreview();
    if (data.textures) { element<HTMLInputElement>('texture-search').value = ''; filterTextures(); }
    if (data.media) {
        const media = data.media.kind === 'image' ? node('img') : data.media.kind === 'audio' ? node('audio') : node('video');
        media.src = `data:${data.media.mime};base64,${data.media.data}`;
        if (media instanceof HTMLImageElement) { media.alt = data.title; media.addEventListener('load', () => { if (detail === data) { element('preview-note').textContent = `${media.naturalWidth} × ${media.naturalHeight}`; } }); }
        else { media.controls = true; media.preload = 'metadata'; }
        media.addEventListener('error', () => { if (detail === data) { element('preview-note').textContent = 'This file could not be rendered. Its format or codec may be unsupported.'; } });
        element('preview').append(media); element('preview').hidden = false;
    }
    status(data.textures ? `${data.textures.length} textures · mip previews limited to one megapixel` : 'Asset loaded.');
}
function draw(): void {
    if (!pixels) { return; }
    const canvas = node('canvas'); canvas.width = pixels.width; canvas.height = pixels.height;
    const context = canvas.getContext('2d'); if (!context) { error('Canvas rendering is unavailable.'); return; }
    const rgba = new Uint8ClampedArray(pixels.data);
    const channel = element<HTMLSelectElement>('channels').value;
    if (channel !== 'rgba') { for (let index = 0; index < rgba.length; index += 4) { if (channel === 'alpha') { rgba[index] = rgba[index + 1] = rgba[index + 2] = rgba[index + 3]; } rgba[index + 3] = 255; } }
    context.putImageData(new ImageData(rgba, pixels.width, pixels.height), 0, 0);
    canvas.setAttribute('aria-label', `Texture preview ${pixels.width} by ${pixels.height}`);
    element('preview').replaceChildren(canvas); element('preview').hidden = false;
}
function renderPixels(data: AssetPixels): void {
    if (!selected || data.assetId !== selected.id || data.textureId !== texture()?.id) { return; }
    try {
        if (data.data.length > 6 * 1024 * 1024) { throw new Error('Preview payload exceeds the size limit.'); }
        const binary = atob(data.data), raw = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        pixels = { width: data.width, height: data.height, data: decodeAssetTexture(raw, data.width, data.height, data.encoding) };
        draw(); element('preview-note').textContent = `${data.width} × ${data.height} · ${data.encoding} · mip ${data.mip}. ${texture()?.notes.join(' ') ?? ''}`;
        status('Texture preview loaded.');
    } catch (reason) { error(reason instanceof Error ? reason.message : String(reason)); }
}
function renderReport(): void {
    if (!view || state.mode === 'assets') { return; }
    element('reference-focus').hidden = state.mode !== 'references' || !referenceFocus;
    element('reference-focus-label').textContent = referenceFocus
        ? `${referenceFocus.ids ? 'References for' : 'Finding references for'} ${referenceFocus.path}${referenceFocus.incomplete ? ' · Matching budget reached; results are partial.' : ''}` : '';
    const query = tokens(state.reportQuery), rows: HTMLElement[] = [];
    const references = state.mode === 'references' ? view.references.filter((reference) => (!referenceFocus || referenceFocus.ids?.has(reference.id)) && !(state.reportFilter === 'unresolved' && reference.resolved)
        && matches(`${reference.kind} ${reference.name} ${reference.source} ${reference.note ?? ''} ${reference.targets.map((target) => target.path).join(' ')}`, query)) : [];
    const issues = state.mode === 'health' ? view.issues.filter((issue) => !(state.reportFilter === 'warning' && issue.severity !== 'warning') && matches(issue.message, query)) : [];
    const total = references.length + issues.length;
    state.reportOffset = Math.min(state.reportOffset, Math.max(0, Math.ceil(total / 50) - 1) * 50);
    if (state.mode === 'references') {
        for (const reference of references.slice(state.reportOffset, state.reportOffset + 50)) {
            const li = node('li'); li.className = 'report-item'; const name = node('span', `${reference.kind} · ${reference.name}`); name.className = 'report-name'; li.append(name, sourceButton(reference.id, reference.source));
            if (reference.note) { const note = node('span', reference.note); note.className = 'report-note'; li.append(note); }
            const links = node('div'); links.className = 'target-links'; for (const target of reference.targets.slice(0, 50)) { links.append(targetButton(target.id, target.path)); }
            if (reference.targetCount > reference.targets.length) { links.append(node('span', `${reference.targetCount - reference.targets.length} more matching assets; narrow the Assets search to inspect them.`)); }
            li.append(links); rows.push(li);
        }
    } else {
        for (const issue of issues.slice(state.reportOffset, state.reportOffset + 50)) {
            const li = node('li'); li.className = 'report-item'; const severity = node('span', issue.severity); severity.className = 'issue-level'; li.append(severity, node('span', issue.message));
            if (issue.assetId) { const entry = view.entries.find((entry) => entry.id === issue.assetId); if (entry) { const links = node('div'); links.className = 'target-links'; links.append(targetButton(entry.id, 'Inspect asset')); li.append(links); } }
            if (issue.sourceId) { const links = node('div'); links.className = 'target-links'; links.append(sourceButton(issue.sourceId, issue.source ?? 'Open declaration')); li.append(links); }
            rows.push(li);
        }
    }
    element('report-list').replaceChildren(...rows);
    element('report-count').textContent = total ? `${total.toLocaleString()} matching entries` : state.mode === 'health'
        ? 'No matching findings in the completed checks. Review scan limits above.' : 'No matching source references.';
    element<HTMLButtonElement>('report-previous').disabled = state.reportOffset === 0;
    element<HTMLButtonElement>('report-next').disabled = state.reportOffset + rows.length >= total;
    element('report-range').textContent = total ? `${state.reportOffset + 1}–${state.reportOffset + rows.length} / ${total}` : '0 entries';
    save();
}
function findReferences(entry: AssetEntry, clearQuery = true): void {
    state.mode = 'references'; state.referencePath = entry.path; state.reportOffset = 0; state.reportFilter = 'all';
    if (clearQuery) { state.reportQuery = ''; }
    mode.value = state.mode; element<HTMLInputElement>('report-search').value = state.reportQuery; element<HTMLSelectElement>('report-filter').value = 'all';
    referenceFocus = { assetId: entry.id, path: entry.path }; referenceRequest = ++sequence;
    changeMode(); status('Finding asset references…');
    vscode.postMessage({ type: 'findReferences', id: entry.id, requestId: referenceRequest });
}
function changeMode(): void {
    state.mode = ['assets', 'references', 'health'].includes(mode.value) ? mode.value : 'assets';
    element('workspace').hidden = !view || state.mode !== 'assets'; element('report').hidden = !view || state.mode === 'assets';
    const filter = element<HTMLSelectElement>('report-filter');
    filter.options[1].hidden = state.mode !== 'references'; filter.options[2].hidden = state.mode !== 'health';
    if ((state.mode === 'references' && state.reportFilter === 'warning') || (state.mode === 'health' && state.reportFilter === 'unresolved')) { state.reportFilter = 'all'; filter.value = 'all'; }
    renderReport(); save();
}
window.addEventListener('message', (event: MessageEvent<AssetMessage>) => {
    if (event.source !== null && event.source !== window && event.origin !== window.location.origin) { return; }
    const message = event.data;
    if (message?.type === 'loading') {
        view = undefined; selected = undefined; detail = undefined; referenceFocus = undefined; ++sequence; detailRequest = pixelRequest = referenceRequest = sequence;
        clearPreview(); element('workspace').hidden = true; element('report').hidden = true; element('loading').hidden = false;
        element<HTMLButtonElement>('refresh').disabled = true; error(''); status('Scanning selected resource…');
    } else if (message?.type === 'state') {
        view = message.data; element('loading').hidden = true; element<HTMLButtonElement>('refresh').disabled = false; error('');
        if (state.resourcePath !== view.resource.path) { state.selectedPath = ''; state.referencePath = ''; state.offset = 0; state.reportOffset = 0; }
        state.resourcePath = view.resource.path;
        element('resource-name').textContent = view.resource.name; element('resource-path').textContent = view.resource.path;
        element('counts').textContent = `${view.entries.length.toLocaleString()} assets · ${bytes(view.totalBytes)} · ${view.references.length.toLocaleString()} source references · ${view.issues.filter((issue) => issue.severity === 'warning').length} warnings`;
        element('note-list').replaceChildren(...view.notes.map((note) => node('li', note)));
        selected = undefined; detail = undefined; element('detail').hidden = true; element('empty').hidden = false;
        element('empty').replaceChildren(node('h2', 'Select an asset'), node('p', 'Inspect textures, media, metadata and local source references.'));
        changeMode(); renderAssets();
        const restore = view.entries.find((entry) => entry.path === state.selectedPath); if (restore) { select(restore); }
        const referenceRestore = view.entries.find((entry) => entry.path === state.referencePath);
        if (referenceRestore && state.mode === 'references') { findReferences(referenceRestore, false); }
        else { state.referencePath = ''; referenceFocus = undefined; }
        status('Resource inventory loaded.');
        vscode.postMessage({ type: 'loaded', snapshotId: view.snapshotId });
    } else if (message?.type === 'detail' && message.requestId === detailRequest && message.data.id === selected?.id) { renderDetail(message.data); }
    else if (message?.type === 'referenceMatches' && message.requestId === referenceRequest && message.assetId === referenceFocus?.assetId) {
        referenceFocus.ids = new Set(message.ids); referenceFocus.incomplete = message.incomplete; renderReport(); status('Asset references loaded.');
    }
    else if (message?.type === 'pixels' && message.requestId === pixelRequest) { renderPixels(message.data); }
    else if (message?.type === 'error' && (message.requestId === undefined || message.requestId === detailRequest || message.requestId === pixelRequest || message.requestId === referenceRequest)) {
        element('loading').hidden = true; element<HTMLButtonElement>('refresh').disabled = false; error(message.message); status(message.message);
        if (message.requestId === detailRequest) { element('empty').replaceChildren(node('h2', 'Asset inspection unavailable'), node('p', message.message)); }
        if (message.requestId === referenceRequest && referenceFocus) { referenceFocus.ids = new Set(); referenceFocus.incomplete = true; renderReport(); }
    }
});
function applySearch(): void { if (timer) { clearTimeout(timer); timer = undefined; } state.query = search.value.slice(0, 256); state.category = category.value; state.offset = 0; renderAssets(); }
search.value = state.query; category.value = state.category; mode.value = state.mode; element<HTMLInputElement>('report-search').value = state.reportQuery;
search.addEventListener('input', () => { if (timer) { clearTimeout(timer); } timer = setTimeout(applySearch, 120); });
search.addEventListener('keydown', (event) => { if (event.key === 'Enter') { applySearch(); } }); category.addEventListener('change', applySearch); mode.addEventListener('change', changeMode);
element('previous').addEventListener('click', () => { state.offset = Math.max(0, state.offset - 50); renderAssets(); });
element('next').addEventListener('click', () => { state.offset += 50; renderAssets(); });
element('report-search').addEventListener('input', () => { state.reportQuery = element<HTMLInputElement>('report-search').value.slice(0, 256); state.reportOffset = 0; renderReport(); });
element('report-filter').addEventListener('change', () => { state.reportFilter = element<HTMLSelectElement>('report-filter').value; state.reportOffset = 0; renderReport(); });
element('report-previous').addEventListener('click', () => { state.reportOffset = Math.max(0, state.reportOffset - 50); renderReport(); });
element('report-next').addEventListener('click', () => { state.reportOffset += 50; renderReport(); });
textureSelect.addEventListener('change', chooseTexture); mipSelect.addEventListener('change', requestTexture); element('texture-search').addEventListener('input', filterTextures);
element('channels').addEventListener('change', draw); element('zoom').addEventListener('change', () => { element('preview').dataset.zoom = element<HTMLSelectElement>('zoom').value; });
element('open-asset').addEventListener('click', () => action('openAsset')); element('copy-name').addEventListener('click', () => action('copyName')); element('copy-hash').addEventListener('click', () => action('copyHash'));
element('find-references').addEventListener('click', () => { if (selected) { findReferences(selected); } });
element('reference-focus-clear').addEventListener('click', () => { state.referencePath = ''; referenceFocus = undefined; referenceRequest = ++sequence; renderReport(); });
element('choose').addEventListener('click', () => vscode.postMessage({ type: 'choose' })); element('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
vscode.postMessage({ type: 'ready' });
