import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { getAssetHtml } from './assetHtml';
import { inspectResourceHeader, MAX_ASSET_BYTES, parseDds, parseYtd, textureMip, type TextureFile } from './assetFormats';
import { assetContained, declarationTargets, inventoryAssets, readAssetBytes, referenceIdsForAsset, referenceTargets, type AssetInventory, type IndexedAssetReference } from './assetInventory';
import { validResourceFileUri, validResourceLocation } from './resourceDetailsSession';
import { openResourceSource } from './resourceNavigation';
import type { Resource, ResourceIndex } from './resources';
import type { ResourceLocation } from './resourceDetailsTypes';
import type { AssetAction, AssetDetail, AssetEntry, AssetMessage, AssetRequest, AssetView, ResourceAssets } from './assetTypes';

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function text(value: unknown, max = 32768): value is string { return typeof value === 'string' && value.length <= max; }
function count(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
export function validResourceAssets(value: unknown): value is ResourceAssets {
    return record(value) && record(value.resource) && text(value.resource.name) && validResourceFileUri(value.resource.uri)
        && validResourceFileUri(value.resource.manifestUri) && Array.isArray(value.declarations) && value.declarations.length <= 1000
        && value.declarations.every((item: unknown) => record(item) && text(item.kind) && text(item.value)
            && (item.dataType === undefined || text(item.dataType)) && validResourceLocation(item.location))
        && Array.isArray(value.references) && value.references.length <= 2000
        && value.references.every((item: unknown) => record(item) && ['model', 'textureDictionary', 'texture', 'particleAsset', 'audioBank'].includes(item.kind as string)
            && (item.value === undefined || text(item.value)) && (item.hash === undefined || (count(item.hash) && item.hash <= 0xffffffff))
            && (item.dictionary === undefined || text(item.dictionary)) && validResourceLocation(item.location))
        && record(value.truncated) && count(value.truncated.declarations) && count(value.truncated.references)
        && Array.isArray(value.notes) && value.notes.length <= 50 && value.notes.every((note: unknown) => text(note));
}
const MEDIA: Record<string, { mime: string; kind: 'image' | 'audio' | 'video' }> = {
    '.png': { mime: 'image/png', kind: 'image' }, '.jpg': { mime: 'image/jpeg', kind: 'image' }, '.jpeg': { mime: 'image/jpeg', kind: 'image' },
    '.webp': { mime: 'image/webp', kind: 'image' }, '.gif': { mime: 'image/gif', kind: 'image' }, '.bmp': { mime: 'image/bmp', kind: 'image' },
    '.wav': { mime: 'audio/wav', kind: 'audio' }, '.mp3': { mime: 'audio/mpeg', kind: 'audio' }, '.ogg': { mime: 'audio/ogg', kind: 'audio' },
    '.m4a': { mime: 'audio/mp4', kind: 'audio' }, '.webm': { mime: 'video/webm', kind: 'video' }, '.mp4': { mime: 'video/mp4', kind: 'video' },
};
function displaySource(location: ResourceLocation): string { return `${vscode.workspace.asRelativePath(vscode.Uri.parse(location.uri), true)}:${location.range.start.line + 1}`; }
export type AssetResourceIndex = Pick<ResourceIndex, 'ready' | 'onDidChange' | 'entries' | 'resolve'>;

export class AssetController implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    private disposed = false;
    private generation = 0;
    private selection = 0;
    private detailGeneration = 0;
    private resource: Resource | undefined;
    private inventory: AssetInventory | undefined;
    private view: AssetView | undefined;
    private snapshot: AssetMessage | undefined;
    private cached: { id: string; file: TextureFile } | undefined;
    private choosing = false;
    private opening = false;
    private readonly sources = new Map<string, ResourceLocation>();
    private readonly assets = new Map<string, AssetEntry>();
    private readonly references: IndexedAssetReference[] = [];
    private readonly subscription: vscode.Disposable;
    private readonly loaded = new vscode.EventEmitter<string>();
    /** Fires when the visible browser has rendered the current resource snapshot. */
    readonly onDidLoad = this.loaded.event;

    constructor(private readonly extensionUri: vscode.Uri, private readonly request: AssetRequest, private readonly index: AssetResourceIndex) {
        this.subscription = index.onDidChange(() => {
            if (this.resource && !index.entries.some((entry) => entry.folder.toString() === this.resource!.folder.toString())) {
                this.reset(); this.resource = undefined;
                this.post({ type: 'loading' });
                this.post({ type: 'error', message: 'This resource is no longer in the workspace. Choose another resource.' });
            }
        });
    }
    async show(value?: unknown): Promise<void> {
        if (this.disposed || (value !== undefined && !(value instanceof vscode.Uri))) { return; }
        const selection = ++this.selection;
        await this.index.ready;
        if (this.disposed || selection !== this.selection) { return; }
        if (value instanceof vscode.Uri) {
            const resource = await this.index.resolve(value);
            if (this.disposed || selection !== this.selection) { return; }
            if (!resource || !this.index.entries.some((entry) => entry.folder.toString() === resource.folder.toString())) { void vscode.window.showInformationMessage('Choose a resource folder or its manifest to browse assets.'); return; }
            this.ensurePanel(); await this.load(resource);
        } else if (this.panel) { this.panel.reveal(this.panel.viewColumn); }
        else { await this.choose(); }
    }
    private ensurePanel(): void {
        if (this.panel) { this.panel.reveal(this.panel.viewColumn); return; }
        const panel = vscode.window.createWebviewPanel('qbxLua.assets', 'FiveM Resource Assets', vscode.ViewColumn.Beside,
            { enableScripts: true, enableCommandUris: false, retainContextWhenHidden: false, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')] });
        this.panel = panel;
        panel.webview.html = getAssetHtml(panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'assetWebview.js')).toString(), randomBytes(16).toString('hex'));
        const subscriptions = [panel.webview.onDidReceiveMessage((message: unknown) => {
            const generation = this.generation;
            void this.handle(message).catch((error) => { if (this.current(generation)) { this.post({ type: 'error', message: String(error) }); } });
        }),
            panel.onDidDispose(() => { subscriptions.forEach((item) => item.dispose()); if (this.panel === panel) { this.reset(); this.panel = undefined; this.resource = undefined; } })];
    }
    private async choose(): Promise<void> {
        if (this.disposed || this.choosing) { return; }
        this.choosing = true;
        const generation = this.generation;
        const selection = ++this.selection;
        try {
            await this.index.ready;
            const items = this.index.entries.map((resource) => ({ label: resource.name, description: vscode.workspace.asRelativePath(resource.folder, true), resource }));
            if (!items.length) { void vscode.window.showInformationMessage('Open a workspace containing FiveM resources first.'); return; }
            const selected = await vscode.window.showQuickPick(items, { title: 'FiveM Resource Assets', placeHolder: 'Choose a resource to inspect', matchOnDescription: true });
            if (selected && this.current(generation) && selection === this.selection
                && this.index.entries.some((entry) => entry.folder.toString() === selected.resource.folder.toString())) { this.ensurePanel(); await this.load(selected.resource); }
        } finally { this.choosing = false; }
    }
    private async load(resource: Resource): Promise<void> {
        this.reset(); this.resource = resource;
        const generation = this.generation;
        this.post({ type: 'loading' });
        try {
            const inventory = await inventoryAssets(resource.folder.fsPath, () => this.current(generation));
            if (!this.current(generation)) { return; }
            let metadata: ResourceAssets | undefined;
            const notes = [...inventory.notes];
            try {
                const result = await this.request('qbx/resourceAssets', { uri: resource.folder.toString() });
                if (!this.current(generation)) { return; }
                if (!validResourceAssets(result) || vscode.Uri.parse(result.resource.uri).toString() !== resource.folder.toString()) { throw new Error('The language server returned an invalid asset reference snapshot.'); }
                metadata = result;
            } catch (error) { notes.push(`Source references unavailable: ${error instanceof Error ? error.message : String(error)}`); }
            if (!this.current(generation)) { return; }
            const ids = new Map(inventory.entries.map((entry) => [entry.id, `${generation}:asset:${entry.id}`]));
            for (const entry of inventory.entries) { entry.id = ids.get(entry.id)!; this.assets.set(entry.id, entry); }
            for (const issue of inventory.issues) { if (issue.assetId) { issue.assetId = ids.get(issue.assetId); } }
            const data: AssetView = { snapshotId: randomBytes(16).toString('hex'), resource: { name: resource.name, path: resource.folder.fsPath }, entries: inventory.entries,
                references: [], issues: inventory.issues, notes, totalBytes: inventory.entries.reduce((sum, entry) => sum + entry.size, 0) };
            const source = (location: ResourceLocation): string => { const id = `${generation}:source:${this.sources.size}`; this.sources.set(id, location); return id; };
            for (const declaration of metadata?.declarations ?? []) {
                const resolved = declarationTargets(declaration, inventory);
                const id = source(declaration.location);
                this.references.push({ id, declaration });
                const matches = new Set(resolved.matches);
                const targets = inventory.entries.filter((entry) => matches.has(entry.path));
                data.references.push({ id, kind: declaration.dataType || declaration.kind, name: declaration.value, source: displaySource(declaration.location),
                    targets: targets.slice(0, 50).map((entry) => ({ id: entry.id, path: entry.path })), targetCount: targets.length, resolved: resolved.matches.length > 0,
                    note: resolved.note || (resolved.matches.length ? `${resolved.matches.length} matching filesystem ${resolved.matches.length === 1 ? 'entry' : 'entries'}.` : 'No local match.') });
                if (resolved.missing) { data.issues.push({ severity: 'warning', sourceId: id, source: displaySource(declaration.location), message: `Missing manifest target: ${declaration.value}` }); }
            }
            for (const reference of metadata?.references ?? []) {
                const targets = referenceTargets(reference, inventory.entries);
                const id = source(reference.location);
                this.references.push({ id, reference });
                data.references.push({ id, kind: reference.kind,
                    name: reference.value ?? (reference.hash !== undefined ? `0x${reference.hash.toString(16).padStart(8, '0')}` : '(unknown)'),
                    source: displaySource(reference.location), targets: targets.slice(0, 50).map((entry) => ({ id: entry.id, path: entry.path })), targetCount: targets.length, resolved: targets.length > 0,
                    note: !targets.length ? 'Not in this resource inventory; may be a base-game asset or belong to another resource.'
                        : reference.kind === 'texture' ? 'Texture dictionary found. Inspect its texture list to verify this texture name.' : undefined });
            }
            if (metadata) {
                data.notes.push(...metadata.notes);
                if (metadata.truncated.declarations || metadata.truncated.references) { data.notes.push(`Source snapshot omitted ${metadata.truncated.declarations} declarations and ${metadata.truncated.references} references.`); }
            }
            this.inventory = inventory; this.view = data;
            if (this.panel) { this.panel.title = `${resource.name} — Assets`; }
            this.post({ type: 'state', data });
        } catch (error) { if (this.current(generation)) { this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) }); } }
    }
    private async detail(entry: AssetEntry, requestId: number): Promise<void> {
        if (!this.inventory) { return; }
        const generation = this.generation, detailGeneration = ++this.detailGeneration;
        this.cached = undefined;
        try {
            const data: AssetDetail = { id: entry.id, title: entry.path, metadata: [
                { name: 'File size', value: `${entry.size.toLocaleString()} bytes` }, { name: 'Format', value: entry.format },
                { name: 'Name hash (JOAAT)', value: entry.hash === undefined ? 'Unavailable for non-ASCII names' : `0x${entry.hash.toString(16).padStart(8, '0')}` }], notes: [...entry.issues] };
            if (entry.extension === '.dds' || entry.extension === '.ytd') {
                const bytes = await readAssetBytes(this.inventory.root, entry.path, MAX_ASSET_BYTES);
                if (!this.current(generation) || this.detailGeneration !== detailGeneration) { return; }
                let file: TextureFile | undefined;
                if (entry.extension === '.dds') { file = parseDds(bytes, entry.name); }
                else {
                    const header = inspectResourceHeader(bytes);
                    data.notes.push(...header.notes);
                    if (header.systemBytes !== undefined) { data.metadata.push({ name: 'Resource pages', value: `${header.systemBytes.toLocaleString()} system + ${(header.graphicsBytes ?? 0).toLocaleString()} graphics bytes` }); }
                    if (header.container === 'RSC7') { file = await parseYtd(bytes); }
                }
                if (file) { data.textures = file.textures.map(({ offset: _offset, length: _length, pitch: _pitch, ...texture }) => texture); data.notes.push(...file.notes); if (this.current(generation) && this.detailGeneration === detailGeneration) { this.cached = { id: entry.id, file }; } }
            } else if (MEDIA[entry.extension]) {
                const bytes = await readAssetBytes(this.inventory.root, entry.path, 16 * 1024 * 1024);
                data.media = { ...MEDIA[entry.extension], data: bytes.toString('base64') };
                if (data.media.kind !== 'image') { data.notes.push('Playback depends on codecs supported by VS Code’s browser.'); }
            } else if (entry.category === 'metadata') {
                const bytes = await readAssetBytes(this.inventory.root, entry.path, 1024 * 1024);
                const contents = bytes.toString('utf8');
                data.text = contents.slice(0, 16384);
                if (contents.length > data.text.length) { data.notes.push('Text preview is limited to the first 16,384 characters.'); }
                if (entry.extension !== '.json') {
                    const cleaned = contents.replace(/<!--[\s\S]*?-->/g, '');
                    for (const key of ['name', 'archetypeName', 'assetName', 'textureDictionary', 'drawableDictionary', 'modelName', 'txdName']) {
                        const values = [...cleaned.matchAll(new RegExp(`<${key}(?:\\s[^>]*)?>([^<]{1,256})</${key}>`, 'g'))].map((match) => match[1].trim());
                        if (values.length) { data.metadata.push({ name: key, value: [...new Set(values)].slice(0, 20).join(', ') }); }
                    }
                    data.notes.push('XML fields are a text summary, not a schema or game compatibility validation.');
                } else { try { JSON.parse(contents); data.metadata.push({ name: 'JSON', value: 'Syntax parsed successfully' }); } catch { data.notes.push('JSON syntax is invalid; open the file to inspect it.'); } }
            } else {
                const bytes = await readAssetBytes(this.inventory.root, entry.path, 160, true);
                const header = inspectResourceHeader(bytes);
                data.notes.push(...header.notes);
                if (header.systemBytes !== undefined) { data.metadata.push({ name: 'Resource pages', value: `${header.systemBytes.toLocaleString()} system + ${(header.graphicsBytes ?? 0).toLocaleString()} graphics bytes` }); }
                data.notes.push('No 3D model, map geometry, animation or audio-bank decoder is provided.');
            }
            if (this.current(generation) && this.detailGeneration === detailGeneration) { this.post({ type: 'detail', requestId, data }); }
        } catch (error) { if (this.current(generation) && this.detailGeneration === detailGeneration) { this.post({ type: 'error', requestId, message: error instanceof Error ? error.message : String(error) }); } }
    }
    private async handle(value: unknown): Promise<void> {
        if (this.disposed || !this.panel || !record(value)) { return; }
        const message = value as unknown as AssetAction;
        if (message.type === 'ready') { if (this.snapshot) { this.post(this.snapshot); } return; }
        if (message.type === 'loaded') { if (this.view && this.resource && message.snapshotId === this.view.snapshotId) { this.loaded.fire(this.resource.folder.toString()); } return; }
        if (message.type === 'choose') { await this.choose(); return; }
        if (message.type === 'refresh') { if (this.resource) { await this.load(this.resource); } return; }
        if (!('id' in message) || typeof message.id !== 'string') { return; }
        const generation = this.generation;
        if (message.type === 'openSource') {
            const location = this.sources.get(message.id);
            if (location && !this.opening) { this.opening = true; try { await openResourceSource(location, () => this.current(generation)); } finally { this.opening = false; } }
            return;
        }
        const entry = this.assets.get(message.id);
        if (!entry) { return; }
        if (message.type === 'copyName') { await vscode.env.clipboard.writeText(entry.name); }
        else if (message.type === 'copyHash' && entry.hash !== undefined) { await vscode.env.clipboard.writeText(`0x${entry.hash.toString(16).padStart(8, '0')}`); }
        else if (message.type === 'openAsset' && this.inventory) {
            const filename = await fs.realpath(path.join(this.inventory.root, entry.path));
            if (!this.current(generation) || !assetContained(this.inventory.root, filename)) { return; }
            await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filename));
        } else if (message.type === 'detail' && count(message.requestId)) { await this.detail(entry, message.requestId); }
        else if (message.type === 'findReferences' && count(message.requestId)) {
            this.post({ type: 'referenceMatches', requestId: message.requestId, assetId: entry.id, ...referenceIdsForAsset(entry, this.references) });
        }
        else if (message.type === 'texture' && count(message.requestId) && count(message.textureId) && count(message.mip) && this.cached?.id === entry.id) {
            try {
                const decoded = textureMip(this.cached.file, message.textureId, message.mip);
                this.post({ type: 'pixels', requestId: message.requestId, data: { assetId: entry.id, textureId: message.textureId, mip: message.mip, ...decoded, data: decoded.data.toString('base64') } });
            } catch (error) { this.post({ type: 'error', requestId: message.requestId, message: error instanceof Error ? error.message : String(error) }); }
        }
    }
    private current(generation: number): boolean { return !this.disposed && this.generation === generation; }
    private post(message: AssetMessage): void {
        if (message.type === 'state' || message.type === 'loading' || (message.type === 'error' && message.requestId === undefined && !this.view)) { this.snapshot = message; }
        if (!this.disposed) { void this.panel?.webview.postMessage(message); }
    }
    private reset(): void { ++this.generation; ++this.detailGeneration; this.inventory = undefined; this.view = undefined; this.snapshot = undefined; this.cached = undefined; this.sources.clear(); this.assets.clear(); this.references.length = 0; }
    dispose(): void { this.disposed = true; this.reset(); this.panel?.dispose(); this.subscription.dispose(); this.loaded.dispose(); }
}
