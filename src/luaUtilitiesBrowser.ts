import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { LuaEditorTargetTracker, type LuaInsertionTarget } from './referenceBrowser';
import { getLuaUtilitiesHtml } from './luaUtilitiesHtml';
import { LuaUtilitiesSession, type UtilitySelection } from './luaUtilitiesSession';

/** Created lazily by the command; preserves the selected target until explicitly recaptured. */
export class LuaUtilitiesBrowser implements vscode.Disposable {
    private readonly targetRendered = new vscode.EventEmitter<{ name: string | undefined; canInsert: boolean }>();
    /** Fires only when the current webview confirms it applied the host's captured target. */
    readonly onDidRenderTarget = this.targetRendered.event;
    private panel: vscode.WebviewPanel | undefined;
    private session: LuaUtilitiesSession<LuaInsertionTarget> | undefined;
    private readonly tracker = new LuaEditorTargetTracker();
    private editor = vscode.window.activeTextEditor;
    private readonly changed: vscode.Disposable;
    private disposed = false;

    constructor(private readonly extensionUri: vscode.Uri) {
        this.changed = vscode.window.onDidChangeActiveTextEditor((editor) => { if (editor) { this.editor = editor; } });
    }

    show(): void {
        if (this.disposed) { return; }
        if (this.panel) { this.session?.capture(); this.panel.reveal(this.panel.viewColumn); return; }
        const panel = vscode.window.createWebviewPanel('qbxLua.luaUtilities', 'Lua Utilities', vscode.ViewColumn.Beside, {
            enableScripts: true, enableCommandUris: false, retainContextWhenHidden: false,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
        });
        this.panel = panel;
        let targetRevision = 0;
        let targetName: string | undefined;
        const session = new LuaUtilitiesSession<LuaInsertionTarget>((message) => {
            if (this.panel !== panel) { return; }
            if (message.type === 'target') {
                targetName = message.name;
                void panel.webview.postMessage({ ...message, revision: ++targetRevision });
            } else { void panel.webview.postMessage(message); }
        }, {
            capture: () => this.capture(),
            copy: (text) => Promise.resolve(vscode.env.clipboard.writeText(text)),
            insert: (text, target, current) => this.tracker.insert({ insertText: text }, target, current),
        });
        this.session = session;
        const subscriptions = [
            panel.webview.onDidReceiveMessage((message: unknown) => {
                if (message && typeof message === 'object' && !Array.isArray(message)) {
                    const value = message as Record<string, unknown>;
                    if (value.type === 'targetApplied') {
                        if (!this.disposed && this.panel === panel && value.revision === targetRevision && value.name === targetName && typeof value.canInsert === 'boolean') {
                            this.targetRendered.fire({ name: targetName, canInsert: value.canInsert });
                        }
                        return;
                    }
                }
                void session.handle(message);
            }),
            panel.onDidDispose(() => {
                session.dispose(); subscriptions.forEach((subscription) => subscription.dispose());
                if (this.panel === panel) { this.panel = undefined; this.session = undefined; }
            }),
        ];
        panel.webview.html = getLuaUtilitiesHtml(panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'luaUtilitiesWebview.js')).toString(), randomBytes(16).toString('hex'));
    }

    private capture(): UtilitySelection<LuaInsertionTarget> {
        const target = this.tracker.capture();
        const editor = this.editor;
        const selection = editor && !editor.document.isClosed ? editor.document.getText(editor.selection) : '';
        const name = target ? `${vscode.workspace.asRelativePath(target.document.uri, true)} · line ${target.selection.start.line + 1}${target.selection.isEmpty ? '' : ' · replace selection'}` : undefined;
        return { target, name, selection };
    }

    dispose(): void { this.disposed = true; this.session?.dispose(); this.panel?.dispose(); this.tracker.dispose(); this.changed.dispose(); this.targetRendered.dispose(); }
}
