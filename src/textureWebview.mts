/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { decodeAssetTexture } from './assetTextureDecode.mjs';
import type { AssetTexture } from './assetTypes.js';
import { luaString } from './mapLua.js';
import type { EncodeOptions } from './textureEncode.js';
import type { TextureAction, TextureMessage, TextureView } from './textureTypes.js';
import { button, element, facts, fromHost, matches, node, pager, record, tokens } from './viewerDom.mjs';

declare function acquireVsCodeApi(): { postMessage(message: TextureAction): void; getState(): unknown; setState(value: unknown): void };
const vscode = acquireVsCodeApi();
const saved = vscode.getState(), prior = record(saved) ? saved : {};
const state = { query: typeof prior.query === 'string' ? prior.query.slice(0, 256) : '', path: typeof prior.path === 'string' ? prior.path.slice(0, 4096) : '',
    texture: typeof prior.texture === 'string' ? prior.texture.slice(0, 512) : '', compression: typeof prior.compression === 'string' ? prior.compression.slice(0, 16) : 'auto',
    mipmaps: typeof prior.mipmaps === 'string' ? prior.mipmaps.slice(0, 16) : 'auto' };
let view: TextureView | undefined, selected: AssetTexture | undefined, request = 0, pixels: { data: Uint8Array; width: number; height: number } | undefined;
const mipSelect = element<HTMLSelectElement>('mip'), channelSelect = element<HTMLSelectElement>('channels'), stage = element('stage');
const compressionSelect = element<HTMLSelectElement>('compression'), mipmapSelect = element<HTMLSelectElement>('mipmaps');
function save(): void { vscode.setState({ ...state }); }
function status(message: string): void { element('status').textContent = message; }
function copy(text: string, label: string): void { vscode.postMessage({ type: 'copy', text, label }); }
function settings(): EncodeOptions { return { compression: compressionSelect.value, mipmaps: mipmapSelect.value } as EncodeOptions; }
function hash(name: string): string {
    let value = 0;
    for (const char of name.toLowerCase()) { value = (value + (char.charCodeAt(0) & 0xff)) >>> 0; value = (value + (value << 10)) >>> 0; value ^= value >>> 6; }
    value = (value + (value << 3)) >>> 0; value ^= value >>> 11; value = (value + (value << 15)) >>> 0;
    return `0x${value.toString(16).toUpperCase().padStart(8, '0')}`;
}
function filtered(): AssetTexture[] { const query = tokens(state.query); return view?.textures.filter((texture) => matches(`${texture.name} ${texture.format} ${texture.width}x${texture.height}`, query)) ?? []; }
function stageMessage(message: string): void { pixels = undefined; stage.replaceChildren(node('p', message)); }
function draw(): void {
    if (!pixels) { return; }
    const canvas = node('canvas'), context = canvas.getContext('2d'), channel = channelSelect.value;
    canvas.width = pixels.width; canvas.height = pixels.height;
    if (!context) { stageMessage('Canvas rendering is unavailable.'); return; }
    const rgba = new Uint8ClampedArray(pixels.data);
    if (channel !== 'rgba') { for (let index = 0; index < rgba.length; index += 4) { if (channel === 'alpha') { rgba[index] = rgba[index + 1] = rgba[index + 2] = rgba[index + 3]; } rgba[index + 3] = 255; } }
    context.putImageData(new ImageData(rgba, pixels.width, pixels.height), 0, 0);
    canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', `${selected?.name ?? 'Texture'}, ${pixels.width} by ${pixels.height} pixels`);
    stage.replaceChildren(canvas);
}
function requestPixels(): void {
    const texture = selected;
    request++;
    if (!texture) { stageMessage(view?.textures.length === 0 ? 'This dictionary holds no textures yet.' : 'Select a texture.'); return; }
    if (!texture.encoding || texture.previewMip === undefined) { stageMessage(texture.notes.join(' ') || 'No preview is available for this texture.'); return; }
    const mip = Number(mipSelect.value);
    if (!Number.isInteger(mip) || mip < 0 || mip >= texture.mipCount) { return; }
    stageMessage('Decoding…');
    vscode.postMessage({ type: 'pixels', textureId: texture.id, mip, requestId: request });
}
function renderDetail(): void {
    const texture = selected, detail = element('detail');
    if (!texture || !view) { detail.replaceChildren(node('p', view?.readOnly ? 'Select a texture to preview it and copy its name.' : 'Select a texture to preview, replace, rename or delete it.', 'muted')); return; }
    const snapshotId = view.snapshotId, textureId = texture.id;
    const rows = [{ name: 'Size', value: `${texture.width} × ${texture.height}` }, { name: 'Format', value: texture.format }, { name: 'Mip levels', value: String(texture.mipCount) }, { name: 'Name hash', value: hash(texture.name) }];
    const actions = node('div', undefined, 'copy-row'), edits = node('div', undefined, 'copy-row'), list = node('ul', undefined, 'viewer-notes'), pair = `${luaString(view.dictionary)}, ${luaString(texture.name)}`;
    actions.append(button('Copy name', () => copy(texture.name, 'texture name')), button('Copy dictionary and name', () => copy(pair, 'dictionary and texture name')), button('Copy hash', () => copy(hash(texture.name), 'hash')));
    if (!view.readOnly) {
        edits.append(button('Replace with PNG…', () => vscode.postMessage({ type: 'replace', snapshotId, textureId, options: settings() }), 'Keeps the name and, with automatic settings, the format'),
            button('Rename…', () => vscode.postMessage({ type: 'rename', snapshotId, textureId })), button('Delete', () => vscode.postMessage({ type: 'remove', snapshotId, textureId }), 'Undo brings it back'));
    }
    if (texture.encoding) { edits.append(button('Export as PNG…', () => vscode.postMessage({ type: 'export', snapshotId, textureId }))); }
    list.append(...texture.notes.map((note) => node('li', note)));
    detail.replaceChildren(node('h2', texture.name, 'detail-name'), facts(rows, 'facts compact'), actions, edits, list);
}
function select(texture: AssetTexture | undefined): void {
    selected = texture; state.texture = texture?.name ?? ''; save();
    mipSelect.replaceChildren();
    if (texture) {
        for (let mip = 0; mip < texture.mipCount; mip++) {
            const width = Math.max(1, texture.width >> mip), height = Math.max(1, texture.height >> mip), option = node('option', `${mip} · ${width} × ${height}`);
            option.value = String(mip); option.disabled = width * height > 1024 * 1024; mipSelect.append(option);
        }
        mipSelect.value = String(texture.previewMip ?? 0);
    }
    renderDetail(); list.render(filtered()); requestPixels();
}
const list = pager<AssetTexture>({ body: 'rows', previous: 'previous', next: 'next', range: 'range' }, 100, 'textures', (texture) => {
    const line = node('tr');
    line.append(node('td', texture.name), node('td', `${texture.width} × ${texture.height}`, 'num'), node('td', texture.format, 'muted'), node('td', String(texture.mipCount), 'num'));
    return line;
}, (texture) => texture === selected, (texture) => select(texture));
function summary(data: TextureView): string {
    if (data.kind === 'dds') { return ['A single DDS texture.', ...data.notes].join(' '); }
    const megabytes = data.memory / 1048576;
    return [`${data.textures.length.toLocaleString()} texture${data.textures.length === 1 ? '' : 's'} in dictionary ${data.dictionary}, ${megabytes.toFixed(1)} MiB of texture memory.`,
        megabytes > 16 ? 'FiveM reports dictionaries above 16 MiB as oversized assets: use smaller textures or split them over two dictionaries.' : '', ...data.notes,
        data.readOnly ? `It is shown read-only because ${data.readOnly}.` : ''].filter(Boolean).join(' ');
}
window.addEventListener('message', (event: MessageEvent<TextureMessage>) => {
    if (!fromHost(event)) { return; }
    const message = event.data;
    if (message?.type === 'loading') { element('loading').hidden = false; element('error').hidden = true; status('Reading textures…'); }
    else if (message?.type === 'state') {
        view = message.data;
        if (state.path !== view.path) { state.query = ''; state.texture = ''; }
        state.path = view.path; save();
        element('loading').hidden = true; element('error').hidden = true; element('textures').hidden = false;
        element('title').textContent = view.title; element('path').textContent = view.path; element<HTMLInputElement>('search').value = state.query;
        element('copy-dictionary').hidden = view.kind !== 'ytd'; element('add').hidden = element('import-tools').hidden = view.readOnly !== undefined;
        element('export-all').hidden = view.kind !== 'ytd' || view.textures.length === 0; element('unsaved').hidden = !view.dirty;
        element('summary').textContent = summary(view);
        const wanted = view.focus ?? state.texture;
        list.reset(); select(view.textures.find((texture) => texture.name === wanted) ?? view.textures[0]);
        status(view.readOnly ? 'Read-only view of a local file.' : view.dirty ? 'Unsaved changes.' : 'Replace, add or delete textures from PNG files. Nothing is written until you save.');
        vscode.postMessage({ type: 'loaded', snapshotId: view.snapshotId });
    } else if (message?.type === 'error') {
        view = undefined; element('loading').hidden = true; element('textures').hidden = true; element('error').hidden = false; element('error').textContent = message.message;
        element('add').hidden = element('export-all').hidden = element('unsaved').hidden = true;
        status('This file could not be read as textures.');
    } else if (message?.type === 'status') { status(message.message); }
    else if (message?.type === 'pixels' && message.requestId === request && selected && view) {
        try {
            const { width, height, encoding, data, textureId } = message.data;
            pixels = { width, height, data: decodeAssetTexture(data, width, height, encoding) };
            draw();
            vscode.postMessage({ type: 'drawn', snapshotId: view.snapshotId, textureId, width, height });
        } catch (reason) { stageMessage(reason instanceof Error ? reason.message : String(reason)); }
    } else if (message?.type === 'noPixels' && message.requestId === request) { stageMessage(message.message); }
});
compressionSelect.value = state.compression; mipmapSelect.value = state.mipmaps;
if (!compressionSelect.value) { compressionSelect.value = 'auto'; }
if (!mipmapSelect.value) { mipmapSelect.value = 'auto'; }
compressionSelect.addEventListener('change', () => { state.compression = compressionSelect.value; save(); }); mipmapSelect.addEventListener('change', () => { state.mipmaps = mipmapSelect.value; save(); });
mipSelect.addEventListener('change', requestPixels); channelSelect.addEventListener('change', draw);
element('zoom').addEventListener('change', () => { stage.dataset.zoom = element<HTMLSelectElement>('zoom').value; });
element('search').addEventListener('input', () => { state.query = element<HTMLInputElement>('search').value.slice(0, 256); save(); list.reset(); list.render(filtered()); });
element('copy-dictionary').addEventListener('click', () => { if (view) { copy(view.dictionary, 'dictionary name'); } });
element('add').addEventListener('click', () => { if (view) { vscode.postMessage({ type: 'add', snapshotId: view.snapshotId, options: settings() }); } });
element('export-all').addEventListener('click', () => { if (view) { vscode.postMessage({ type: 'exportAll', snapshotId: view.snapshotId }); } });
element('reload').addEventListener('click', () => vscode.postMessage({ type: 'reload' }));
vscode.postMessage({ type: 'ready' });
