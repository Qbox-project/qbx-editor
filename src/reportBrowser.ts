import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { getReportHtml } from './reportHtml';
import type { ReportMessage, ReportView } from './reportTypes';

export interface ReportLink { uri: vscode.Uri; line?: number }
export interface ReportContent { view: ReportView; links: Map<string, ReportLink> }
export type ReportBuilder = (status: (text: string) => void, isCurrent: () => boolean) => Promise<ReportContent>;

/** One reusable tab that shows what `build` finds, and runs it again on request. */
export class ReportPanel implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    private generation = 0;
    private last: ReportMessage | undefined;
    private links = new Map<string, ReportLink>();
    private disposed = false;
    private readonly rendered = new vscode.EventEmitter<ReportView>();
    /** Fires with each report handed to the tab. */
    readonly onDidReport = this.rendered.event;

    constructor(private readonly extensionUri: vscode.Uri, private readonly viewType: string, private readonly title: string, private readonly build: ReportBuilder) {}

    get visible(): boolean { return this.panel?.visible === true; }

    async show(): Promise<void> {
        if (this.disposed) { return; }
        if (this.panel) { this.panel.reveal(this.panel.viewColumn); }
        else { this.attach(vscode.window.createWebviewPanel(this.viewType, this.title, vscode.ViewColumn.Beside, { retainContextWhenHidden: false })); }
        await this.refresh();
    }

    /** Takes over a tab that VS Code restored after a window reload. */
    async restore(panel: vscode.WebviewPanel): Promise<void> {
        if (this.disposed || this.panel) { panel.dispose(); return; }
        this.attach(panel);
        await this.refresh();
    }

    async refresh(): Promise<void> {
        if (this.disposed || !this.panel) { return; }
        const generation = ++this.generation;
        const current = () => !this.disposed && generation === this.generation && this.panel !== undefined;
        this.post({ type: 'loading', title: this.title, status: 'Reading files…' });
        try {
            const content = await this.build((status) => { if (current()) { this.post({ type: 'loading', title: this.title, status }); } }, current);
            if (!current()) { return; }
            this.links = content.links;
            this.post({ type: 'report', data: content.view });
            this.rendered.fire(content.view);
        } catch (error) {
            if (current()) { this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
        }
    }

    private attach(panel: vscode.WebviewPanel): void {
        panel.webview.options = { enableScripts: true, enableCommandUris: false, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')] };
        this.panel = panel;
        const subscriptions = [
            panel.webview.onDidReceiveMessage((message: unknown) => {
                if (typeof message !== 'object' || message === null || !('type' in message)) { return; }
                if (message.type === 'ready') { if (this.last) { void panel.webview.postMessage(this.last); } }
                else if (message.type === 'refresh') { void this.refresh(); }
                else if (message.type === 'open' && 'id' in message && typeof message.id === 'string') { void this.open(message.id); }
            }),
            panel.onDidDispose(() => {
                subscriptions.forEach((subscription) => subscription.dispose());
                if (this.panel === panel) { ++this.generation; this.panel = undefined; this.last = undefined; this.links.clear(); }
            }),
        ];
        panel.webview.html = getReportHtml(panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'reportWebview.js')).toString(), randomBytes(16).toString('hex'));
    }

    private async open(id: string): Promise<void> {
        const link = this.links.get(id);
        if (!link) { return; }
        const selection = link.line === undefined ? undefined : new vscode.Range(link.line, 0, link.line, 0);
        try {
            await vscode.commands.executeCommand('vscode.open', link.uri, { viewColumn: vscode.ViewColumn.One, preview: true, selection });
        } catch (error) {
            void vscode.window.showErrorMessage(`Could not open ${link.uri.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private post(message: ReportMessage): void {
        this.last = message;
        void this.panel?.webview.postMessage(message);
    }

    dispose(): void {
        this.disposed = true;
        ++this.generation;
        this.panel?.dispose();
        this.rendered.dispose();
    }
}
