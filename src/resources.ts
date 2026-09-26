import * as path from 'node:path';
import * as vscode from 'vscode';

export interface Resource {
    readonly folder: vscode.Uri;
    readonly manifest: vscode.Uri;
    readonly name: string;
}

const MANIFESTS = ['fxmanifest.lua', '__resource.lua'] as const;
const EXCLUDED_DIRECTORIES = new Set(['node_modules', '.git', 'vendor', '.vscode-test']);
const SEARCH_EXCLUDE = '**/{node_modules,.git,vendor,.vscode-test}/**';

function key(uri: vscode.Uri): string {
    const normalized = path.resolve(uri.fsPath);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function contains(parent: vscode.Uri, child: vscode.Uri): boolean {
    const relative = path.relative(key(parent), key(child));
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function excluded(uri: vscode.Uri): boolean {
    return uri.path.split('/').some((part) => EXCLUDED_DIRECTORIES.has(part.toLowerCase()));
}

function isManifest(uri: vscode.Uri): boolean {
    return MANIFESTS.some((name) => path.posix.basename(uri.path) === name);
}

/** Workspace resource membership only; language analysis remains in the language server. */
export class ResourceIndex implements vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<readonly Resource[]>();
    readonly onDidChange = this.changed.event;
    readonly ready: Promise<void>;

    private readonly subscriptions: vscode.Disposable[] = [];
    private watchers: vscode.Disposable[] = [];
    private resources: readonly Resource[] = [];
    private refreshTask: Promise<void> | undefined;
    private refreshRequested = false;
    private scanCancellation: vscode.CancellationTokenSource | undefined;
    private refreshTimer: ReturnType<typeof setTimeout> | undefined;
    private disposed = false;

    /** Fixed roots are useful for callers with an isolated workspace, including tests. */
    constructor(private readonly fixedRoots?: readonly vscode.Uri[]) {
        this.createWatchers();
        this.subscriptions.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => {
                if (this.fixedRoots) {
                    return;
                }
                this.createWatchers();
                const remaining = this.resources.filter((resource) => this.accepts(resource.folder));
                if (remaining.length !== this.resources.length) {
                    this.resources = remaining;
                    this.changed.fire(remaining);
                }
                this.refreshRequested = true;
                this.scanCancellation?.cancel();
                this.scheduleRefresh();
            }),
            vscode.workspace.onDidCreateFiles((event) => this.onFileOperation(event.files)),
            vscode.workspace.onDidDeleteFiles((event) => this.onFileOperation(event.files)),
            vscode.workspace.onDidRenameFiles((event) => this.onFileOperation(event.files.flatMap((file) => [file.oldUri, file.newUri]))),
        );
        this.ready = this.refresh();
    }

    get entries(): readonly Resource[] {
        return this.resources;
    }

    /** Rebuild membership without reading or parsing manifest contents. */
    refresh(): Promise<void> {
        if (this.disposed) {
            return Promise.resolve();
        }
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = undefined;
        }
        this.refreshRequested = true;
        if (!this.refreshTask) {
            this.refreshTask = this.scanPending().finally(() => {
                this.refreshTask = undefined;
                // A refresh can arrive after the scan loop returns but before this continuation runs.
                if (this.refreshRequested && !this.disposed) {
                    return this.refresh();
                }
                return undefined;
            });
        }
        return this.refreshTask;
    }

    /** Accept only a resource folder or one of its manifest files, never an enclosing category or a script. */
    async resolve(uri: vscode.Uri): Promise<Resource | undefined> {
        if (this.disposed || !this.accepts(uri)) {
            return undefined;
        }
        const stat = await this.stat(uri);
        if (!stat) {
            return undefined;
        }
        const folder = stat.type & vscode.FileType.Directory
            ? uri
            : stat.type & vscode.FileType.File && isManifest(uri) ? vscode.Uri.joinPath(uri, '..') : undefined;
        return folder ? this.readResource(folder) : undefined;
    }

    dispose(): void {
        this.disposed = true;
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
        this.scanCancellation?.cancel();
        this.watchers.forEach((watcher) => watcher.dispose());
        this.subscriptions.forEach((subscription) => subscription.dispose());
        this.changed.dispose();
    }

    private roots(): readonly vscode.Uri[] {
        const roots = this.fixedRoots ?? vscode.workspace.workspaceFolders?.map((folder) => folder.uri) ?? [];
        return roots.filter((root) => root.scheme === 'file' && !excluded(root));
    }

    private accepts(uri: vscode.Uri): boolean {
        return uri.scheme === 'file' && !excluded(uri) && this.roots().some((root) => contains(root, uri));
    }

    private async stat(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
        try {
            return await vscode.workspace.fs.stat(uri);
        } catch (error) {
            if (error instanceof vscode.FileSystemError && (error.code === 'FileNotFound' || error.code === 'NoPermissions')) {
                return undefined;
            }
            throw error;
        }
    }

    private async readResource(folder: vscode.Uri): Promise<Resource | undefined> {
        const name = path.posix.basename(folder.path);
        if (!this.accepts(folder) || /^\[.*\]$/.test(name)) {
            return undefined;
        }
        for (const filename of MANIFESTS) {
            const manifest = vscode.Uri.joinPath(folder, filename);
            const stat = await this.stat(manifest);
            if (stat && stat.type & vscode.FileType.File) {
                return { folder, manifest, name };
            }
        }
        return undefined;
    }

    private async scanPending(): Promise<void> {
        while (this.refreshRequested && !this.disposed) {
            this.refreshRequested = false;
            const cancellation = new vscode.CancellationTokenSource();
            this.scanCancellation = cancellation;
            try {
                const manifests = await Promise.all(this.roots().map((root) =>
                    // Keep the base URI separate: [category] is a literal path, not a glob character class.
                    vscode.workspace.findFiles(new vscode.RelativePattern(root, '**/{fxmanifest.lua,__resource.lua}'), SEARCH_EXCLUDE, undefined, cancellation.token),
                ));
                if (this.disposed) {
                    return;
                }
                const discovered = new Map<string, Resource>();
                for (const manifest of manifests.flat()) {
                    const folder = vscode.Uri.joinPath(manifest, '..');
                    const name = path.posix.basename(folder.path);
                    if (!this.accepts(folder) || /^\[.*\]$/.test(name)) {
                        continue;
                    }
                    const previous = discovered.get(key(folder));
                    if (!previous || path.posix.basename(manifest.path) === MANIFESTS[0]) {
                        discovered.set(key(folder), { folder, manifest, name });
                    }
                }
                // findFiles already found actual files; only an explicit action needs stat revalidation.
                const next = [...discovered.values()];
                next.sort((a, b) => key(a.folder).localeCompare(key(b.folder)));
                if (!this.refreshRequested && !this.disposed && !this.sameEntries(next)) {
                    this.resources = next;
                    this.changed.fire(this.resources);
                }
            } catch (error) {
                if (!this.disposed && !cancellation.token.isCancellationRequested) {
                    throw error;
                }
            } finally {
                cancellation.dispose();
                this.scanCancellation = undefined;
            }
        }
    }

    private sameEntries(next: readonly Resource[]): boolean {
        return next.length === this.resources.length && next.every((resource, index) =>
            resource.folder.toString() === this.resources[index].folder.toString()
            && resource.manifest.toString() === this.resources[index].manifest.toString(),
        );
    }

    private scheduleRefresh(): void {
        if (this.disposed) {
            return;
        }
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            // Background discovery must not produce an unhandled rejection if a root goes offline.
            void this.refresh().catch(() => {});
        }, 75);
    }

    private onFileOperation(uris: readonly vscode.Uri[]): void {
        if (uris.some((uri) => this.accepts(uri))) {
            this.scheduleRefresh();
        }
    }

    private createWatchers(): void {
        this.watchers.forEach((watcher) => watcher.dispose());
        this.watchers = [];
        for (const root of this.roots()) {
            // Include directory create/delete events: moving or deleting a whole resource may emit only its folder.
            const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**'), false, true, false);
            this.watchers.push(watcher, watcher.onDidCreate((uri) => {
                if (!this.accepts(uri)) {
                    return;
                }
                if (isManifest(uri)) {
                    this.scheduleRefresh();
                } else {
                    void this.stat(uri).then((stat) => {
                        if (stat && stat.type & vscode.FileType.Directory) {
                            this.scheduleRefresh();
                        }
                    }).catch(() => {});
                }
            }), watcher.onDidDelete((uri) => {
                if (this.accepts(uri) && (isManifest(uri) || this.resources.some((resource) => contains(uri, resource.folder)))) {
                    this.scheduleRefresh();
                }
            }));
        }
    }
}
