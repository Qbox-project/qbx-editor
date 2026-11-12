import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { copyFromWebview, message as errorText, readBounded, record, watchFile } from './assetFiles';
import { MAX_ASSET_BYTES, parseYtd, textureLevelSize, type TextureData } from './assetFormats';
import { assetHash } from './assetInventory';
import { scanAssetScope, type AssetScope } from './assetScope';
import { parseBounds, type BoundsFile } from './boundsFormat';
import { readMapFile } from './mapFormat';
import { buildLodMesh, LOD_NAMES, parseModel, type ModelDrawable, type ModelFile } from './modelFormat';
import { getModelHtml } from './modelHtml';
import type { ModelAction, ModelMessage, ModelTexture, ModelView } from './modelTypes';

export const MODEL_VIEW_TYPE = 'qbxLua.modelViewer';
const MAX_TEXTURE_FILES = 16, MAX_TEXTURE_PIXELS = 512, MAX_TEXTURES = 96, MAX_ARCHETYPE_FILES = 64;
interface TextureSource { label: string; bytes: Buffer; textures: readonly TextureData[] }

function count(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function previewMip(texture: TextureData): number {
    for (let mip = 0; mip < texture.mipCount; mip++) { if (Math.max(texture.width >> mip, texture.height >> mip, 1) <= MAX_TEXTURE_PIXELS) { return mip; } }
    return texture.mipCount - 1;
}
export function texturePreview(source: TextureSource, texture: TextureData): Omit<ModelTexture, 'name' | 'source'> | undefined {
    if (!texture.encoding) { return undefined; }
    const mip = previewMip(texture), width = Math.max(1, texture.width >> mip), height = Math.max(1, texture.height >> mip);
    let offset = texture.offset;
    for (let level = 0; level < mip; level++) { offset += textureLevelSize(Math.max(1, texture.width >> level), Math.max(1, texture.height >> level), texture.encoding); }
    const length = textureLevelSize(width, height, texture.encoding);
    if (width * height > 1024 * 1024 || offset + length > source.bytes.length) { return undefined; }
    return { width, height, encoding: texture.encoding, data: new Uint8Array(source.bytes.subarray(offset, offset + length)) };
}

export class ModelEditor implements vscode.Disposable {
    private generation = 0;
    private textureRequest = 0;
    private disposed = false;
    private ready = false;
    private snapshot: ModelMessage = { type: 'loading' };
    private model: ModelFile | undefined;
    private bounds: BoundsFile | undefined;
    private scope: AssetScope | undefined;
    private readonly subscriptions: vscode.Disposable[] = [];
    private readonly loaded = new vscode.EventEmitter<ModelView>();
    private readonly rendered = new vscode.EventEmitter<{ drawable: number; triangles: number }>();
    readonly onDidLoad = this.loaded.event;
    readonly onDidRender = this.rendered.event;
    view: ModelView | undefined;

    constructor(extensionUri: vscode.Uri, readonly uri: vscode.Uri, private readonly panel: vscode.WebviewPanel) {
        panel.webview.options = { enableScripts: true, enableCommandUris: false, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')] };
        panel.webview.html = getModelHtml(panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'modelWebview.js')).toString(), randomBytes(16).toString('hex'));
        this.subscriptions.push(watchFile(uri, () => void this.load()), this.loaded, this.rendered,
            panel.webview.onDidReceiveMessage((value: unknown) => { void this.handle(value).catch((error) => this.post({ type: 'status', message: errorText(error) })); }),
            panel.onDidDispose(() => this.dispose()));
    }
    private current(generation: number): boolean { return !this.disposed && this.generation === generation; }
    private post(value: ModelMessage): void {
        if (value.type === 'loading' || value.type === 'state' || value.type === 'error') { this.snapshot = value; }
        if (!this.disposed && this.ready) { void this.panel.webview.postMessage(value); }
    }
    async load(): Promise<void> {
        const generation = ++this.generation;
        this.post({ type: 'loading' });
        try {
            const bytes = await readBounded(this.uri, MAX_ASSET_BYTES), extension = path.posix.extname(this.uri.path).toLowerCase();
            if (!this.current(generation)) { return; }
            const view: ModelView = { snapshotId: randomBytes(16).toString('hex'), kind: extension.slice(1) as ModelView['kind'], title: path.posix.basename(this.uri.path),
                path: this.uri.scheme === 'file' ? this.uri.fsPath : this.uri.toString(true), drawables: [], notes: [] };
            let model: ModelFile | undefined, bounds: BoundsFile | undefined;
            if (extension === '.ybn') {
                bounds = await parseBounds(bytes);
                const { summary } = bounds;
                view.collision = { kinds: summary.kinds, polygons: summary.polygons, triangles: summary.triangles, vertices: summary.vertices, materials: summary.materials };
                view.drawables.push({ id: 0, name: view.title.replace(/\.ybn$/i, ''), min: summary.min, max: summary.max, center: [0, 1, 2].map((axis) => (summary.min[axis] + summary.max[axis]) / 2) as [number, number, number],
                    radius: Math.hypot(...summary.max.map((value, axis) => value - summary.min[axis])) / 2,
                    lods: [{ level: 0, name: 'Collision', distance: 0, vertices: summary.vertices, triangles: summary.triangles, geometries: bounds.mesh.meshes.length }],
                    materials: [], embeddedTextures: 0, skeleton: false, lights: 0, notes: bounds.mesh.notes });
            } else {
                model = await parseModel(bytes, extension);
                view.notes.push(...model.notes);
                model.drawables.forEach((drawable, id) => view.drawables.push({ id, name: drawable.name || view.title, min: drawable.min, max: drawable.max, center: drawable.center, radius: drawable.radius,
                    lods: drawable.lods.map((lod) => ({ level: lod.level, name: LOD_NAMES[lod.level], distance: lod.distance, vertices: lod.vertices, triangles: lod.triangles, geometries: lod.geometries.length })),
                    materials: drawable.materials.map((material) => ({ shader: material.shader, diffuse: material.diffuse, textures: material.textures.map((use) => use.name) })),
                    embeddedTextures: drawable.textures.length, skeleton: drawable.skeleton, lights: drawable.lights, notes: drawable.notes }));
                if (!model.drawables.some((drawable) => drawable.lods.length)) { view.notes.push('This file contains no renderable geometry.'); }
            }
            if (!this.current(generation)) { return; }
            this.model = model; this.bounds = bounds; this.scope = undefined; this.view = view;
            this.post({ type: 'state', data: view });
        } catch (error) {
            if (this.current(generation)) { this.model = undefined; this.bounds = undefined; this.view = undefined; this.post({ type: 'error', message: errorText(error) }); }
        }
    }
    private mesh(drawable: number, lod: number, requestId: number): void {
        try {
            if (this.bounds && drawable === 0) {
                const { buffer, meshes, notes } = this.bounds.mesh;
                this.post({ type: 'mesh', requestId, data: { drawable, lod: 0, buffer: new Uint8Array(buffer), meshes, notes } });
                return;
            }
            const source = this.model?.drawables[drawable], level = source?.lods.find((entry) => entry.level === lod);
            if (!this.model || !level) { throw new Error('That detail level is not part of this file.'); }
            const { buffer, meshes, notes } = buildLodMesh(this.model, level);
            this.post({ type: 'mesh', requestId, data: { drawable, lod, buffer: new Uint8Array(buffer), meshes, notes } });
        } catch (error) { this.post({ type: 'meshError', requestId, message: errorText(error) }); }
    }
    /** Texture dictionary files to try, most likely first: the dictionary the archetype names, then the model's namesake, then its folder. */
    private async candidates(drawable: ModelDrawable, isCurrent: () => boolean): Promise<{ path: string; label: string }[]> {
        if (this.uri.scheme !== 'file') { return []; }
        this.scope ??= await scanAssetScope(this.uri.fsPath, isCurrent);
        const scope = this.scope, stem = path.basename(this.uri.fsPath, path.extname(this.uri.fsPath)).toLowerCase(), folder = path.dirname(this.uri.fsPath);
        const targets = new Set([assetHash(stem), ...(/^[\x21-\x7e]+$/.test(drawable.name) ? [assetHash(drawable.name.replace(/\.#?\w+$/, ''))] : [])]);
        const wanted = new Set<number>();
        for (const file of scope.files.filter((entry) => entry.extension === '.ytyp' || entry.extension === '.ytyp.xml').slice(0, MAX_ARCHETYPE_FILES)) {
            if (!isCurrent()) { return []; }
            const types = await fs.readFile(file.path).then(readMapFile).then((parsed) => parsed.document, () => undefined);
            if (types?.kind !== 'ytyp') { continue; }
            for (const archetype of types.archetypes) { if (targets.has(archetype.name.hash) && archetype.textureDictionary.hash) { wanted.add(archetype.textureDictionary.hash); } }
        }
        const rank = (file: { path: string; stem: string }): number => {
            const hash = /^[\x21-\x7e]+$/.test(file.stem) ? assetHash(file.stem) : -1;
            return wanted.has(hash) ? 0 : targets.has(hash) ? 1 : path.dirname(file.path) === folder ? 2 : 3;
        };
        return scope.files.filter((entry) => entry.extension === '.ytd').sort((a, b) => rank(a) - rank(b) || a.relative.localeCompare(b.relative)).slice(0, MAX_TEXTURE_FILES)
            .map((entry) => ({ path: entry.path, label: entry.relative }));
    }
    private async textures(drawable: number, requestId: number): Promise<void> {
        const generation = this.generation, request = ++this.textureRequest, source = this.model?.drawables[drawable];
        const isCurrent = (): boolean => this.current(generation) && this.textureRequest === request;
        if (!this.model || !source) { return; }
        const missing = new Set(source.materials.map((material) => material.diffuse?.toLowerCase()).filter((name): name is string => !!name).slice(0, MAX_TEXTURES));
        const send = (from: TextureSource): void => {
            for (const texture of from.textures) {
                const name = texture.name.toLowerCase();
                if (!missing.has(name)) { continue; }
                const preview = texturePreview(from, texture);
                if (preview) { missing.delete(name); this.post({ type: 'texture', requestId, data: { name, source: from.label, ...preview } }); }
            }
        };
        send({ label: 'embedded', bytes: this.model.pages.bytes, textures: source.textures });
        if (missing.size) {
            for (const candidate of await this.candidates(source, isCurrent).catch(() => [])) {
                if (!missing.size || !isCurrent()) { break; }
                const file = await fs.stat(candidate.path).then((stat) => stat.size > MAX_ASSET_BYTES ? undefined : fs.readFile(candidate.path)).then((bytes) => bytes && parseYtd(bytes), () => undefined);
                if (file && isCurrent()) { send({ label: candidate.label, bytes: file.bytes, textures: file.textures }); }
            }
        }
        if (isCurrent()) { this.post({ type: 'texturesDone', requestId, missing: [...missing] }); }
    }
    private async handle(value: unknown): Promise<void> {
        if (this.disposed || !record(value) || typeof value.type !== 'string') { return; }
        const action = value as ModelAction;
        if (action.type === 'ready') { this.ready = true; this.post(this.snapshot); }
        else if (action.type === 'loaded') { if (this.view && action.snapshotId === this.view.snapshotId) { this.loaded.fire(this.view); } }
        else if (action.type === 'rendered') { if (this.view && action.snapshotId === this.view.snapshotId && count(action.drawable) && count(action.triangles)) { this.rendered.fire({ drawable: action.drawable, triangles: action.triangles }); } }
        else if (action.type === 'reload') { await this.load(); }
        else if (action.type === 'mesh') { if (count(action.drawable) && count(action.lod) && count(action.requestId)) { this.mesh(action.drawable, action.lod, action.requestId); } }
        else if (action.type === 'textures') { if (count(action.drawable) && count(action.requestId)) { await this.textures(action.drawable, action.requestId); } }
        else if (action.type === 'copy') { const status = await copyFromWebview(action.text, action.label); if (status) { this.post({ type: 'status', message: status }); } }
    }
    dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true; ++this.generation;
        this.model = undefined; this.bounds = undefined;
        this.subscriptions.forEach((subscription) => subscription.dispose());
    }
}
