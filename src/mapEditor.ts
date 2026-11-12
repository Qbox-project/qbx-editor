import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { copyFromWebview, message as errorText, readBounded, record, watchFile } from './assetFiles';
import { MAX_ASSET_BYTES } from './assetFormats';
import { assetHash } from './assetInventory';
import { loadNameLists } from './assetNames';
import { scanAssetScope, scopeNames, type AssetScope, type ScopeFile } from './assetScope';
import { parseBounds } from './boundsFormat';
import { appendTriangles, MAX_SURFACE_TRIANGLES, SurfaceIndex } from './mapCollision';
import { isXml, readMapFile } from './mapFormat';
import { getMapHtml } from './mapHtml';
import { add, rotate, type Vec3 } from './mapMath';
import type { MapAction, MapMessage, MapView } from './mapTypes';
import { buildMapView, type LinkedMapFile } from './mapView';
import type { MetaFile } from './metaFormat';
import type { LodMesh } from './modelFormat';
import { metaToXml } from './metaXml';

export const MAP_VIEW_TYPE = 'qbxLua.mapViewer';
const MAX_LINKED_FILES = 200, MAX_LINKED_BYTES = 16 * 1024 * 1024, MAX_COLLISION_FILES = 48, SURFACE_MARGIN = 0.5;
const viewerRequests = new Set<string>();


/** Opens the viewer for a map file even when XML map files are set to open as text. */
export async function openMapViewer(uri: vscode.Uri): Promise<void> {
    viewerRequests.add(uri.toString());
    await vscode.commands.executeCommand('vscode.openWith', uri, MAP_VIEW_TYPE);
}

export class MapEditor implements vscode.Disposable {
    private generation = 0;
    private disposed = false;
    private ready = false;
    private handOff = false;
    private snapshot: MapMessage = { type: 'loading' };
    private meta: MetaFile | undefined;
    private names = new Map<number, string>();
    private xml = false;
    private scope: AssetScope | undefined;
    private readonly surfaces = new Map<number, SurfaceIndex>();
    private readonly related = new Map<string, vscode.Uri>();
    private readonly subscriptions: vscode.Disposable[] = [];
    private readonly loaded = new vscode.EventEmitter<MapView>();
    readonly onDidLoad = this.loaded.event;
    view: MapView | undefined;

    constructor(extensionUri: vscode.Uri, readonly uri: vscode.Uri, private readonly panel: vscode.WebviewPanel) {
        panel.webview.options = { enableScripts: true, enableCommandUris: false, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')] };
        panel.webview.html = getMapHtml(panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'mapWebview.js')).toString(), randomBytes(16).toString('hex'));
        this.subscriptions.push(watchFile(uri, () => void this.load()), this.loaded,
            vscode.workspace.onDidChangeConfiguration((event) => { if (event.affectsConfiguration('qbxLua.assets.nameLists')) { void this.load(); } }),
            panel.webview.onDidReceiveMessage((message: unknown) => { void this.handle(message).catch((error) => this.post({ type: 'status', message: errorText(error) })); }),
            panel.onDidDispose(() => this.dispose()));
    }
    /** Loads the file, unless it is XML that the settings send to the text editor; resolves false when it handed the file over. */
    async open(forceViewer = false): Promise<boolean> {
        const forced = viewerRequests.delete(this.uri.toString()) || forceViewer;
        const bytes = await readBounded(this.uri, MAX_ASSET_BYTES).catch(() => undefined);
        if (bytes && !forced && isXml(bytes) && vscode.workspace.getConfiguration('qbxLua', this.uri).get<string>('mapViewer.xmlFiles', 'text') === 'text') {
            // The swap waits for the page to load: closing this editor while the workbench is still opening it fails there.
            this.handOff = true;
            return false;
        }
        await this.load(bytes);
        return true;
    }
    private current(generation: number): boolean { return !this.disposed && this.generation === generation; }
    private post(message: MapMessage): void {
        if (message.type !== 'status' && message.type !== 'surfaces') { this.snapshot = message; }
        if (!this.disposed && this.ready) { void this.panel.webview.postMessage(message); }
    }
    private async linked(self: string, isCurrent: () => boolean): Promise<LinkedMapFile[]> {
        const files: LinkedMapFile[] = [];
        if (this.uri.scheme !== 'file') { return files; }
        const scope = await scanAssetScope(this.uri.fsPath, isCurrent);
        this.scope = scope; this.names = scopeNames(scope);
        const candidates = scope.files.filter((file) => ['.ymap', '.ytyp', '.ymap.xml', '.ytyp.xml'].includes(file.extension) && path.resolve(file.path) !== self).slice(0, MAX_LINKED_FILES);
        for (const candidate of candidates) {
            if (!isCurrent()) { break; }
            const document = await fs.stat(candidate.path).then((stat) => stat.size > MAX_LINKED_BYTES ? undefined : fs.readFile(candidate.path))
                .then((bytes) => bytes && readMapFile(bytes)).then((parsed) => parsed?.document, () => undefined);
            if (!document) { continue; }
            const id = String(files.length);
            files.push({ id, label: candidate.relative, document });
            this.related.set(id, vscode.Uri.file(candidate.path));
        }
        return files;
    }
    /**
     * Indexes the collision of each interior so picked points get real surface heights. A collision file belongs to the
     * archetype it is named after: the interior itself, or an entity placed inside it.
     */
    private async collision(view: MapView, isCurrent: () => boolean): Promise<void> {
        const files = new Map<number, ScopeFile>(), meshes = new Map<string, LodMesh | undefined>();
        for (const file of this.scope?.files ?? []) { if (file.extension === '.ybn' && /^[\x21-\x7e]+$/.test(file.stem) && !files.has(assetHash(file.stem))) { files.set(assetHash(file.stem), file); } }
        const mesh = async (file: ScopeFile): Promise<LodMesh | undefined> => {
            if (!meshes.has(file.path) && meshes.size < MAX_COLLISION_FILES) {
                meshes.set(file.path, await fs.stat(file.path).then((stat) => stat.size > MAX_ASSET_BYTES ? undefined : fs.readFile(file.path)).then((bytes) => bytes && parseBounds(bytes)).then((bounds) => bounds?.mesh, () => undefined));
            }
            return meshes.get(file.path);
        };
        for (const [index, interior] of view.interiors.entries()) {
            const triangles: number[] = [], used: string[] = [];
            const include = async (file: ScopeFile | undefined, transform: (point: Vec3) => Vec3): Promise<void> => {
                const part = file && triangles.length < MAX_SURFACE_TRIANGLES * 9 ? await mesh(file) : undefined;
                if (file && part && isCurrent()) { appendTriangles(part, transform, triangles); if (!used.includes(file.relative)) { used.push(file.relative); } }
            };
            await include(files.get(interior.hash), (point) => add(interior.position, rotate(interior.rotation, point)));
            for (const row of view.entities) {
                const group = view.groups[row.group];
                if (group?.interior !== index || !group.enabled || row.hash === interior.hash) { continue; }
                await include(files.get(row.hash), (point) => add(row.position, rotate(row.rotation, [point[0] * row.scale[0], point[1] * row.scale[0], point[2] * row.scale[1]])));
            }
            if (!triangles.length || !isCurrent()) { continue; }
            const surface = new SurfaceIndex(Float32Array.from(triangles));
            this.surfaces.set(index, surface);
            interior.collision = { files: used, triangles: surface.count };
            for (const room of interior.rooms) {
                const heights = surface.heights(room.center[0], room.center[1]).filter((height) => height >= room.floor - SURFACE_MARGIN && height <= room.ceiling - SURFACE_MARGIN);
                if (heights.length) { room.surface = heights[heights.length - 1]; }
            }
        }
    }
    async load(bytes?: Buffer): Promise<void> {
        const generation = ++this.generation;
        this.post({ type: 'loading' });
        try {
            const parsed = await readMapFile(bytes ?? await readBounded(this.uri, MAX_ASSET_BYTES));
            if (!this.current(generation)) { return; }
            this.related.clear(); this.surfaces.clear(); this.scope = undefined;
            this.names = new Map();
            const notes: string[] = [];
            const files = await this.linked(path.resolve(this.uri.fsPath), () => this.current(generation)).catch((error) => {
                notes.push(`Related files were not read: ${errorText(error)}`);
                return [] as LinkedMapFile[];
            });
            if (!this.current(generation)) { return; }
            const lists = await loadNameLists(vscode.workspace.getConfiguration('qbxLua').get<string[]>('assets.nameLists', []));
            if (!this.current(generation)) { return; }
            notes.push(...lists.notes);
            for (const [hash, name] of lists.names) { if (!this.names.has(hash)) { this.names.set(hash, name); } }
            const view: MapView = { snapshotId: randomBytes(16).toString('hex'),
                ...buildMapView(parsed.document, path.posix.basename(this.uri.path), this.uri.scheme === 'file' ? this.uri.fsPath : this.uri.toString(true), { names: this.names, files }) };
            view.notes.unshift(...notes);
            await this.collision(view, () => this.current(generation)).catch((error) => view.notes.push(`Collision was not read: ${errorText(error)}`));
            if (!this.current(generation)) { return; }
            this.meta = parsed.meta; this.xml = parsed.document.source === 'xml'; this.view = view;
            this.post({ type: 'state', data: view });
        } catch (error) {
            if (this.current(generation)) { this.view = undefined; this.meta = undefined; this.post({ type: 'error', message: errorText(error) }); }
        }
    }
    private async handle(value: unknown): Promise<void> {
        if (this.disposed || !record(value) || typeof value.type !== 'string') { return; }
        const message = value as MapAction;
        if (message.type === 'ready' && this.handOff) {
            this.handOff = false;
            await vscode.commands.executeCommand('vscode.openWith', this.uri, 'default', this.panel.viewColumn);
            this.panel.dispose();
        } else if (message.type === 'ready') { this.ready = true; this.post(this.snapshot); }
        else if (message.type === 'loaded') { if (this.view && message.snapshotId === this.view.snapshotId) { this.loaded.fire(this.view); } }
        else if (message.type === 'reload') { await this.load(); }
        else if (message.type === 'copy') {
            const status = await copyFromWebview(message.text, message.label);
            if (status) { this.post({ type: 'status', message: status }); }
        } else if (message.type === 'surfaces') {
            const { requestId, interior, x, y, low, high } = message;
            if (![requestId, interior, x, y, low, high].every((part) => typeof part === 'number' && Number.isFinite(part))) { return; }
            this.post({ type: 'surfaces', requestId, heights: (this.surfaces.get(interior)?.heights(x, y) ?? []).filter((height) => height >= low && height <= high).slice(0, 32) });
        } else if (message.type === 'openText' || (message.type === 'exportXml' && this.xml)) {
            await vscode.commands.executeCommand('vscode.openWith', this.uri, 'default', vscode.ViewColumn.Beside);
        } else if (message.type === 'exportXml' && this.meta) {
            const names = this.names, content = metaToXml(this.meta, (hash) => names.get(hash));
            if (this.disposed) { return; }
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'xml', content }), { viewColumn: vscode.ViewColumn.Beside, preview: false });
        } else if (message.type === 'openRelated') {
            const uri = typeof message.id === 'string' ? this.related.get(message.id) : undefined;
            if (uri) { await openMapViewer(uri); }
        }
    }
    dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true; ++this.generation;
        this.subscriptions.forEach((subscription) => subscription.dispose());
    }
}
