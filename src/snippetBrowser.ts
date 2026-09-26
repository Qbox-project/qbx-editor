import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { LuaEditorTargetTracker, type LuaInsertionTarget } from './referenceBrowser';
import type { ReferenceRequest } from './referenceTypes';
import { getSnippetHtml } from './snippetHtml';
import { SnippetSession } from './snippetSession';
import { parseSnippetFile, snippetNameError, SnippetStore, type SnippetSource } from './snippetStore';
import type { RecipeSnippet, SnippetCatalog, SnippetWebviewMessage } from './snippetTypes';

type ManageAction = Extract<SnippetWebviewMessage, { type: 'manage' }>['action'];

/** Selection text is literal code, not an invitation to expand snippet variables. */
export function snippetFromSelection(target: LuaInsertionTarget | undefined): string {
    if (!target || target.document.isClosed || target.document.languageId !== 'lua'
        || target.document.version !== target.version || target.selection.isEmpty) {
        throw new Error('Select code in a Lua file, then choose Save Selection as Snippet.');
    }
    const text = target.document.getText(target.selection);
    if (Buffer.byteLength(text, 'utf8') > 128 * 1024) {
        throw new Error('Select at most 128 KiB of Lua code.');
    }
    return new vscode.SnippetString().appendText(text).value;
}

function isServerSnippet(value: unknown): value is { label: string; description: string; body: string; preview: string } {
    if (typeof value !== 'object' || value === null) { return false; }
    const item = value as Record<string, unknown>;
    return typeof item.label === 'string' && item.label.length <= 128
        && typeof item.description === 'string' && item.description.length <= 2048
        && typeof item.body === 'string' && item.body.length <= 128 * 1024
        && typeof item.preview === 'string' && item.preview.length <= 128 * 1024;
}

export class SnippetBrowser implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    private session: SnippetSession<LuaInsertionTarget> | undefined;
    private readonly tracker = new LuaEditorTargetTracker();
    private readonly subscriptions: vscode.Disposable[] = [];
    private library: SnippetStore | undefined;
    private manifests: Promise<RecipeSnippet[]> | undefined;
    private disposed = false;
    private managing = false;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly globalStorageUri: vscode.Uri,
        private readonly request: ReferenceRequest,
    ) {
        this.subscriptions.push(this.tracker.onDidChange(() => {
            this.updateTarget();
            // Only the contextual server recipe can change with the selected Lua file.
            this.session?.invalidate();
        }));
    }

    private get store(): SnippetStore {
        if (!this.library) {
            this.library = new SnippetStore(this.globalStorageUri);
            this.subscriptions.push(this.library.onDidChange(() => this.session?.invalidate()));
        }
        return this.library;
    }

    show(): void {
        if (this.disposed) { return; }
        if (this.panel) {
            this.panel.reveal(this.panel.viewColumn);
            this.updateTarget();
            return;
        }
        const luaColumn = this.tracker.capture()?.viewColumn;
        const column = luaColumn !== undefined ? Math.min(luaColumn + 1, vscode.ViewColumn.Nine) : vscode.ViewColumn.Beside;
        const panel = vscode.window.createWebviewPanel('qbxLua.snippets', 'FiveM Snippets', column, {
            enableScripts: true, enableCommandUris: false,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')], retainContextWhenHidden: false,
        });
        this.panel = panel;
        const session = new SnippetSession<LuaInsertionTarget>(() => this.loadCatalog(), (message) => {
            if (this.panel === panel) { void panel.webview.postMessage(message); }
        }, {
            captureInsertionTarget: () => this.tracker.capture(),
            insert: (item, target, current) => this.tracker.insert({ insertText: item.body, insertSnippet: item.body }, target, current),
            copy: async (text) => { await vscode.env.clipboard.writeText(text); },
            edit: (item, current) => this.interactive(async () => {
                const loaded = await this.store.load();
                const stored = loaded.items.find((candidate) => candidate.id === item.id);
                const source = stored && this.store.sources().find((candidate) => candidate.id === stored.sourceId);
                if (!stored || !source) { throw new Error('This snippet is no longer available. Refresh the browser.'); }
                if (current()) { await this.store.open(source, stored.label); }
            }),
            duplicate: (item, target, current) => this.interactive(() => this.createSnippet(item.body, item.description, target, current, `${item.label} copy`)),
            manage: (action, target, current) => this.interactive(() => this.manage(action, target, current)),
        });
        this.session = session;
        const panelSubscriptions = [
            panel.webview.onDidReceiveMessage((message: unknown) => {
                if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'ready') {
                    this.updateTarget();
                } else { void session.handle(message); }
            }),
            panel.onDidChangeViewState(() => this.updateTarget()),
            panel.onDidDispose(() => {
                session.dispose();
                panelSubscriptions.forEach((subscription) => subscription.dispose());
                if (this.panel === panel) { this.panel = undefined; this.session = undefined; }
            }),
        ];
        const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'snippetWebview.js'));
        panel.webview.html = getSnippetHtml(script.toString(), randomBytes(16).toString('hex'));
    }

    async saveSelection(): Promise<void> {
        const target = this.tracker.capture();
        await this.command(() => this.manage('saveSelection', target, () => !this.disposed));
    }

    async editPersonal(): Promise<void> {
        await this.command(() => this.manage('personal', this.tracker.capture(), () => !this.disposed));
    }

    async editWorkspace(): Promise<void> {
        await this.command(() => this.manage('workspace', this.tracker.capture(), () => !this.disposed));
    }

    dispose(): void {
        this.disposed = true;
        this.session?.dispose();
        this.panel?.dispose();
        this.library?.dispose();
        this.tracker.dispose();
        this.subscriptions.forEach((subscription) => subscription.dispose());
    }

    async loadCatalog(): Promise<SnippetCatalog> {
        const target = this.tracker.capture();
        const params = target?.document.uri.scheme === 'file' ? { uri: target.document.uri.toString() } : null;
        const results = await Promise.allSettled([
            this.request<unknown>('qbx/snippets', params), this.store.load(), this.manifestSnippets(),
        ]);
        const items: RecipeSnippet[] = [];
        const issues: string[] = [];
        const [server, custom, manifest] = results;
        if (server.status === 'fulfilled' && Array.isArray(server.value) && server.value.length <= 1000 && server.value.every(isServerSnippet)) {
            items.push(...server.value.map((item) => ({ ...item, id: `builtin:lua:${encodeURIComponent(item.label)}`,
                prefix: [item.label], source: 'builtin' as const, sourceLabel: 'Built-in · Lua recipes' })));
        } else {
            issues.push(server.status === 'rejected'
                ? `Lua recipes: ${this.errorText(server.reason)}` : 'Lua recipes returned invalid data. Restart the language server and refresh.');
        }
        if (manifest.status === 'fulfilled') { items.push(...manifest.value); }
        else { issues.push(`Manifest recipes: ${this.errorText(manifest.reason)}`); }
        if (custom.status === 'fulfilled') {
            // Source IDs stay in the extension host. Webview actions only submit the opaque snippet ID.
            items.push(...custom.value.items.map(({ sourceId: _sourceId, ...item }) => item));
            issues.push(...custom.value.issues);
        } else { issues.push(`Custom snippets: ${this.errorText(custom.reason)}`); }
        return { items, issues };
    }

    private manifestSnippets(): Promise<RecipeSnippet[]> {
        this.manifests ??= Promise.resolve(vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.extensionUri, 'snippets', 'fxmanifest.json'))).then((bytes) => {
            const parsed = parseSnippetFile(Buffer.from(bytes).toString('utf8'));
            if (parsed.issues.length) { throw new Error(parsed.issues.join(' ')); }
            return parsed.snippets.map((item) => ({
                id: `builtin:manifest:${encodeURIComponent(item.name)}`, label: item.name,
                description: item.description, body: item.body, prefix: item.prefix,
                source: 'builtin' as const, sourceLabel: 'Built-in · Resource manifests',
            }));
        });
        return this.manifests;
    }

    private async manage(action: ManageAction, target: LuaInsertionTarget | undefined, current: () => boolean): Promise<boolean> {
        if (!current()) { return false; }
        if (action === 'new' || action === 'saveSelection') {
            const body = action === 'saveSelection' ? snippetFromSelection(target) : '${1:-- Your Lua code}\n$0';
            return this.createSnippet(body, '', target, current);
        }
        const source = await this.chooseSource(target, action);
        if (!source || !current()) { return false; }
        await this.store.open(source);
        return true;
    }

    private async chooseSource(target: LuaInsertionTarget | undefined, kind?: 'personal' | 'workspace'): Promise<SnippetSource | undefined> {
        const sources = this.store.sources().filter((source) => !kind || source.kind === kind);
        if (sources.length === 0) { throw new Error('Open a workspace folder to save workspace snippets.'); }
        if (sources.length === 1) { return sources[0]; }
        const folder = target && vscode.workspace.getWorkspaceFolder(target.document.uri);
        const preferred = folder && sources.find((source) => source.uri.toString() === vscode.Uri.joinPath(folder.uri, '.vscode', 'qbx-lua-snippets.json').toString());
        const choices = sources.map((source) => ({ label: source.label,
            description: source === preferred ? 'Current Lua workspace' : source.kind === 'personal' ? 'Available across projects' : 'Shared with this workspace folder', source }));
        if (preferred) { choices.sort((a, b) => Number(b.source === preferred) - Number(a.source === preferred)); }
        return (await vscode.window.showQuickPick(choices, { title: 'Choose a snippet library', placeHolder: 'Personal or workspace snippets' }))?.source;
    }

    private async createSnippet(body: string, description: string, target: LuaInsertionTarget | undefined, current: () => boolean, defaultName = ''): Promise<boolean> {
        const source = await this.chooseSource(target);
        if (!source || !current()) { return false; }
        const existing = await this.store.readSource(source);
        if (!current()) { return false; }
        if (existing.issues.length) { throw new Error(`Fix ${source.label} before adding a snippet: ${existing.issues.join(' ')}`); }
        const name = await vscode.window.showInputBox({
            title: 'Name the Lua snippet', prompt: `Save in ${source.label}`, value: defaultName.slice(0, 128), ignoreFocusOut: true,
            validateInput: (value) => {
                const trimmed = value.trim();
                const invalid = snippetNameError(trimmed);
                if (invalid) { return invalid; }
                return existing.items.some((item) => item.label === trimmed) ? 'This name already exists. Choose a different name.' : undefined;
            },
        });
        if (name === undefined || !current()) { return false; }
        await this.store.add(source, name.trim(), body, description);
        if (current()) {
            await this.store.open(source, name.trim());
            this.session?.invalidate();
        }
        return true;
    }

    private async interactive<T>(work: () => Promise<T>): Promise<T> {
        if (this.disposed) { throw new Error('The snippet browser has closed.'); }
        if (this.managing) { throw new Error('Finish the current snippet action first.'); }
        this.managing = true;
        try { return await work(); } finally { this.managing = false; }
    }

    private async command(work: () => Promise<unknown>): Promise<void> {
        try { await this.interactive(work); }
        catch (error) { void vscode.window.showErrorMessage(this.errorText(error)); }
    }

    private updateTarget(): void {
        const target = this.tracker.capture();
        const name = target ? target.document.isUntitled ? path.basename(target.document.fileName)
            : vscode.workspace.asRelativePath(target.document.uri, true) : undefined;
        void this.panel?.webview.postMessage({ type: 'target', name });
    }

    private errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
}
