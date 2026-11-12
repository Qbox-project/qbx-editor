import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { getResourceDetailsHtml } from './resourceDetailsHtml';
import { ResourceDetailsSession } from './resourceDetailsSession';
import type { ResourceDetailsRequest } from './resourceDetailsTypes';
import type { ResourceIndex } from './resources';
import { openResourceSource } from './resourceNavigation';
export { openResourceSource } from './resourceNavigation';

const DETAILS_RESOURCE_KEY = 'qbxLua.resourceDetails.resource';

/** A reusable, read-only panel; its code is loaded only after the details command is invoked. */
export class ResourceDetailsBrowser implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    private session: ResourceDetailsSession | undefined;
    private disposed = false;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly request: ResourceDetailsRequest,
        private readonly chooseResource: () => Promise<string | undefined>,
    ) {}

    async show(uri: string): Promise<void> {
        if (this.disposed) { return; }
        if (!this.panel) {
            this.attach(vscode.window.createWebviewPanel('qbxLua.resourceDetails', 'Resource Details', vscode.ViewColumn.Beside, { retainContextWhenHidden: false }));
        } else { this.panel.reveal(this.panel.viewColumn); }
        await this.session?.show(uri);
    }

    /** Takes over a tab that VS Code restored after a window reload. */
    async restore(panel: vscode.WebviewPanel, uri: string): Promise<void> {
        if (this.disposed || this.panel) { panel.dispose(); return; }
        this.attach(panel);
        await this.session?.show(uri);
    }

    private attach(panel: vscode.WebviewPanel): void {
        {
            panel.webview.options = { enableScripts: true, enableCommandUris: false, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')] };
            this.panel = panel;
            const session = new ResourceDetailsSession(this.request, (message) => {
                if (this.panel !== panel) { return; }
                if (message.type === 'details') { panel.title = `${message.data.resource.name} — Resource Details`; }
                void panel.webview.postMessage(message);
            }, { openSource: openResourceSource, chooseResource: this.chooseResource });
            this.session = session;
            const subscriptions = [
                panel.webview.onDidReceiveMessage((message: unknown) => { void session.handle(message); }),
                panel.onDidDispose(() => {
                    session.dispose();
                    subscriptions.forEach((subscription) => subscription.dispose());
                    if (this.panel === panel) { this.panel = undefined; this.session = undefined; }
                }),
            ];
            const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'resourceDetailsWebview.js'));
            panel.webview.html = getResourceDetailsHtml(script.toString(), randomBytes(16).toString('hex'));
        }
    }

    dispose(): void { this.disposed = true; this.session?.dispose(); this.panel?.dispose(); }
}

/** Shares Explorer's resource membership and watchers instead of starting another scan service. */
export class ResourceDetailsController implements vscode.Disposable {
    private readonly browser: ResourceDetailsBrowser;
    private disposed = false;
    private generation = 0;
    private choosing = false;
    private choiceCancellation: vscode.CancellationTokenSource | undefined;

    constructor(extensionUri: vscode.Uri, request: ResourceDetailsRequest, private readonly index: ResourceIndex, private readonly memento?: vscode.Memento) {
        this.browser = new ResourceDetailsBrowser(extensionUri, request, () => this.chooseResource());
    }

    /** Takes over a tab that VS Code restored after a window reload, for the resource it showed. */
    async restore(panel: vscode.WebviewPanel): Promise<void> {
        await this.index.ready;
        const saved = this.memento?.get<unknown>(DETAILS_RESOURCE_KEY);
        const resource = typeof saved === 'string' ? await this.index.resolve(vscode.Uri.parse(saved)) : undefined;
        if (this.disposed || !resource) { panel.dispose(); return; }
        await this.browser.restore(panel, resource.folder.toString());
    }

    async show(value?: unknown): Promise<void> {
        if (this.disposed || (value !== undefined && !(value instanceof vscode.Uri))) { return; }
        if (this.choosing && value === undefined) { return; }
        this.choiceCancellation?.cancel();
        const generation = ++this.generation;
        try {
            let uri: string | undefined;
            if (value instanceof vscode.Uri) {
                const resource = await this.index.resolve(value);
                if (!resource) {
                    if (!this.disposed && generation === this.generation) {
                        void vscode.window.showInformationMessage('Choose a resource folder containing fxmanifest.lua or __resource.lua.');
                    }
                    return;
                }
                uri = resource.folder.toString();
            } else { uri = await this.chooseResource(); }
            if (uri && !this.disposed && generation === this.generation) {
                void this.memento?.update(DETAILS_RESOURCE_KEY, uri);
                await this.browser.show(uri);
            }
        } catch (error) {
            if (!this.disposed && generation === this.generation) {
                void vscode.window.showErrorMessage(`Resource Details: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    dispose(): void { this.disposed = true; ++this.generation; this.choiceCancellation?.cancel(); this.browser.dispose(); }

    private async chooseResource(): Promise<string | undefined> {
        if (this.disposed || this.choosing) { return undefined; }
        this.choosing = true;
        const cancellation = new vscode.CancellationTokenSource();
        this.choiceCancellation = cancellation;
        try {
            await this.index.ready;
            if (this.disposed || cancellation.token.isCancellationRequested) { return undefined; }
            const items = this.index.entries.map((resource) => ({
                label: resource.name, description: vscode.workspace.asRelativePath(resource.folder, true),
                detail: resource.folder.fsPath, uri: resource.folder.toString(),
            }));
            if (!items.length) {
                void vscode.window.showInformationMessage('Open a workspace containing FiveM resource manifests first.');
                return undefined;
            }
            const selected = await vscode.window.showQuickPick(items, { title: 'FiveM Resource Details', placeHolder: 'Choose a resource', matchOnDescription: true, matchOnDetail: true }, cancellation.token);
            return !this.disposed && !cancellation.token.isCancellationRequested ? selected?.uri : undefined;
        } finally {
            cancellation.dispose();
            if (this.choiceCancellation === cancellation) { this.choiceCancellation = undefined; }
            this.choosing = false;
        }
    }
}
