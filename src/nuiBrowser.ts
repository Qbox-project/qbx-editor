import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getNuiHtml } from './nuiHtml';
import { createNuiPreviewServer } from './nuiPreviewServer';
import { NuiPresetStore } from './nuiPresets';
import { validNuiResource } from './nuiValidation';
import { openResourceSource } from './resourceNavigation';
import type { Resource, ResourceIndex } from './resources';
import type { ResourceLocation } from './resourceDetailsTypes';
import type { NuiMessage, NuiRequest, NuiView } from './nuiTypes';

type PreviewServer = Awaited<ReturnType<typeof createNuiPreviewServer>>;
function sameFile(a: vscode.Uri, b: vscode.Uri): boolean {
    const clean = (uri: vscode.Uri) => process.platform === 'win32' ? path.resolve(uri.fsPath).toLowerCase() : path.resolve(uri.fsPath);
    return a.scheme === 'file' && b.scheme === 'file' && clean(a) === clean(b);
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

/** One isolated preview, explicit workspace presets, and authoritative indexed Lua source actions. */
export class NuiController implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    private server: PreviewServer | undefined;
    private resource: Resource | undefined;
    private view: NuiView | undefined;
    private generation = 0;
    private selectionGeneration = 0;
    private status: Extract<NuiMessage, { type: 'error' | 'notice' }> | undefined;
    private disposed = false;
    private loading = false;
    private choosing = false;
    private opening = false;
    private pickerCancellation: vscode.CancellationTokenSource | undefined;
    private readonly sources = new Map<string, ResourceLocation>();
    private readonly store: NuiPresetStore;
    private readonly indexSubscription: vscode.Disposable;
    private readonly readyEmitter = new vscode.EventEmitter<string>();
    /** Signals that the isolated preview bridge actually loaded, for editor integration clients. */
    readonly onDidPreviewReady = this.readyEmitter.event;

    constructor(private readonly extensionUri: vscode.Uri, workspaceState: vscode.Memento,
        private readonly request: NuiRequest, private readonly index: ResourceIndex,
        private readonly createServer: typeof createNuiPreviewServer = createNuiPreviewServer) {
        this.store = new NuiPresetStore(workspaceState);
        this.indexSubscription = index.onDidChange(() => {
            ++this.selectionGeneration;
            this.pickerCancellation?.cancel();
            if (this.resource && !index.entries.some((item) => sameFile(item.folder, this.resource!.folder))) {
                this.reset(); this.resource = undefined; this.view = undefined;
                this.html(); this.post({ type: 'error', message: 'The resource is no longer in the open workspace. Choose a resource to continue.' });
            }
        });
    }

    async show(value?: unknown): Promise<void> {
        if (this.disposed || (value !== undefined && !(value instanceof vscode.Uri))) { return; }
        if (!vscode.workspace.isTrusted) { void vscode.window.showWarningMessage('NUI preview runs resource UI scripts. Trust this workspace before opening the preview.'); return; }
        try {
            await this.index.ready;
            if (this.disposed) { return; }
            if (value instanceof vscode.Uri) {
                this.pickerCancellation?.cancel();
                const selection = ++this.selectionGeneration;
                const resource = await this.index.resolve(value);
                if (this.disposed || selection !== this.selectionGeneration) { return; }
                if (!resource) { void vscode.window.showInformationMessage('Choose a FiveM resource folder or its manifest.'); return; }
                this.ensurePanel(); await this.load(resource);
            } else if (this.panel) { this.panel.reveal(this.panel.viewColumn); }
            else { await this.choose(); }
        } catch (error) { this.report(error); }
    }

    private ensurePanel(): void {
        if (this.panel) { this.panel.reveal(this.panel.viewColumn); return; }
        const panel = vscode.window.createWebviewPanel('qbxLua.nuiPreview', 'FiveM NUI Preview', vscode.ViewColumn.Beside, {
            enableScripts: true, enableCommandUris: false, enableForms: false, retainContextWhenHidden: false,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
        });
        this.panel = panel;
        const subscriptions = [
            panel.webview.onDidReceiveMessage((message: unknown) => { void this.handle(message).catch((error) => this.report(error)); }),
            panel.onDidDispose(() => {
                subscriptions.forEach((item) => item.dispose());
                if (this.panel === panel) { this.reset(); this.panel = undefined; this.resource = undefined; this.view = undefined; }
            }),
        ];
        this.html();
    }

    private html(origin?: string): void {
        if (!this.panel || this.disposed) { return; }
        const port = origin ? Number(new URL(origin).port) : undefined;
        this.panel.webview.options = { enableScripts: true, enableCommandUris: false, enableForms: false,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
            portMapping: port ? [{ webviewPort: port, extensionHostPort: port }] : [] };
        const script = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'nuiWebview.js'));
        this.panel.webview.html = getNuiHtml(script.toString(), randomBytes(16).toString('hex'), origin);
    }

    private async load(resource: Resource): Promise<void> {
        this.reset();
        const generation = this.generation;
        this.resource = resource;
        this.view = undefined;
        this.loading = true;
        this.html();
        this.post({ type: 'notice', message: 'Loading the resource UI and indexed Lua callbacks…' });
        try {
            const data = await this.request('qbx/nuiResource', { uri: resource.folder.toString() });
            if (!this.current(generation)) { return; }
            if (!validNuiResource(data) || !sameFile(vscode.Uri.parse(data.resource.uri), resource.folder)) {
                throw new Error('The language server returned invalid NUI resource information.');
            }
            const notes = [...data.notes];
            let presets: NuiView['presets'] = [];
            try { presets = this.store.load(resource.folder.toString()); }
            catch (error) { notes.push(error instanceof Error ? error.message : String(error)); }
            if (data.uiPage) {
                try {
                    const bridgeScript = await fs.readFile(vscode.Uri.joinPath(this.extensionUri, 'dist', 'nuiPreviewBridge.js').fsPath, 'utf8');
                    if (!this.current(generation)) { return; }
                    const server = await this.createServer({ root: resource.folder.fsPath, uiPage: data.uiPage, resourceName: data.resource.name, bridgeScript });
                    if (!this.current(generation) || !vscode.workspace.isTrusted) { server.dispose(); return; }
                    this.server = server;
                } catch (error) {
                    if (!this.current(generation)) { return; }
                    notes.push(`Preview unavailable: ${error instanceof Error ? error.message : String(error)}`);
                }
            } else { notes.push('This resource has no literal ui_page. Lua callback navigation is still available.'); }
            if (!this.current(generation)) { return; }
            this.view = { resource: { name: data.resource.name, path: resource.folder.fsPath, uri: resource.folder.toString() },
                uiPage: data.uiPage, frameUrl: this.server?.url ?? null, token: this.server?.token ?? null,
                callbacks: data.callbacks.map((callback, index) => {
                    const id = `${generation}:callback:${index}`;
                    this.sources.set(id, callback.location);
                    return { id, name: callback.name, source: `${vscode.workspace.asRelativePath(vscode.Uri.parse(callback.location.uri), true)}:${callback.location.range.start.line + 1}` };
                }), notes, presets, truncated: data.truncated };
            this.html(this.server?.origin);
            if (this.panel) { this.panel.title = `${data.resource.name} — NUI Preview`; }
            this.post({ type: 'state', data: this.view });
        } catch (error) {
            if (this.current(generation)) { this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
        } finally { if (this.current(generation)) { this.loading = false; } }
    }

    private async choose(): Promise<void> {
        if (this.disposed || this.choosing || !vscode.workspace.isTrusted) { return; }
        this.choosing = true;
        const generation = this.generation;
        const cancellation = new vscode.CancellationTokenSource();
        this.pickerCancellation = cancellation;
        try {
            await this.index.ready;
            if (!this.current(generation) || cancellation.token.isCancellationRequested) { return; }
            const items = this.index.entries.map((resource) => ({ label: resource.name, description: vscode.workspace.asRelativePath(resource.folder, true), detail: resource.folder.fsPath, resource }));
            if (!items.length) { void vscode.window.showInformationMessage('Open a workspace containing FiveM resource manifests first.'); return; }
            const selected = await vscode.window.showQuickPick(items, { title: 'FiveM NUI Preview', placeHolder: 'Choose a resource with a local ui_page', matchOnDescription: true, matchOnDetail: true }, cancellation.token);
            if (selected && this.current(generation) && !cancellation.token.isCancellationRequested
                && this.index.entries.some((item) => sameFile(item.folder, selected.resource.folder))) {
                this.ensurePanel(); await this.load(selected.resource);
            }
        } finally {
            cancellation.dispose(); this.choosing = false;
            if (this.pickerCancellation === cancellation) { this.pickerCancellation = undefined; }
        }
    }

    private async handle(message: unknown): Promise<void> {
        if (this.disposed || !this.panel || !record(message)) { return; }
        if (!vscode.workspace.isTrusted) { this.reset(); this.view = undefined; this.html(); return; }
        if (message.type === 'ready') {
            const status = this.status;
            if (this.view) { this.post({ type: 'state', data: this.view }); }
            if (status) { this.post(status); }
            return;
        }
        if (message.type === 'chooseResource') { await this.choose(); return; }
        if (message.type === 'reload') { if (this.resource && !this.loading) { await this.load(this.resource); } return; }
        if (!this.view || this.loading) { return; }
        if (message.type === 'previewReady') {
            if (this.server && message.token === this.server.token) { this.readyEmitter.fire(this.view.resource.uri); }
            return;
        }
        const generation = this.generation;
        if (message.type === 'openSource' && typeof message.id === 'string' && !this.opening) {
            const location = this.sources.get(message.id);
            if (location) {
                this.opening = true;
                try { await openResourceSource(location, () => this.current(generation)); }
                finally { this.opening = false; }
            }
        } else if (message.type === 'savePreset' || message.type === 'deletePreset') {
            const uri = this.view.resource.uri;
            const presets = message.type === 'savePreset' ? await this.store.save(uri, message.preset)
                : typeof message.name === 'string' ? await this.store.remove(uri, message.name) : undefined;
            if (presets && this.current(generation) && this.view) {
                this.view = { ...this.view, presets };
                this.post({ type: 'state', data: this.view });
                this.post({ type: 'notice', message: message.type === 'savePreset' ? 'Preset saved for this resource in this workspace.' : 'Preset deleted.' });
            }
        }
    }

    private current(generation: number): boolean { return !this.disposed && generation === this.generation; }
    private reset(): void { ++this.generation; ++this.selectionGeneration; this.server?.dispose(); this.server = undefined; this.sources.clear(); this.loading = false; this.status = undefined; this.pickerCancellation?.cancel(); }
    private post(message: NuiMessage): void {
        this.status = message.type === 'state' ? undefined : message;
        if (!this.disposed && this.panel) { void this.panel.webview.postMessage(message); }
    }
    private report(error: unknown): void {
        if (!this.disposed) {
            const message = error instanceof Error ? error.message : String(error);
            if (this.panel) { this.post({ type: 'error', message }); }
            else { void vscode.window.showErrorMessage(`NUI Preview: ${message}`); }
        }
    }
    dispose(): void { this.disposed = true; this.reset(); this.panel?.dispose(); this.indexSubscription.dispose(); this.readyEmitter.dispose(); }
}
