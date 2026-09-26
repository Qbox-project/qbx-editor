import { createHash } from 'node:crypto';
import { parseTree } from 'jsonc-parser';
import * as vscode from 'vscode';
import { addSnippetToText, MAX_SNIPPET_FILE_BYTES, parseSnippetFile } from './snippetFormat';
import type { RecipeSnippet } from './snippetTypes';

export { addSnippetToText, parseSnippetFile, snippetNameError, snippetBodyError, MAX_SNIPPET_FILE_BYTES, MAX_SNIPPET_BODY_BYTES, MAX_SNIPPETS_PER_FILE } from './snippetFormat';

export interface SnippetSource {
    id: string;
    label: string;
    kind: 'personal' | 'workspace';
    uri: vscode.Uri;
}

export interface StoredSnippet extends RecipeSnippet {
    sourceId: string;
}

export interface SnippetSourceContents {
    items: StoredSnippet[];
    issues: string[];
    exists: boolean;
}

const STARTER = '// Lua snippets use VS Code snippet syntax, including ${1:placeholders}.\n// Add named definitions with prefix, description and body.\n{}\n';

function digest(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 24); }
function sameUri(a: vscode.Uri, b: vscode.Uri): boolean { return a.toString() === b.toString(); }
function missing(error: unknown): boolean { return error instanceof vscode.FileSystemError && error.code === 'FileNotFound'; }

/** Personal/workspace JSONC sources. No paths or source URIs are included in library items. */
export class SnippetStore implements vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changed.event;
    private readonly subscriptions: vscode.Disposable[] = [];
    private watchers: vscode.Disposable[] = [];
    private disposed = false;
    private writing = false;
    private changeTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(
        private readonly globalStorageUri: vscode.Uri,
        private readonly workspaceFolders: () => readonly vscode.WorkspaceFolder[] = () => vscode.workspace.workspaceFolders ?? [],
    ) {
        this.watchSources();
        this.subscriptions.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => { this.watchSources(); this.signalChange(); }),
            vscode.workspace.onDidChangeTextDocument((event) => {
                if (this.sources().some((source) => sameUri(source.uri, event.document.uri))) { this.signalChange(); }
            }),
            vscode.workspace.onDidSaveTextDocument((document) => {
                if (this.sources().some((source) => sameUri(source.uri, document.uri))) { this.signalChange(); }
            }),
            vscode.workspace.onDidCloseTextDocument((document) => {
                if (this.sources().some((source) => sameUri(source.uri, document.uri))) { this.signalChange(); }
            }),
        );
    }

    sources(): SnippetSource[] {
        const source = (kind: SnippetSource['kind'], uri: vscode.Uri, label: string): SnippetSource => ({ kind, uri, label, id: `${kind}:${digest(uri.toString())}` });
        return [source('personal', vscode.Uri.joinPath(this.globalStorageUri, 'snippets.json'), 'Personal'),
            ...this.workspaceFolders().map((folder) => source('workspace', vscode.Uri.joinPath(folder.uri, '.vscode', 'qbx-lua-snippets.json'), `Workspace: ${folder.name}`))];
    }

    async load(): Promise<{ items: StoredSnippet[]; issues: string[] }> {
        const loaded = await Promise.all(this.sources().map((source) => this.readSource(source)));
        return { items: loaded.flatMap((result) => result.items), issues: loaded.flatMap((result) => result.issues) };
    }

    async readSource(source: SnippetSource): Promise<SnippetSourceContents> {
        try {
            this.validateSource(source);
            const document = vscode.workspace.textDocuments.find((document) => sameUri(document.uri, source.uri) && !document.isClosed);
            const text = document ? document.getText() : await this.readText(source.uri);
            if (text === undefined) { return { items: [], issues: [], exists: false }; }
            const parsed = parseSnippetFile(text);
            return {
                exists: true,
                issues: parsed.issues.map((issue) => `${source.label}: ${issue}`),
                items: parsed.snippets.map((snippet) => ({
                    id: `${source.id}:${digest(snippet.name)}`, label: snippet.name, description: snippet.description,
                    body: snippet.body, prefix: snippet.prefix, source: source.kind, sourceLabel: source.label, sourceId: source.id,
                })),
            };
        } catch (error) {
            return { exists: true, items: [], issues: [`${source.label}: ${error instanceof Error ? error.message : 'Could not read snippets.'}`] };
        }
    }

    async add(source: SnippetSource, name: string, body: string, description?: string): Promise<void> {
        this.validateSource(source);
        if (this.writing) { throw new Error('Another snippet edit is still in progress. Try again when it finishes.'); }
        this.writing = true;
        try {
            const opened = vscode.workspace.textDocuments.find((document) => sameUri(document.uri, source.uri) && !document.isClosed);
            if (opened?.isDirty) { throw new Error('The snippet file has unsaved changes. Save or revert them before adding a snippet.'); }
            const diskText = await this.readText(source.uri);
            this.validateSource(source);
            if (diskText === undefined) {
                if (opened) { throw new Error('The snippet file was deleted while its editor is still open. Close or save that editor before adding a snippet.'); }
                const addition = addSnippetToText(STARTER, name, body, description);
                await this.create(source, addition.text);
                return;
            }
            const document = await vscode.workspace.openTextDocument(source.uri);
            if (document.isDirty || document.isClosed) { throw new Error('The snippet file has unsaved changes or closed. Save it and try again.'); }
            const version = document.version;
            const original = document.getText();
            if (original !== diskText) { throw new Error('The snippet file changed on disk. Reopen it before adding a snippet.'); }
            const addition = addSnippetToText(original, name, body, description);
            const edit = new vscode.WorkspaceEdit();
            for (const change of addition.edits) {
                edit.replace(source.uri, new vscode.Range(document.positionAt(change.offset), document.positionAt(change.offset + change.length)), change.content);
            }
            this.validateSource(source);
            if (document.isDirty || document.isClosed || document.version !== version) { throw new Error('The snippet file changed while adding a snippet. Try again.'); }
            if (!await vscode.workspace.applyEdit(edit)) { throw new Error('The snippet could not be added. The original file was not replaced.'); }
            if (document.isClosed || document.version !== version + 1 || document.getText() !== addition.text) {
                throw new Error('The snippet file changed during the edit. Review and save the open file yourself.');
            }
            if (!await document.save()) { throw new Error('The snippet was added to the editor but could not be saved. Review and save the open file yourself.'); }
            this.signalChange();
        } finally {
            this.writing = false;
        }
    }

    async open(source: SnippetSource, name?: string): Promise<void> {
        this.validateSource(source);
        const opened = vscode.workspace.textDocuments.find((document) => sameUri(document.uri, source.uri) && !document.isClosed);
        if (!opened && !await this.exists(source.uri)) { await this.create(source, STARTER); }
        this.validateSource(source);
        let document = opened ?? await vscode.workspace.openTextDocument(source.uri);
        if (document.languageId !== 'jsonc') { document = await vscode.languages.setTextDocumentLanguage(document, 'jsonc'); }
        const text = document.getText();
        const tree = name && Buffer.byteLength(text, 'utf8') <= MAX_SNIPPET_FILE_BYTES ? parseTree(text, [], { allowTrailingComma: true }) : undefined;
        const key = tree?.children?.map((entry) => entry.children?.[0]).find((entry) => entry?.value === name);
        const selection = key ? new vscode.Range(document.positionAt(key.offset), document.positionAt(key.offset + key.length)) : undefined;
        await vscode.window.showTextDocument(document, { selection });
    }

    dispose(): void {
        this.disposed = true;
        if (this.changeTimer !== undefined) { clearTimeout(this.changeTimer); this.changeTimer = undefined; }
        this.watchers.forEach((watcher) => watcher.dispose());
        this.subscriptions.forEach((subscription) => subscription.dispose());
        this.changed.dispose();
    }

    private validateSource(source: SnippetSource): void {
        if (this.disposed) { throw new Error('The snippet library is closed. Open it and try again.'); }
        if (!this.sources().some((current) => current.id === source.id && sameUri(current.uri, source.uri))) {
            throw new Error('This snippet source is no longer part of the open workspace.');
        }
    }

    private async readText(uri: vscode.Uri): Promise<string | undefined> {
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            if (!(stat.type & vscode.FileType.File)) { throw new Error('The snippet path is not a file.'); }
            if (stat.size > MAX_SNIPPET_FILE_BYTES) { throw new Error('The snippet file exceeds the 1 MiB limit.'); }
            const bytes = await vscode.workspace.fs.readFile(uri);
            if (bytes.byteLength > MAX_SNIPPET_FILE_BYTES) { throw new Error('The snippet file exceeds the 1 MiB limit.'); }
            return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch (error) {
            if (missing(error)) { return undefined; }
            throw error;
        }
    }

    private async exists(uri: vscode.Uri): Promise<boolean> {
        try { await vscode.workspace.fs.stat(uri); return true; }
        catch (error) { if (missing(error)) { return false; } throw error; }
    }

    private async create(source: SnippetSource, text: string): Promise<void> {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(source.uri, '..'));
        this.validateSource(source);
        if (vscode.workspace.textDocuments.some((document) => sameUri(document.uri, source.uri) && !document.isClosed)) {
            throw new Error('The snippet file already has an open editor. Save or close it before creating the file.');
        }
        const edit = new vscode.WorkspaceEdit();
        edit.createFile(source.uri, { overwrite: false, ignoreIfExists: false, contents: Buffer.from(text, 'utf8') });
        if (!await vscode.workspace.applyEdit(edit)) { throw new Error('The snippet file could not be created without overwriting an existing file. Open it and try again.'); }
        this.watchSources();
        this.signalChange();
    }

    private signalChange(): void {
        if (this.disposed) { return; }
        if (this.changeTimer !== undefined) { clearTimeout(this.changeTimer); }
        this.changeTimer = setTimeout(() => { this.changeTimer = undefined; if (!this.disposed) { this.changed.fire(); } }, 100);
    }

    private watchSources(): void {
        this.watchers.forEach((watcher) => watcher.dispose());
        this.watchers = [];
        for (const source of this.sources()) {
            const filename = source.uri.path.slice(source.uri.path.lastIndexOf('/') + 1);
            const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(source.uri, '..'), filename));
            this.watchers.push(watcher, watcher.onDidCreate(() => this.signalChange()), watcher.onDidChange(() => this.signalChange()), watcher.onDidDelete(() => this.signalChange()));
        }
    }
}
