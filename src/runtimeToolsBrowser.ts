import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { RuntimeLogTail, type LogTailUpdate } from './runtimeLogTail';
import { parseLogSources } from './runtimeLogParser';
import { openLogSource, validLogSource, type LogSource } from './runtimeLogSources';
import { getRuntimeLogHtml } from './runtimeLogHtml';
import { getWorkspaceHealthHtml } from './workspaceHealthHtml';
import { WorkspaceHealthSession, type WorkspaceHealthRequest } from './workspaceHealthSession';
import { openResourceSource } from './resourceNavigation';
import type { ResourceIndex } from './resources';
import type { RuntimeLogView } from './runtimeToolsTypes';

function panel(extension: vscode.Uri, type: string, title: string, script: string,
    html: (script: string, nonce: string) => string): vscode.WebviewPanel {
    const result = vscode.window.createWebviewPanel(type, title, vscode.ViewColumn.Beside, {
        enableScripts: true, enableCommandUris: false, retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(extension, 'dist')],
    });
    result.webview.html = html(result.webview.asWebviewUri(vscode.Uri.joinPath(extension, 'dist', script)).toString(), randomBytes(16).toString('hex'));
    return result;
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

/** Follows only the explicitly selected file; lifetime and in-memory history belong to the tab. */
export class RuntimeLogController implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    private tail: RuntimeLogTail | undefined;
    private generation = 0;
    private disposed = false;
    private choosing = false;
    private opening = false;
    private sourceCancellation: vscode.CancellationTokenSource | undefined;
    private readonly links = new Map<string, LogSource>();
    private readonly indexSubscription: vscode.Disposable;
    private update: LogTailUpdate = { lines: [], paused: false, status: 'Choose an FXServer or txAdmin log file accessible on this machine.' };
    private path = '';

    constructor(private readonly extensionUri: vscode.Uri, private readonly index: ResourceIndex) {
        this.indexSubscription = index.onDidChange(() => { this.sourceCancellation?.cancel(); this.post(); });
        void index.ready.then(() => this.post()).catch(() => {});
    }

    async show(value?: unknown): Promise<void> {
        if (this.disposed || (value !== undefined && (!(value instanceof vscode.Uri) || value.scheme !== 'file' || value.query || value.fragment))) { return; }
        if (!this.panel) {
            const created = panel(this.extensionUri, 'qbxLua.runtimeLog', 'FiveM Runtime Log', 'runtimeLogWebview.js', getRuntimeLogHtml);
            this.panel = created;
            const subscriptions = [
                created.webview.onDidReceiveMessage((message: unknown) => { void this.handle(message).catch((error) => this.report(error)); }),
                created.onDidDispose(() => {
                    subscriptions.forEach((item) => item.dispose());
                    if (this.panel === created) {
                        this.reset(); this.panel = undefined; this.path = '';
                        this.update = { lines: [], paused: false, status: 'Choose a log file to start following output.' };
                    }
                }),
            ];
        } else { this.panel.reveal(this.panel.viewColumn); }
        this.post();
        if (value instanceof vscode.Uri) { await this.select(value); }
        else if (!this.path) { await this.choose(); }
    }

    private async select(uri: vscode.Uri): Promise<void> {
        if (this.disposed || !this.panel || uri.scheme !== 'file' || uri.query || uri.fragment) { return; }
        this.reset();
        const generation = this.generation;
        this.path = uri.fsPath;
        this.update = { lines: [], paused: false, status: 'Opening log file…' };
        this.post();
        const tail = new RuntimeLogTail(this.path, (update) => {
            if (this.disposed || generation !== this.generation) { return; }
            this.update = update; this.post();
        });
        this.tail = tail;
        try { await tail.start(); }
        catch (error) {
            if (this.disposed || generation !== this.generation) { return; }
            tail.dispose(); this.tail = undefined;
            this.update = { lines: [], paused: false, status: `Could not open log: ${error instanceof Error ? error.message : String(error)}. Choose a readable regular file.` };
            this.post();
        }
    }

    private async choose(): Promise<void> {
        if (this.choosing || this.disposed || !this.panel) { return; }
        this.choosing = true;
        const generation = this.generation;
        try {
            const selection = await vscode.window.showOpenDialog({ title: 'Follow an FXServer or txAdmin log file',
                canSelectFiles: true, canSelectFolders: false, canSelectMany: false, openLabel: 'Follow log',
                filters: { 'Log files': ['log', 'txt'], 'All files': ['*'] } });
            if (selection?.[0] && !this.disposed && generation === this.generation && this.panel) { await this.select(selection[0]); }
        } finally { this.choosing = false; }
    }

    private async handle(message: unknown): Promise<void> {
        if (this.disposed || !this.panel || !record(message)) { return; }
        if (message.type === 'ready') { this.post(); return; }
        if (message.type === 'chooseFile') { await this.choose(); return; }
        if (message.type === 'togglePause') { this.tail?.setPaused(!this.update.paused); return; }
        if (message.type === 'clear') { this.sourceCancellation?.cancel(); this.tail?.clear(); return; }
        if (message.type !== 'openSource' || typeof message.id !== 'string' || this.opening) { return; }
        const id = message.id;
        const source = this.links.get(id);
        if (!source) { return; }
        const generation = this.generation;
        const cancellation = new vscode.CancellationTokenSource();
        this.sourceCancellation = cancellation;
        this.opening = true;
        const current = () => {
            const entry = this.links.get(id);
            return !this.disposed && generation === this.generation && !cancellation.token.isCancellationRequested
                && entry?.resource === source.resource && entry?.path === source.path && entry?.line === source.line;
        };
        try { await openLogSource(source, this.index.entries, current, cancellation.token); }
        finally {
            this.opening = false; cancellation.dispose();
            if (this.sourceCancellation === cancellation) { this.sourceCancellation = undefined; }
        }
    }

    private post(): void {
        if (this.disposed || !this.panel) { return; }
        this.links.clear();
        const resourceNames = new Set(this.index.entries.map((resource) => resource.name.toLowerCase()));
        const data: RuntimeLogView = { path: this.path, status: this.update.status, paused: this.update.paused, hasFile: !!this.tail,
            lines: this.update.lines.map((line) => ({ ...line,
                links: parseLogSources(line.text).flatMap((source, index) => {
                    if (!validLogSource(source) || !resourceNames.has(source.resource.toLowerCase())) { return []; }
                    const id = `${this.generation}:${line.id}:${index}`;
                    this.links.set(id, source);
                    return [{ start: source.start, end: source.end, id }];
                }),
            })) };
        void this.panel.webview.postMessage({ type: 'state', data });
    }
    private report(error: unknown): void {
        if (!this.disposed && this.panel) { void vscode.window.showErrorMessage(`FiveM Runtime Log: ${error instanceof Error ? error.message : String(error)}`); }
    }
    private reset(): void { ++this.generation; this.tail?.dispose(); this.tail = undefined; this.links.clear(); this.sourceCancellation?.cancel(); }
    dispose(): void { this.disposed = true; this.reset(); this.panel?.dispose(); this.indexSubscription.dispose(); }
}

export class WorkspaceHealthController implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    private session: WorkspaceHealthSession | undefined;
    private disposed = false;
    constructor(private readonly extensionUri: vscode.Uri, private readonly request: WorkspaceHealthRequest) {}

    async show(): Promise<void> {
        if (this.disposed) { return; }
        if (!this.panel) {
            const created = panel(this.extensionUri, 'qbxLua.workspaceHealth', 'FiveM Workspace Health', 'workspaceHealthWebview.js', getWorkspaceHealthHtml);
            this.panel = created;
            const session = new WorkspaceHealthSession(this.request, (message) => {
                if (this.panel === created) { void created.webview.postMessage(message); }
            }, openResourceSource, () => { void vscode.commands.executeCommand('qbxLua.showOutput'); });
            this.session = session;
            const subscriptions = [
                created.webview.onDidReceiveMessage((message: unknown) => {
                    void session.handle(message).catch((error) => {
                        if (this.panel === created) { void vscode.window.showErrorMessage(`Workspace Health: ${error instanceof Error ? error.message : String(error)}`); }
                    });
                }),
                created.onDidDispose(() => {
                    session.dispose(); subscriptions.forEach((item) => item.dispose());
                    if (this.panel === created) { this.panel = undefined; this.session = undefined; }
                }),
            ];
        } else { this.panel.reveal(this.panel.viewColumn); }
        await this.session?.refresh();
    }
    dispose(): void { this.disposed = true; this.session?.dispose(); this.panel?.dispose(); }
}
