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
const FOLDER_SETTLE_MS = 1000;
/** The scan for folders with Lua files waits for the language server to read the workspace first. */
const LUA_SCAN_DELAY_MS = 2000;
const FOLDER_WALK_LIMIT = 20000;

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

function isLua(uri: vscode.Uri): boolean {
    return path.posix.extname(uri.path).toLowerCase() === '.lua';
}

function parentKey(file: vscode.Uri): string {
    return key(vscode.Uri.joinPath(file, '..'));
}

/** Workspace resource membership only; language analysis remains in the language server. */
export class ResourceIndex implements vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<readonly Resource[]>();
    readonly onDidChange = this.changed.event;
    private readonly foldersChanged = new vscode.EventEmitter<void>();
    /**
     * A folder with Lua files appeared, vanished or was renamed inside a root. The language server
     * only watches files by glob, so a resource dropped into or removed from the workspace is
     * invisible to its index unless someone reindexes. Folders without Lua files, such as the build
     * output of an interface, change nothing in that index and are not reported.
     */
    readonly onDidChangeFolders = this.foldersChanged.event;
    readonly ready: Promise<void>;

    private readonly subscriptions: vscode.Disposable[] = [];
    private watchers: vscode.Disposable[] = [];
    private resources: readonly Resource[] = [];
    private refreshTask: Promise<void> | undefined;
    private refreshRequested = false;
    private scanCancellation: vscode.CancellationTokenSource | undefined;
    private refreshTimer: ReturnType<typeof setTimeout> | undefined;
    /** The folders that hold Lua files, once the first scan has listed them. Until then any folder may. */
    private luaFolders: Set<string> | undefined;
    private readonly createdFolders = new Map<string, vscode.Uri>();
    private folderTimer: ReturnType<typeof setTimeout> | undefined;
    private luaScanTimer: ReturnType<typeof setTimeout> | undefined;
    private luaScan: vscode.CancellationTokenSource | undefined;
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
                this.scheduleLuaScan();
            }),
            vscode.workspace.onDidCreateFiles((event) => this.onFileOperation(event.files, [])),
            vscode.workspace.onDidDeleteFiles((event) => this.onFileOperation([], event.files)),
            vscode.workspace.onDidRenameFiles((event) => this.onFileOperation(event.files.map((file) => file.newUri), event.files.map((file) => file.oldUri))),
        );
        this.subscriptions.push(this.foldersChanged);
        this.ready = this.refresh();
        this.scheduleLuaScan();
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

    /**
     * As `resolve`, and for any other file the resource that holds it: an action taken in an editor
     * means the resource of the file it shows. A folder inside a resource still names nothing.
     */
    async owner(uri: vscode.Uri): Promise<Resource | undefined> {
        const exact = await this.resolve(uri);
        if (exact || this.disposed || !this.accepts(uri)) {
            return exact;
        }
        const stat = await this.stat(uri);
        const holder = stat && stat.type & vscode.FileType.File ? this.containing(uri) : undefined;
        return holder && this.resolve(holder.folder);
    }

    /** The resource whose folder holds `uri`, the innermost one where resources are nested. */
    containing(uri: vscode.Uri): Resource | undefined {
        if (this.disposed || !this.accepts(uri)) {
            return undefined;
        }
        return this.resources
            .filter((resource) => contains(resource.folder, uri))
            .sort((a, b) => b.folder.path.length - a.folder.path.length)[0];
    }

    dispose(): void {
        this.disposed = true;
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
        if (this.folderTimer) {
            clearTimeout(this.folderTimer);
        }
        if (this.luaScanTimer) {
            clearTimeout(this.luaScanTimer);
        }
        this.luaScan?.cancel();
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

    /** Explorer operations move whole folders at once; their contents get no file events. */
    private onFileOperation(added: readonly vscode.Uri[], removed: readonly vscode.Uri[]): void {
        const accepted = (uris: readonly vscode.Uri[]) => uris.filter((uri) => this.accepts(uri));
        if (accepted(added).length + accepted(removed).length === 0) {
            return;
        }
        this.scheduleRefresh();
        if (accepted(removed).filter((uri) => this.heldLua(uri)).length > 0) {
            this.foldersChanged.fire();
        }
        for (const uri of accepted(added)) {
            if (!isLua(uri)) {
                this.queueFolderCheck(uri);
            }
        }
    }

    private scheduleLuaScan(): void {
        if (this.luaScanTimer) {
            clearTimeout(this.luaScanTimer);
        }
        this.luaScanTimer = setTimeout(() => {
            this.luaScanTimer = undefined;
            void this.scanLuaFolders().catch(() => {});
        }, LUA_SCAN_DELAY_MS);
    }

    private async scanLuaFolders(): Promise<void> {
        this.luaScan?.cancel();
        const cancellation = new vscode.CancellationTokenSource();
        this.luaScan = cancellation;
        try {
            const files = await Promise.all(this.roots().map((root) =>
                vscode.workspace.findFiles(new vscode.RelativePattern(root, '**/*.lua'), SEARCH_EXCLUDE, undefined, cancellation.token)));
            if (!this.disposed && !cancellation.token.isCancellationRequested) {
                this.luaFolders = new Set(files.flat().map(parentKey));
            }
        } finally {
            cancellation.dispose();
            if (this.luaScan === cancellation) {
                this.luaScan = undefined;
            }
        }
    }

    /**
     * The folders at and below `folder` that hold Lua files, or nothing when there are too many
     * entries to tell. Read in this process: a search process would lock a folder that a build may
     * be about to empty again.
     */
    private async luaFoldersBelow(folder: vscode.Uri): Promise<string[] | undefined> {
        const found: string[] = [];
        const pending = [folder];
        let visited = 0;
        for (let current = pending.pop(); current; current = pending.pop()) {
            const entries = await Promise.resolve(vscode.workspace.fs.readDirectory(current)).catch(() => []);
            visited += entries.length;
            if (visited > FOLDER_WALK_LIMIT) {
                return undefined;
            }
            if (entries.some(([name, type]) => type & vscode.FileType.File && name.toLowerCase().endsWith('.lua'))) {
                found.push(key(current));
            }
            for (const [name, type] of entries) {
                if (type === vscode.FileType.Directory && !EXCLUDED_DIRECTORIES.has(name.toLowerCase())) {
                    pending.push(vscode.Uri.joinPath(current, name));
                }
            }
        }
        return found;
    }

    /** Whether the deleted `uri` was a folder with Lua files below it; those emit no events of their own. */
    private heldLua(uri: vscode.Uri): boolean {
        if (this.resources.some((resource) => contains(uri, resource.folder))) {
            return true;
        }
        if (!this.luaFolders) {
            return !path.posix.extname(uri.path);
        }
        const folder = key(uri);
        let held = false;
        for (const known of this.luaFolders) {
            if (known === folder || known.startsWith(folder + path.sep)) {
                this.luaFolders.delete(known);
                held = true;
            }
        }
        return held;
    }

    private queueFolderCheck(uri: vscode.Uri): void {
        if (this.disposed) {
            return;
        }
        this.createdFolders.set(key(uri), uri);
        if (this.folderTimer) {
            clearTimeout(this.folderTimer);
        }
        this.folderTimer = setTimeout(() => {
            this.folderTimer = undefined;
            void this.checkCreatedFolders().catch(() => {});
        }, FOLDER_SETTLE_MS);
    }

    /** A folder that is moved or copied in may emit no events for its files, so they are looked for once it settles. */
    private async checkCreatedFolders(): Promise<void> {
        const folders = [...this.createdFolders.values()];
        this.createdFolders.clear();
        const outermost = folders.filter((folder) => !folders.some((other) => other !== folder && contains(other, folder)));
        const found = await Promise.all(outermost.map((folder) => this.luaFoldersBelow(folder)));
        if (this.disposed) {
            return;
        }
        // Files written one by one announced themselves, to the language server as well. Only Lua
        // files that arrived without an event of their own, as in a moved folder, need a reindex.
        const unannounced = found.some((folders) => !folders || folders.some((folder) => !this.luaFolders?.has(folder)));
        for (const folder of found.flatMap((folders) => folders ?? [])) {
            this.luaFolders?.add(folder);
        }
        if (unannounced) {
            this.foldersChanged.fire();
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
                }
                if (isLua(uri)) {
                    this.luaFolders?.add(parentKey(uri));
                } else {
                    void this.stat(uri).then((stat) => {
                        if (stat && stat.type & vscode.FileType.Directory) {
                            this.scheduleRefresh();
                            this.queueFolderCheck(uri);
                        }
                    }).catch(() => {});
                }
            }), watcher.onDidDelete((uri) => {
                if (!this.accepts(uri)) {
                    return;
                }
                if (isManifest(uri) || this.resources.some((resource) => contains(uri, resource.folder))) {
                    this.scheduleRefresh();
                }
                if (this.heldLua(uri)) {
                    this.foldersChanged.fire();
                }
            }));
        }
    }
}
