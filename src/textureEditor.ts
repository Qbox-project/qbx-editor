import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { copyFromWebview, message as errorText, readBounded, record, watchFile } from './assetFiles';
import { bestMip, MAX_ASSET_BYTES, parseDds, parseYtd, textureLevelSize, textureMip } from './assetFormats';
import type { AssetTexture, TextureEncoding } from './assetTypes';
import { decodePng, encodePng, MAX_IMAGE_SIDE } from './pngCodec';
import { COMPRESSIONS, encodeTexture, MIPMAPS, type EncodeOptions } from './textureEncode';
import { getTextureHtml } from './textureHtml';
import type { TextureAction, TextureMessage, TextureView } from './textureTypes';
import { buildDictionary, MAX_TEXTURES, readDictionary, renameTexture, storeTexture, textureHash, textureMemory, textureNameFromFile, textureNameProblem, type StoredTexture } from './textureWrite';

export const TEXTURE_VIEW_TYPE = 'qbxLua.textureViewer';
const DEFAULTS: EncodeOptions = { compression: 'auto', mipmaps: 'auto' };
function count(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function plural(amount: number, noun: string): string { return `${amount.toLocaleString('en-US')} ${noun}${amount === 1 ? '' : 's'}`; }
function options(value: unknown): EncodeOptions {
    const given = record(value) ? value : {};
    return { compression: COMPRESSIONS.find((item) => item === given.compression) ?? DEFAULTS.compression, mipmaps: MIPMAPS.find((item) => item === given.mipmaps) ?? DEFAULTS.mipmaps };
}

interface Entry { name: string; width: number; height: number; mipCount: number; format: string; encoding?: TextureEncoding; notes: string[]; data: Buffer; stored?: StoredTexture }
interface Contents { entries: readonly Entry[]; notes: string[]; gen9: boolean; root?: Buffer; locked?: string }
export interface TextureEdit { uri: vscode.Uri; action: 'add' | 'replace' | 'remove' | 'rename'; images?: vscode.Uri[]; texture?: string; name?: string; compression?: string; mipmaps?: string }

/** A texture file open in one or more tabs: what is on disk plus the edits that are not saved yet. */
export class TextureDocument implements vscode.CustomDocument {
    readonly kind: 'ytd' | 'dds';
    readonly title: string;
    readonly dictionary: string;
    entries: readonly Entry[] = [];
    notes: string[] = [];
    error: string | undefined;
    locked: string | undefined;
    focus: string | undefined;
    loaded = false;
    private saved: readonly Entry[] = [];
    private gen9 = false;
    private root: Buffer | undefined;
    private generation = 0;
    private written: { mtime: number; size: number } | undefined;
    private built: { entries: readonly Entry[]; bytes: Buffer } | undefined;
    private readonly changed = new vscode.EventEmitter<string | undefined>();
    private readonly watcher: vscode.Disposable;
    /** Fires after every change of state, with a line for the status bar when there is one. */
    readonly onDidChange = this.changed.event;

    constructor(readonly uri: vscode.Uri, private readonly edits?: vscode.EventEmitter<vscode.CustomDocumentEditEvent<vscode.CustomDocument>>, private readonly closed?: () => void) {
        this.title = path.posix.basename(uri.path);
        const extension = path.posix.extname(this.title).toLowerCase();
        this.kind = extension === '.dds' ? 'dds' : 'ytd';
        this.dictionary = this.title.slice(0, this.title.length - extension.length).toLowerCase();
        this.watcher = watchFile(uri, () => void this.diskChanged());
    }
    get dirty(): boolean { return this.entries !== this.saved; }
    get readOnly(): string | undefined {
        return this.kind === 'dds' ? 'a .dds file holds one texture and is shown as it is' : this.error ? 'the file could not be read' : this.locked;
    }
    private async read(source: vscode.Uri): Promise<Contents> {
        const bytes = await readBounded(source, MAX_ASSET_BYTES);
        if (this.kind === 'dds') {
            const file = parseDds(bytes, this.dictionary);
            return { notes: [...file.notes, ...file.header.notes], gen9: false, entries: file.textures.map((texture) => ({ name: texture.name, width: texture.width, height: texture.height, mipCount: texture.mipCount, format: texture.format,
                encoding: texture.encoding, notes: texture.notes, data: file.bytes.subarray(texture.offset, texture.offset + texture.length) })) };
        }
        const file = await parseYtd(bytes), dictionary = readDictionary(file);
        return { notes: [...file.notes], gen9: dictionary.gen9, root: dictionary.root, locked: dictionary.locked, entries: dictionary.textures.map((stored, index) => ({ name: stored.name, width: stored.width, height: stored.height,
            mipCount: stored.mipCount, format: file.textures[index].format, encoding: stored.encoding, notes: file.textures[index].notes, data: stored.data, stored })) };
    }
    /** Reads the file; `backup` is the copy VS Code kept of unsaved edits when the window last closed. */
    async load(backup?: vscode.Uri): Promise<void> {
        const generation = ++this.generation;
        try {
            const disk = await this.read(this.uri), edited = backup ? await this.read(backup) : disk;
            if (generation !== this.generation) { return; }
            this.error = undefined; this.saved = disk.entries; this.entries = edited.entries;
            this.notes = edited.notes; this.gen9 = edited.gen9; this.root = edited.root; this.locked = edited.locked;
        } catch (error) {
            if (generation !== this.generation) { return; }
            this.error = errorText(error); this.saved = this.entries = [];
        }
        this.focus = undefined; this.loaded = true; this.changed.fire(undefined);
    }
    /** Starts a dictionary that has no file yet. */
    startEmpty(): void { this.error = this.locked = this.root = undefined; this.gen9 = false; this.saved = this.entries = []; this.loaded = true; }
    private async diskChanged(): Promise<void> {
        const stat = await vscode.workspace.fs.stat(this.uri).then((value) => value, () => undefined);
        if (stat && this.written && stat.mtime === this.written.mtime && stat.size === this.written.size) { return; }
        if (this.dirty) { this.changed.fire('The file changed on disk. Your unsaved edits are kept; use File: Revert File to discard them.'); return; }
        await this.load();
    }
    private set(entries: readonly Entry[], focus: string | undefined, status: string): void { this.entries = entries; this.focus = focus; this.changed.fire(status); }
    private apply(label: string, entries: readonly Entry[], focus: string | undefined, status: string): void {
        const previous = this.entries;
        this.set(entries, focus, status);
        this.edits?.fire({ document: this, label, undo: () => this.set(previous, undefined, `Undid: ${label}.`), redo: () => this.set(entries, focus, `Redid: ${label}.`) });
    }
    private assertEditable(): void { if (this.readOnly) { throw new Error(`This file cannot be edited: ${this.readOnly}.`); } }
    find(name: string, entries = this.entries): number { const hash = textureHash(name); return entries.findIndex((entry) => entry.stored?.hash === hash); }

    /**
     * Adds images as textures named after their files; an image whose name is already in the dictionary replaces that
     * texture, and `target` makes one image replace that texture whatever the file is called.
     */
    async importImages(images: readonly vscode.Uri[], settings: EncodeOptions, target?: number, pause?: () => Promise<void>, report?: (name: string) => void): Promise<void> {
        this.assertEditable();
        const entries = [...this.entries], notes: string[] = [];
        let added = 0, replaced = 0, focus: string | undefined;
        for (const image of images) {
            const file = path.posix.basename(image.path), fromFile = textureNameFromFile(file.replace(/\.[^.]*$/, '')), index = target ?? this.find(fromFile, entries);
            const name = index >= 0 ? entries[index].name : fromFile, previous = index >= 0 ? entries[index] : undefined;
            report?.(name);
            let pixels;
            try { pixels = decodePng(await readBounded(image, MAX_ASSET_BYTES)); } catch (error) { throw new Error(`${file}: ${errorText(error)}`); }
            const encoded = await encodeTexture(pixels, name, settings, previous, pause), stored = storeTexture(name, encoded, this.gen9, previous?.stored);
            const entry: Entry = { name, width: encoded.width, height: encoded.height, mipCount: encoded.mipCount, format: encoded.encoding, encoding: encoded.encoding, notes: encoded.notes, data: encoded.data, stored };
            if (index >= 0) { entries[index] = entry; replaced++; } else { entries.push(entry); added++; }
            focus ??= name; notes.push(...encoded.notes.map((note) => `${name}: ${note}`));
        }
        if (entries.length > MAX_TEXTURES) { throw new Error(`A texture dictionary holds at most ${MAX_TEXTURES.toLocaleString('en-US')} textures.`); }
        const done = [added ? `added ${plural(added, 'texture')}` : '', replaced ? `replaced ${plural(replaced, 'texture')}` : ''].filter(Boolean).join(' and ');
        if (done) { this.apply(target === undefined ? 'Add Textures' : 'Replace Texture', entries, focus, `${done[0].toUpperCase()}${done.slice(1)}. ${notes.join(' ')}`.trim()); }
    }
    remove(index: number): void {
        this.assertEditable();
        const entry = this.entries[index];
        if (entry) { this.apply('Delete Texture', this.entries.filter((_, at) => at !== index), this.entries[index + 1]?.name ?? this.entries[index - 1]?.name, `Deleted ${entry.name}.`); }
    }
    renameProblem(index: number, name: string): string | undefined {
        return textureNameProblem(name, this.entries.filter((_, at) => at !== index).flatMap((entry) => entry.stored ? [entry.stored] : []));
    }
    rename(index: number, name: string): void {
        this.assertEditable();
        const entry = this.entries[index], problem = this.renameProblem(index, name);
        if (!entry?.stored || entry.name === name) { return; }
        if (problem) { throw new Error(problem); }
        this.apply('Rename Texture', this.entries.map((item, at) => at === index ? { ...entry, name, stored: renameTexture(entry.stored!, name) } : item), name, `Renamed ${entry.name} to ${name}.`);
    }
    /** One mip level as stored, for the preview to decode. */
    level(index: number, mip: number): { width: number; height: number; encoding: TextureEncoding; data: Buffer } {
        const entry = this.entries[index];
        if (!entry) { throw new Error('Choose a supported texture and mip level.'); }
        const { data, stored: _stored, ...texture } = entry;
        return textureMip({ header: { container: 'RSC7', notes: [] }, bytes: data, textures: [{ ...texture, id: 0, offset: 0, length: data.length }], notes: [] }, 0, mip);
    }
    /** The largest level of a texture as a PNG file. */
    async png(index: number): Promise<Buffer> {
        const entry = this.entries[index];
        if (!entry?.encoding) { throw new Error(`${entry?.name ?? 'This texture'} uses an encoding that cannot be exported.`); }
        if (entry.width > MAX_IMAGE_SIDE || entry.height > MAX_IMAGE_SIDE) { throw new Error(`${entry.name} is larger than ${MAX_IMAGE_SIDE} pixels and cannot be exported.`); }
        const { decodeAssetTexture } = await import('./assetTextureDecode.mjs'), size = textureLevelSize(entry.width, entry.height, entry.encoding);
        if (entry.data.length < size) { throw new Error(`${entry.name} is not stored completely in this file.`); }
        return encodePng({ width: entry.width, height: entry.height, rgba: decodeAssetTexture(entry.data.subarray(0, size), entry.width, entry.height, entry.encoding, MAX_IMAGE_SIDE * MAX_IMAGE_SIDE) });
    }
    async bytes(): Promise<Buffer> {
        if (this.kind === 'dds') { return readBounded(this.uri, MAX_ASSET_BYTES); }
        this.assertEditable();
        const entries = this.entries;
        if (this.built?.entries !== entries) { this.built = { entries, bytes: await buildDictionary({ gen9: this.gen9, root: this.root, textures: entries.flatMap((entry) => entry.stored ? [entry.stored] : []) }) }; }
        return this.built.bytes;
    }
    async save(target = this.uri): Promise<void> {
        const entries = this.entries;
        if (target.toString() === this.uri.toString() && !this.dirty) { return; }
        await vscode.workspace.fs.writeFile(target, await this.bytes());
        if (target.toString() !== this.uri.toString()) { return; }
        const stat = await vscode.workspace.fs.stat(target);
        this.written = { mtime: stat.mtime, size: stat.size }; this.saved = entries; this.built = undefined;
        this.changed.fire(`Saved ${this.title}.`);
    }
    view(): TextureView {
        const textures: AssetTexture[] = this.entries.map((entry, id) => ({ id, name: entry.name, width: entry.width, height: entry.height, mipCount: entry.mipCount, format: entry.format, encoding: entry.encoding,
            previewMip: entry.encoding ? bestMip(entry.width, entry.height, entry.mipCount) : undefined, notes: entry.notes }));
        const stored = this.entries.flatMap((entry) => entry.stored ? [entry.stored] : []);
        return { snapshotId: randomBytes(16).toString('hex'), title: this.title, path: this.uri.scheme === 'file' ? this.uri.fsPath : this.uri.toString(true), dictionary: this.dictionary, kind: this.kind, textures, notes: this.notes,
            readOnly: this.readOnly, dirty: this.dirty, memory: this.kind === 'ytd' ? textureMemory(stored) : this.entries.reduce((sum, entry) => sum + entry.data.length, 0), focus: this.focus };
    }
    dispose(): void { ++this.generation; this.watcher.dispose(); this.changed.dispose(); this.closed?.(); }
}

/** Encodes while a notification shows which texture is in work and offers to cancel. */
async function importWithProgress(document: TextureDocument, images: readonly vscode.Uri[], settings: EncodeOptions, target?: number): Promise<void> {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Encoding textures', cancellable: true }, (progress, token) => {
        const pause = (): Promise<void> => new Promise((resolve, reject) => setImmediate(() => token.isCancellationRequested ? reject(new vscode.CancellationError()) : resolve()));
        return document.importImages(images, settings, target, pause, (name) => progress.report({ message: name }));
    });
}

export class TextureEditor implements vscode.Disposable {
    private disposed = false;
    private ready = false;
    private busy = false;
    private snapshot: TextureMessage = { type: 'loading' };
    private readonly subscriptions: vscode.Disposable[] = [];
    private readonly loaded = new vscode.EventEmitter<TextureView>();
    private readonly drawn = new vscode.EventEmitter<{ textureId: number; width: number; height: number }>();
    readonly onDidLoad = this.loaded.event;
    /** Fires when the webview has decoded a texture and put it on its canvas. */
    readonly onDidDraw = this.drawn.event;
    view: TextureView | undefined;

    constructor(extensionUri: vscode.Uri, readonly document: TextureDocument, private readonly panel: vscode.WebviewPanel) {
        panel.webview.options = { enableScripts: true, enableCommandUris: false, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')] };
        panel.webview.html = getTextureHtml(panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'textureWebview.js')).toString(), randomBytes(16).toString('hex'));
        this.subscriptions.push(this.loaded, this.drawn, document.onDidChange((status) => this.show(status)),
            panel.webview.onDidReceiveMessage((value: unknown) => { void this.handle(value).catch((error) => { if (!(error instanceof vscode.CancellationError)) { this.post({ type: 'status', message: errorText(error) }); } }); }),
            panel.onDidDispose(() => this.dispose()));
        if (document.loaded) { this.show(); }
    }
    private post(value: TextureMessage): void {
        if (value.type === 'loading' || value.type === 'state' || value.type === 'error') { this.snapshot = value; }
        if (!this.disposed && this.ready) { void this.panel.webview.postMessage(value); }
    }
    private show(status?: string): void {
        if (this.document.error) { this.view = undefined; this.post({ type: 'error', message: this.document.error }); return; }
        this.view = this.document.view();
        this.post({ type: 'state', data: this.view });
        if (status) { this.post({ type: 'status', message: status }); }
    }
    private async exclusive(work: () => Promise<void>): Promise<void> {
        if (this.busy) { this.post({ type: 'status', message: 'Another change is still in progress.' }); return; }
        this.busy = true;
        try { await work(); } finally { this.busy = false; }
    }
    private folder(): vscode.Uri { return vscode.Uri.joinPath(this.document.uri, '..'); }
    private async handle(value: unknown): Promise<void> {
        if (this.disposed || !record(value) || typeof value.type !== 'string') { return; }
        const action = value as TextureAction, document = this.document;
        if (action.type === 'ready') { this.ready = true; this.post(this.snapshot); }
        else if (action.type === 'loaded') { if (this.view && action.snapshotId === this.view.snapshotId) { this.loaded.fire(this.view); } }
        else if (action.type === 'drawn') { if (this.view && action.snapshotId === this.view.snapshotId && count(action.textureId) && count(action.width) && count(action.height)) { this.drawn.fire({ textureId: action.textureId, width: action.width, height: action.height }); } }
        else if (action.type === 'reload') {
            if (document.dirty) { this.post({ type: 'status', message: 'Unsaved edits are kept. Use File: Revert File to discard them and read the file again.' }); } else { await document.load(); }
        } else if (action.type === 'pixels') {
            if (!count(action.textureId) || !count(action.mip) || !count(action.requestId)) { return; }
            try {
                const { data, ...mip } = document.level(action.textureId, action.mip);
                this.post({ type: 'pixels', requestId: action.requestId, data: { textureId: action.textureId, mip: action.mip, ...mip, data: new Uint8Array(data) } });
            } catch (error) { this.post({ type: 'noPixels', requestId: action.requestId, message: errorText(error) }); }
        } else if (action.type === 'copy') { const status = await copyFromWebview(action.text, action.label); if (status) { this.post({ type: 'status', message: status }); } }
        else if (!this.view || action.snapshotId !== this.view.snapshotId) { return; }
        else if (action.type === 'add') {
            await this.exclusive(async () => {
                const images = await vscode.window.showOpenDialog({ title: 'Add or Replace Textures from PNG Files', openLabel: 'Add', canSelectMany: true, defaultUri: this.folder(), filters: { 'PNG images': ['png'] } });
                if (images?.length) { await importWithProgress(document, images, options(action.options)); }
            });
        } else if (action.type === 'exportAll') {
            await this.exclusive(async () => {
                const [folder] = await vscode.window.showOpenDialog({ title: 'Export Every Texture as PNG', openLabel: 'Export Here', canSelectFolders: true, canSelectFiles: false, defaultUri: this.folder() }) ?? [];
                if (!folder) { return; }
                let written = 0;
                const skipped: string[] = [];
                for (const [index, texture] of this.view!.textures.entries()) {
                    try { await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder, `${texture.name.replace(/[<>:"/\\|?*]/g, '_')}.png`), await document.png(index)); written++; }
                    catch { skipped.push(texture.name); }
                }
                this.post({ type: 'status', message: `Exported ${plural(written, 'texture')}.${skipped.length ? ` Skipped ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ` and ${skipped.length - 5} more` : ''}.` : ''}` });
            });
        } else if (!count(action.textureId) || !this.view.textures[action.textureId]) { return; }
        else if (action.type === 'replace') {
            const textureId = action.textureId, name = this.view.textures[textureId].name;
            await this.exclusive(async () => {
                const [image] = await vscode.window.showOpenDialog({ title: `Replace ${name} with a PNG File`, openLabel: 'Replace', defaultUri: this.folder(), filters: { 'PNG images': ['png'] } }) ?? [];
                if (image) { await importWithProgress(document, [image], options(action.options), textureId); }
            });
        } else if (action.type === 'remove') { document.remove(action.textureId); }
        else if (action.type === 'rename') {
            const textureId = action.textureId, current = this.view.textures[textureId].name;
            const name = await vscode.window.showInputBox({ title: 'Rename Texture', value: current, prompt: 'The name models and scripts refer to.', validateInput: (text) => text === current ? undefined : document.renameProblem(textureId, text) });
            if (name && this.view.textures[textureId]?.name === current) { document.rename(textureId, name); }
        } else if (action.type === 'export') {
            const texture = this.view.textures[action.textureId];
            const target = await vscode.window.showSaveDialog({ title: 'Export Texture as PNG', defaultUri: vscode.Uri.joinPath(this.folder(), `${texture.name.replace(/[<>:"/\\|?*]/g, '_')}.png`), filters: { 'PNG image': ['png'] } });
            if (target) { await vscode.workspace.fs.writeFile(target, await document.png(action.textureId)); this.post({ type: 'status', message: `Exported ${texture.name}.` }); }
        }
    }
    dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true;
        this.subscriptions.forEach((subscription) => subscription.dispose());
    }
}

/** The custom editor behind `.ytd` and `.dds` files, loaded on first use. */
export class TextureProvider {
    private readonly documents = new Map<string, TextureDocument>();
    constructor(private readonly extensionUri: vscode.Uri, private readonly edits: vscode.EventEmitter<vscode.CustomDocumentEditEvent<vscode.CustomDocument>>) {}
    async openCustomDocument(uri: vscode.Uri, context: vscode.CustomDocumentOpenContext): Promise<TextureDocument> {
        const key = uri.toString(), document: TextureDocument = new TextureDocument(uri, this.edits, () => { if (this.documents.get(key) === document) { this.documents.delete(key); } });
        this.documents.set(key, document);
        await document.load(context.backupId ? vscode.Uri.parse(context.backupId) : undefined);
        return document;
    }
    resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): void { new TextureEditor(this.extensionUri, document as TextureDocument, panel); }
    saveCustomDocument(document: vscode.CustomDocument): Promise<void> { return (document as TextureDocument).save(); }
    saveCustomDocumentAs(document: vscode.CustomDocument, destination: vscode.Uri): Promise<void> { return (document as TextureDocument).save(destination); }
    revertCustomDocument(document: vscode.CustomDocument): Promise<void> { return (document as TextureDocument).load(); }
    async backupCustomDocument(document: vscode.CustomDocument, context: vscode.CustomDocumentBackupContext): Promise<vscode.CustomDocumentBackup> {
        await vscode.workspace.fs.writeFile(context.destination, await (document as TextureDocument).bytes());
        return { id: context.destination.toString(), delete: () => { void vscode.workspace.fs.delete(context.destination).then(undefined, () => undefined); } };
    }
    /** Applies one edit to a dictionary that is open in the editor, without a dialog. */
    async edit(request: unknown): Promise<void> {
        if (!record(request) || !(request.uri instanceof vscode.Uri)) { throw new Error('Name the texture dictionary to edit.'); }
        const { action, images, texture, name } = request as unknown as TextureEdit, document = this.documents.get(request.uri.toString());
        if (!document) { throw new Error('Open the texture dictionary in the texture viewer first.'); }
        const index = typeof texture === 'string' ? document.find(texture) : -1;
        if (action === 'add' && Array.isArray(images)) { await document.importImages(images, options(request)); }
        else if (index < 0) { throw new Error(`The dictionary holds no texture named ${String(texture)}.`); }
        else if (action === 'replace' && images?.length === 1) { await document.importImages(images, options(request), index); }
        else if (action === 'remove') { document.remove(index); }
        else if (action === 'rename' && typeof name === 'string') { document.rename(index, name); }
        else { throw new Error('Unknown texture edit.'); }
    }
    /** Creates a dictionary from PNG files and opens it. */
    async create(target?: unknown, images?: unknown): Promise<vscode.Uri | undefined> {
        const chosen = Array.isArray(images) && images.every((image) => image instanceof vscode.Uri) ? images as vscode.Uri[]
            : await vscode.window.showOpenDialog({ title: 'New Texture Dictionary: Choose PNG Files', openLabel: 'Use These Images', canSelectMany: true, filters: { 'PNG images': ['png'] } });
        if (!chosen?.length) { return undefined; }
        const folder = vscode.Uri.joinPath(chosen[0], '..'), suggested = vscode.Uri.joinPath(folder, `${textureNameFromFile(path.posix.basename(folder.path)).toLowerCase()}.ytd`);
        const file = target instanceof vscode.Uri ? target : await vscode.window.showSaveDialog({ title: 'New Texture Dictionary: Save As', defaultUri: suggested, filters: { 'Texture dictionary': ['ytd'] } });
        if (!file) { return undefined; }
        const document = new TextureDocument(file);
        try {
            document.startEmpty();
            await importWithProgress(document, chosen, DEFAULTS);
            await vscode.workspace.fs.writeFile(file, await document.bytes());
        } finally { document.dispose(); }
        await vscode.commands.executeCommand('vscode.openWith', file, TEXTURE_VIEW_TYPE);
        return file;
    }
}
let provider: TextureProvider | undefined;
export function textureProvider(extensionUri: vscode.Uri, edits: vscode.EventEmitter<vscode.CustomDocumentEditEvent<vscode.CustomDocument>>): TextureProvider {
    return provider ??= new TextureProvider(extensionUri, edits);
}
