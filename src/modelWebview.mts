/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { decodeAssetTexture } from './assetTextureDecode.mjs';
import { luaCoords } from './mapLua.js';
import { materialColour, ModelRenderer, type Shading } from './modelRenderer.mjs';
import type { ModelAction, ModelDrawableView, ModelMessage, ModelView } from './modelTypes.js';
import { button, element, fromHost, node, record } from './viewerDom.mjs';

declare function acquireVsCodeApi(): { postMessage(message: ModelAction): void; getState(): unknown; setState(value: unknown): void };
const vscode = acquireVsCodeApi();
const saved = vscode.getState(), prior = record(saved) ? saved : {};
const SHADINGS: readonly Shading[] = ['textured', 'solid', 'materials', 'normals'];
const state = {
    shading: (SHADINGS.includes(prior.shading as Shading) ? prior.shading : 'textured') as Shading,
    wireframe: prior.wireframe === true, grid: prior.grid !== false, box: prior.box === true,
    path: typeof prior.path === 'string' ? prior.path.slice(0, 4096) : '', drawable: typeof prior.drawable === 'number' ? prior.drawable : 0,
};
let view: ModelView | undefined, renderer: ModelRenderer | undefined, sequence = 0, meshRequest = 0, textureRequest = 0, lod = 0;
const found = new Map<string, string>();
let missing: Set<string> | undefined;
const canvas = element<HTMLCanvasElement>('scene');
function save(): void { vscode.setState({ ...state }); }
function status(message: string): void { element('status').textContent = message; }
function stageMessage(message: string): void { element('stage-message').textContent = message; element('stage-message').hidden = !message; }
function copy(text: string, label: string): void { vscode.postMessage({ type: 'copy', text, label }); }
function fixed(value: number, digits = 3): string { return Number.isFinite(value) ? value.toFixed(digits) : '0'; }
function drawable(): ModelDrawableView | undefined { return view?.drawables[state.drawable]; }
function hash(name: string): number {
    let value = 0;
    for (const char of name.toLowerCase()) { value = (value + (char.charCodeAt(0) & 0xff)) >>> 0; value = (value + (value << 10)) >>> 0; value ^= value >>> 6; }
    value = (value + (value << 3)) >>> 0; value ^= value >>> 11; return (value + (value << 15)) >>> 0;
}
function options(): void {
    if (!renderer) { return; }
    renderer.options = { shading: view?.kind === 'ybn' && state.shading === 'textured' ? 'materials' : state.shading, wireframe: state.wireframe, grid: state.grid, box: state.box };
    renderer.invalidate();
}
function renderMaterials(): void {
    const current = drawable();
    if (!view || !current) { return; }
    const rows = view.collision ? view.collision.materials.map((material) => ({ index: material.type, name: `Surface type ${material.type}`, where: `${material.triangles.toLocaleString()} triangles` }))
        : current.materials.map((material, index) => {
            const diffuse = material.diffuse?.toLowerCase(), source = diffuse === undefined ? undefined : found.get(diffuse);
            const texture = !material.diffuse ? 'no diffuse texture' : source ? `${material.diffuse} · ${source === 'embedded' ? 'embedded in this file' : source}`
                : missing?.has(diffuse!) ? `${material.diffuse} · not found in this resource` : `${material.diffuse} · looking…`;
            return { index, name: material.shader, where: texture };
        });
    element('materials-title').textContent = view.collision ? `Surface types (${rows.length})` : `Materials (${rows.length})`;
    element('materials-section').hidden = !rows.length;
    element('materials').replaceChildren(...rows.map((row) => {
        const item = node('li'), swatch = node('span', undefined, 'swatch'), [r, g, b] = materialColour(row.index);
        swatch.style.background = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
        item.append(swatch, node('span', row.name, 'name'), node('span', row.where, 'where')); return item;
    }));
}
function renderDetail(): void {
    const current = drawable();
    if (!view || !current) { return; }
    const size = current.max.map((value, axis) => value - current.min[axis]) as [number, number, number], level = current.lods.find((entry) => entry.level === lod);
    const rows = [{ name: 'Size', value: `${size.map((value) => fixed(value, 2)).join(' × ')} m` }, { name: 'Box min', value: current.min.map((value) => fixed(value)).join(', ') },
        { name: 'Box max', value: current.max.map((value) => fixed(value)).join(', ') }];
    if (level) { rows.push({ name: 'Shown', value: `${level.triangles.toLocaleString()} triangles · ${level.vertices.toLocaleString()} vertices` }); }
    if (view.collision) { rows.push({ name: 'Bounds', value: view.collision.kinds.map((kind) => `${kind.count} ${kind.name.toLowerCase()}`).join(', ') }, { name: 'Polygons', value: view.collision.polygons.toLocaleString() }); }
    else {
        rows.push({ name: 'Detail levels', value: current.lods.map((entry) => `${entry.name} to ${fixed(entry.distance, 0)} m`).join(' · ') || 'none' });
        if (current.embeddedTextures) { rows.push({ name: 'Embedded', value: `${current.embeddedTextures} texture${current.embeddedTextures === 1 ? '' : 's'}` }); }
        if (current.skeleton) { rows.push({ name: 'Skeleton', value: 'yes' }); }
        if (current.lights) { rows.push({ name: 'Lights', value: String(current.lights) }); }
    }
    const name = current.name.replace(/\.#?\w+$/, '');
    element('drawable-name').textContent = name; element('drawable-sub').textContent = `0x${hash(name).toString(16).toUpperCase().padStart(8, '0')} · ${view.kind.toUpperCase()}`;
    element('facts').replaceChildren(...rows.flatMap((row) => [node('dt', row.name), node('dd', row.value)]));
    element('copy').replaceChildren(button('Copy name', () => copy(name, 'name')), button('Copy model', () => copy(/^[A-Za-z_]\w*$/.test(name) ? `\`${name}\`` : `0x${hash(name).toString(16).toUpperCase().padStart(8, '0')}`, 'model')),
        button('Copy size', () => copy(luaCoords(size, 'vec', 3), 'size')), button('Copy box', () => copy(`${luaCoords(current.min, 'vec', 3)}, ${luaCoords(current.max, 'vec', 3)}`, 'bounding box corners')));
    element('notes').replaceChildren(...[...view.notes, ...current.notes].map((note) => node('li', note)));
    renderMaterials();
}
function requestMesh(): void {
    const current = drawable();
    if (!view || !current) { return; }
    if (!current.lods.length) { stageMessage('This drawable has no geometry to show.'); return; }
    if (!current.lods.some((entry) => entry.level === lod)) { lod = current.lods[0].level; }
    meshRequest = ++sequence; found.clear(); missing = undefined;
    stageMessage('Building mesh…'); status('Building mesh…');
    element<HTMLSelectElement>('lod').replaceChildren(...current.lods.map((entry) => { const option = node('option', `${entry.name} · ${entry.triangles.toLocaleString()} triangles`); option.value = String(entry.level); return option; }));
    element<HTMLSelectElement>('lod').value = String(lod); element('lod').hidden = current.lods.length < 2;
    renderDetail();
    vscode.postMessage({ type: 'mesh', drawable: current.id, lod, requestId: meshRequest });
}
window.addEventListener('message', (event: MessageEvent<ModelMessage>) => {
    if (!fromHost(event)) { return; }
    const message = event.data;
    if (message?.type === 'loading') { element('loading').hidden = false; element('error').hidden = true; status('Reading model…'); }
    else if (message?.type === 'state') {
        const same = state.path === message.data.path;
        view = message.data; state.path = view.path;
        if (!same || !view.drawables[state.drawable]) { state.drawable = Math.max(0, view.drawables.findIndex((entry) => entry.lods.length)); }
        element('loading').hidden = true; element('error').hidden = true; element('stage').hidden = false;
        element('title').textContent = view.title; element('path').textContent = view.path;
        const select = element<HTMLSelectElement>('drawable');
        select.replaceChildren(...view.drawables.map((entry) => { const option = node('option', entry.name); option.value = String(entry.id); return option; }));
        select.hidden = view.drawables.length < 2; select.value = String(state.drawable);
        const shading = element<HTMLSelectElement>('shading');
        shading.options[0].hidden = view.kind === 'ybn'; shading.value = view.kind === 'ybn' && state.shading === 'textured' ? 'materials' : state.shading;
        try { renderer ??= new ModelRenderer(canvas); renderer.clearTextures(); }
        catch (reason) { stageMessage(reason instanceof Error ? reason.message : String(reason)); }
        lod = drawable()?.lods[0]?.level ?? 0;
        vscode.postMessage({ type: 'loaded', snapshotId: view.snapshotId });
        if (renderer) { requestMesh(); } else { renderDetail(); }
        save();
    } else if (message?.type === 'error') {
        view = undefined; element('loading').hidden = true; element('stage').hidden = true; element('error').hidden = false; element('error').textContent = message.message;
        status('This file could not be previewed.');
    } else if (message?.type === 'status') { status(message.message); }
    else if (message?.type === 'mesh' && message.requestId === meshRequest && renderer && view) {
        const current = drawable();
        if (!current) { return; }
        renderer.setMesh(message.data.buffer, message.data.meshes, current.min, current.max, current.materials);
        if (!framedAlready(current)) { renderer.resetView(); }
        options(); stageMessage(renderer.triangles ? '' : 'No geometry of this detail level can be shown.');
        if (message.data.notes.length) { element('notes').append(...message.data.notes.map((note) => node('li', note))); }
        status(`${renderer.triangles.toLocaleString()} triangles shown.`);
        vscode.postMessage({ type: 'rendered', snapshotId: view.snapshotId, drawable: current.id, triangles: renderer.triangles });
        if (current.materials.some((material) => material.diffuse)) { textureRequest = ++sequence; vscode.postMessage({ type: 'textures', drawable: current.id, requestId: textureRequest }); }
    } else if (message?.type === 'meshError' && message.requestId === meshRequest) { stageMessage(message.message); status(message.message); }
    else if (message?.type === 'texture' && message.requestId === textureRequest && renderer) {
        try {
            const { name, source, width, height, encoding, data } = message.data;
            renderer.setTexture(name, width, height, decodeAssetTexture(data, width, height, encoding));
            found.set(name.toLowerCase(), source); renderMaterials();
        } catch (reason) { status(`Texture ${message.data.name} was not decoded: ${reason instanceof Error ? reason.message : String(reason)}`); }
    } else if (message?.type === 'texturesDone' && message.requestId === textureRequest) { missing = new Set(message.missing); renderMaterials(); }
});
let framed = '';
/** True when the camera already frames this drawable, so changing detail level keeps the view. */
function framedAlready(current: ModelDrawableView): boolean { const key = `${view?.path}:${current.id}`; const result = framed === key; framed = key; return result; }
let drag: { x: number; y: number; pan: boolean } | undefined;
canvas.addEventListener('pointerdown', (event) => { drag = { x: event.clientX, y: event.clientY, pan: event.shiftKey || event.button !== 0 }; canvas.setPointerCapture(event.pointerId); });
canvas.addEventListener('pointermove', (event) => {
    if (!drag || !renderer) { return; }
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    drag.x = event.clientX; drag.y = event.clientY;
    if (drag.pan) { renderer.pan(dx, dy); } else { renderer.orbit(dx, dy); }
});
canvas.addEventListener('pointerup', () => { drag = undefined; }); canvas.addEventListener('pointercancel', () => { drag = undefined; });
canvas.addEventListener('contextmenu', (event) => event.preventDefault());
canvas.addEventListener('wheel', (event) => { event.preventDefault(); renderer?.zoom(event.deltaY < 0 ? 1 / 1.15 : 1.15); }, { passive: false });
canvas.addEventListener('keydown', (event) => {
    if (!renderer) { return; }
    if (event.key === 'ArrowLeft') { renderer.orbit(-12, 0); } else if (event.key === 'ArrowRight') { renderer.orbit(12, 0); } else if (event.key === 'ArrowUp') { renderer.orbit(0, 12); }
    else if (event.key === 'ArrowDown') { renderer.orbit(0, -12); } else if (event.key === '+' || event.key === '=') { renderer.zoom(1 / 1.15); } else if (event.key === '-') { renderer.zoom(1.15); }
    else if (event.key === '0') { renderer.resetView(); } else { return; }
    event.preventDefault();
});
new ResizeObserver(() => renderer?.invalidate()).observe(canvas);
new MutationObserver(() => renderer?.invalidate()).observe(document.body, { attributes: true, attributeFilter: ['class'] });
const shadingSelect = element<HTMLSelectElement>('shading');
shadingSelect.value = state.shading;
shadingSelect.addEventListener('change', () => { state.shading = SHADINGS.includes(shadingSelect.value as Shading) ? shadingSelect.value as Shading : 'textured'; save(); options(); });
for (const key of ['wireframe', 'grid', 'box'] as const) {
    const box = element<HTMLInputElement>(key);
    box.checked = state[key];
    box.addEventListener('change', () => { state[key] = box.checked; save(); options(); });
}
element('drawable').addEventListener('change', () => { state.drawable = Number(element<HTMLSelectElement>('drawable').value) || 0; lod = drawable()?.lods[0]?.level ?? 0; save(); requestMesh(); });
element('lod').addEventListener('change', () => { lod = Number(element<HTMLSelectElement>('lod').value) || 0; requestMesh(); });
element('reset').addEventListener('click', () => renderer?.resetView());
element('reload').addEventListener('click', () => vscode.postMessage({ type: 'reload' }));
vscode.postMessage({ type: 'ready' });
