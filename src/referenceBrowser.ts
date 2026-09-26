import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getReferenceHtml } from './referenceHtml';
import { ReferenceSession } from './referenceSession';
import type { ReferenceDetail, ReferenceRequest } from './referenceTypes';

export { getReferenceHtml } from './referenceHtml';

export interface LuaInsertionTarget {
    readonly document: vscode.TextDocument;
    readonly version: number;
    readonly selection: vscode.Selection;
    readonly viewColumn: vscode.ViewColumn | undefined;
}

/** Retains the last Lua editor while focus moves to the reference webview. */
export class LuaEditorTargetTracker implements vscode.Disposable {
    private editor: vscode.TextEditor | undefined;
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changed.event;
    private readonly subscriptions: vscode.Disposable[];

    constructor() {
        this.remember(vscode.window.activeTextEditor);
        this.subscriptions = [
            vscode.window.onDidChangeActiveTextEditor((editor) => this.remember(editor)),
            vscode.workspace.onDidCloseTextDocument((document) => {
                if (this.editor?.document === document) {
                    this.editor = undefined;
                    this.changed.fire();
                }
            }),
        ];
    }

    capture(): LuaInsertionTarget | undefined {
        const editor = this.editor;
        if (!editor || editor.document.isClosed || editor.document.languageId !== 'lua') {
            return undefined;
        }
        return {
            document: editor.document, version: editor.document.version,
            selection: new vscode.Selection(editor.selection.anchor, editor.selection.active), viewColumn: editor.viewColumn,
        };
    }

    async insert(detail: Pick<ReferenceDetail, 'insertText' | 'insertSnippet'>, target: LuaInsertionTarget | undefined, isCurrent: () => boolean): Promise<void> {
        if (!target) {
            throw new Error('Open a Lua file, place the cursor, then choose Insert again.');
        }
        const valid = () => isCurrent() && !target.document.isClosed
            && target.document.languageId === 'lua' && target.document.version === target.version
            && vscode.workspace.textDocuments.includes(target.document);
        if (!valid()) {
            throw new Error('The target Lua file changed or closed. Return to it and choose Insert again.');
        }
        const editor = await vscode.window.showTextDocument(target.document, {
            viewColumn: target.viewColumn, selection: target.selection, preserveFocus: false,
        });
        if (!valid() || editor.document !== target.document) {
            throw new Error('The target Lua file changed or closed. Choose Insert again.');
        }
        const snippet = detail.insertSnippet
            ? new vscode.SnippetString(detail.insertSnippet)
            : new vscode.SnippetString().appendText(detail.insertText);
        if (!await editor.insertSnippet(snippet, target.selection)) {
            throw new Error('The reference could not be inserted into the selected Lua file.');
        }
    }

    dispose(): void {
        this.subscriptions.forEach((subscription) => subscription.dispose());
        this.changed.dispose();
        this.editor = undefined;
    }

    private remember(editor: vscode.TextEditor | undefined): void {
        if (editor?.document.languageId === 'lua') {
            this.editor = editor;
            this.changed.fire();
        }
    }
}

/** One reusable editor tab, backed by the same language server as Lua editing. */
export class ReferenceBrowser implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    private session: ReferenceSession<LuaInsertionTarget> | undefined;
    private readonly tracker = new LuaEditorTargetTracker();
    private readonly subscriptions: vscode.Disposable[] = [];
    private disposed = false;

    constructor(private readonly extensionUri: vscode.Uri, private readonly request: ReferenceRequest) {
        this.subscriptions.push(this.tracker.onDidChange(() => this.updateTarget()));
    }

    show(): void {
        if (this.disposed) {
            return;
        }
        if (this.panel) {
            this.panel.reveal(this.panel.viewColumn);
            this.updateTarget();
            return;
        }
        const luaColumn = this.tracker.capture()?.viewColumn;
        const column = luaColumn !== undefined ? Math.min(luaColumn + 1, vscode.ViewColumn.Nine) : vscode.ViewColumn.Beside;
        const panel = vscode.window.createWebviewPanel('qbxLua.reference', 'FiveM Reference', column, {
            enableScripts: true,
            enableCommandUris: false,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
            retainContextWhenHidden: false,
        });
        this.panel = panel;
        const session = new ReferenceSession<LuaInsertionTarget>(this.request, (message) => {
            if (this.panel === panel) {
                void panel.webview.postMessage(message);
            }
        }, {
            captureInsertionTarget: () => this.tracker.capture(),
            insert: (detail, target, isCurrent) => this.tracker.insert(detail, target, isCurrent),
            copy: async (text) => { await vscode.env.clipboard.writeText(text); },
            openExternal: async (url) => {
                if (!await vscode.env.openExternal(vscode.Uri.parse(url))) {
                    throw new Error('The documentation link could not be opened.');
                }
            },
        });
        this.session = session;
        const panelSubscriptions = [
            panel.webview.onDidReceiveMessage((message: unknown) => {
                if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'ready') {
                    this.updateTarget();
                } else {
                    void session.handle(message);
                }
            }),
            panel.onDidChangeViewState(() => this.updateTarget()),
            panel.onDidDispose(() => {
                session.dispose();
                panelSubscriptions.forEach((subscription) => subscription.dispose());
                if (this.panel === panel) {
                    this.panel = undefined;
                    this.session = undefined;
                }
            }),
        ];
        const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'referenceWebview.js'));
        panel.webview.html = getReferenceHtml(script.toString(), randomBytes(16).toString('hex'));
    }

    dispose(): void {
        this.disposed = true;
        this.session?.dispose();
        this.panel?.dispose();
        this.tracker.dispose();
        this.subscriptions.forEach((subscription) => subscription.dispose());
    }

    private updateTarget(): void {
        const target = this.tracker.capture();
        const name = target ? target.document.isUntitled
            ? path.basename(target.document.fileName)
            : vscode.workspace.asRelativePath(target.document.uri, true) : undefined;
        void this.panel?.webview.postMessage({ type: 'target', name });
    }
}
