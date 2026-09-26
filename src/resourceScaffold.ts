import { constants, type BigIntStats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { createResourcePlan, resourceNameError, type ResourcePlan } from './resourceTemplates';

export interface ResourceDestination {
    readonly folder: vscode.Uri;
    readonly parent: vscode.Uri;
}

export interface ResourceScaffoldOptions {
    /** The destination validated before showing the creation preview. */
    destination?: ResourceDestination;
    signal?: AbortSignal;
}

export type ScaffoldFileSystem = Pick<typeof fs, 'lstat' | 'realpath' | 'mkdir' | 'open' | 'unlink' | 'rmdir'>;
interface Identity { dev: bigint; ino: bigint }
interface DestinationSnapshot { name: string; physicalParent: string; identity: Identity }
interface CreatedFile { file: string; identity: Identity; content: Buffer; complete: boolean; written?: BigIntStats }

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }
function identity(stat: BigIntStats): Identity { return { dev: stat.dev, ino: stat.ino }; }
function sameIdentity(stat: BigIntStats, expected: Identity): boolean { return stat.dev === expected.dev && stat.ino === expected.ino; }
function samePath(a: string, b: string): boolean {
    return process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
}
function contained(parent: string, child: string): boolean {
    const relative = path.relative(parent, child);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function checkCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) {
        const error = new Error('Resource creation was cancelled.');
        error.name = 'AbortError';
        throw error;
    }
}

/** Exclusive creation and identity-checked rollback for the built-in resource templates. */
export class ResourceScaffolder {
    private readonly destinations = new WeakMap<ResourceDestination, DestinationSnapshot>();

    constructor(private readonly io: ScaffoldFileSystem = fs) {}

    async validateResourceDestination(parent: vscode.Uri, name: string): Promise<ResourceDestination> {
        const problem = resourceNameError(name);
        if (problem) { throw new Error(problem); }
        if (parent.scheme !== 'file' || parent.query || parent.fragment) {
            throw new Error('Choose an existing folder on the extension host filesystem.');
        }
        let physicalParent: string;
        let parentStat: BigIntStats | undefined;
        try {
            physicalParent = await this.io.realpath(parent.fsPath);
            parentStat = await this.inspect(physicalParent);
        } catch (error) {
            if (missing(error)) { throw new Error('The destination parent folder no longer exists.'); }
            throw error;
        }
        if (!parentStat?.isDirectory() || parentStat.isSymbolicLink()) {
            throw new Error('Choose an existing directory for the new resource.');
        }
        // Check both the chosen path and its physical target when a folder is reached through a link.
        await this.rejectResourceAncestor(parent.fsPath);
        if (!samePath(parent.fsPath, physicalParent)) { await this.rejectResourceAncestor(physicalParent); }
        const folder = vscode.Uri.joinPath(parent, name);
        if (await this.inspect(path.join(physicalParent, name))) {
            throw new Error(`The destination "${name}" already exists. Choose a new resource name.`);
        }
        const destination = Object.freeze({ parent, folder });
        this.destinations.set(destination, { name, physicalParent, identity: identity(parentStat) });
        return destination;
    }

    async createResourceScaffold(parent: vscode.Uri, plan: ResourcePlan, options: ResourceScaffoldOptions = {}): Promise<{ folder: vscode.Uri; manifest: vscode.Uri }> {
        checkCancelled(options.signal);
        const verifiedPlan = this.verifyPlan(plan);
        const destination = options.destination ?? await this.validateResourceDestination(parent, verifiedPlan.name);
        const snapshot = this.destinations.get(destination);
        if (!snapshot || snapshot.name !== verifiedPlan.name || destination.parent.toString() !== parent.toString()) {
            throw new Error('The resource destination does not match the preview. Choose the destination again.');
        }
        const current = await this.validateResourceDestination(parent, verifiedPlan.name);
        const currentSnapshot = this.destinations.get(current)!;
        if (!samePath(currentSnapshot.physicalParent, snapshot.physicalParent)
            || currentSnapshot.identity.dev !== snapshot.identity.dev || currentSnapshot.identity.ino !== snapshot.identity.ino) {
            throw new Error('The destination folder changed after the preview. Choose the destination again.');
        }
        checkCancelled(options.signal);
        const root = path.join(snapshot.physicalParent, verifiedPlan.name);
        if (!contained(snapshot.physicalParent, root)) { throw new Error('Invalid resource destination.'); }
        const directories = new Map<string, Identity>();
        const files: CreatedFile[] = [];

        const verifyParent = async (checkChosenPath = true) => {
            const real = await this.io.realpath(snapshot.physicalParent);
            const stat = await this.inspect(snapshot.physicalParent);
            if (!samePath(real, snapshot.physicalParent) || !stat?.isDirectory() || stat.isSymbolicLink() || !sameIdentity(stat, snapshot.identity)) {
                throw new Error('The destination parent changed during resource creation.');
            }
            if (checkChosenPath && !samePath(await this.io.realpath(parent.fsPath), snapshot.physicalParent)) {
                throw new Error('The chosen destination changed during resource creation.');
            }
        };
        const verifyOwnedDirectory = async (directory: string, checkChosenPath = true) => {
            await verifyParent(checkChosenPath);
            if (!samePath(directory, root) && !contained(root, directory)) { throw new Error('Invalid generated directory.'); }
            let cursor = directory;
            for (;;) {
                const expected = directories.get(cursor);
                const stat = expected && await this.inspect(cursor);
                if (!expected || !stat?.isDirectory() || stat.isSymbolicLink() || !sameIdentity(stat, expected)) {
                    throw new Error('A generated directory changed during resource creation.');
                }
                if (samePath(cursor, root)) { break; }
                cursor = path.dirname(cursor);
            }
        };

        try {
            await verifyParent();
            checkCancelled(options.signal);
            // No recursive mkdir: an existing file, folder or symlink must win the collision.
            await this.io.mkdir(root);
            const rootStat = await this.inspect(root);
            if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) { throw new Error('The new resource directory changed during creation.'); }
            directories.set(root, identity(rootStat));
            // Publish the manifest last so resource discovery only sees a complete scaffold.
            const ordered = [...verifiedPlan.files].sort((a, b) => Number(a.path === 'fxmanifest.lua') - Number(b.path === 'fxmanifest.lua'));
            for (const planned of ordered) {
                checkCancelled(options.signal);
                const target = path.join(root, ...planned.path.split('/'));
                if (!contained(root, target)) { throw new Error('Invalid generated file path.'); }
                const parentParts = planned.path.split('/').slice(0, -1);
                let directory = root;
                for (const part of parentParts) {
                    const child = path.join(directory, part);
                    if (!directories.has(child)) {
                        await verifyOwnedDirectory(directory);
                        checkCancelled(options.signal);
                        await this.io.mkdir(child);
                        const stat = await this.inspect(child);
                        if (!stat?.isDirectory() || stat.isSymbolicLink()) { throw new Error('A generated directory changed during creation.'); }
                        directories.set(child, identity(stat));
                    }
                    directory = child;
                }
                await verifyOwnedDirectory(directory);
                checkCancelled(options.signal);
                const handle = await this.io.open(target, 'wx+');
                let created: CreatedFile | undefined;
                try {
                    const stat = await handle.stat({ bigint: true });
                    const owned: CreatedFile = { file: target, identity: identity(stat), content: Buffer.from(planned.content, 'utf8'), complete: false };
                    created = owned;
                    files.push(owned);
                    await verifyOwnedDirectory(directory);
                    const live = await this.inspect(target);
                    if (!stat.isFile() || !live?.isFile() || live.isSymbolicLink() || !sameIdentity(live, owned.identity)) {
                        throw new Error('A generated file changed during creation.');
                    }
                    checkCancelled(options.signal);
                    await handle.writeFile(owned.content);
                } finally { await handle.close(); }
                const written = await this.inspect(target);
                if (!created || !written?.isFile() || written.isSymbolicLink() || !sameIdentity(written, created.identity)) {
                    throw new Error('A generated file changed during creation.');
                }
                created.written = written;
                created.complete = true;
            }
            checkCancelled(options.signal);
            await verifyOwnedDirectory(root);
            checkCancelled(options.signal);
            return { folder: destination.folder, manifest: vscode.Uri.joinPath(destination.folder, 'fxmanifest.lua') };
        } catch (error) {
            // Roll back individual, unchanged artifacts. Unknown or edited files keep their directory.
            for (const owned of [...files].reverse()) {
                try {
                    await verifyOwnedDirectory(path.dirname(owned.file), false);
                    const stat = await this.inspect(owned.file);
                    if (!stat?.isFile() || stat.isSymbolicLink() || !sameIdentity(stat, owned.identity)) { continue; }
                    if (stat.size > BigInt(owned.content.length)) { continue; }
                    if (owned.written && (stat.size !== owned.written.size || stat.mtimeNs !== owned.written.mtimeNs || stat.ctimeNs !== owned.written.ctimeNs)) { continue; }
                    const handle = await this.io.open(owned.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
                    let unchanged = false;
                    try {
                        const opened = await handle.stat({ bigint: true });
                        if (!sameIdentity(opened, owned.identity)) { continue; }
                        const content = await handle.readFile();
                        unchanged = owned.complete ? content.equals(owned.content)
                            : content.length <= owned.content.length && content.equals(owned.content.subarray(0, content.length));
                    } finally { await handle.close(); }
                    if (!unchanged) { continue; }
                    await verifyOwnedDirectory(path.dirname(owned.file), false);
                    const beforeDelete = await this.inspect(owned.file);
                    if (beforeDelete?.isFile() && !beforeDelete.isSymbolicLink() && sameIdentity(beforeDelete, owned.identity)
                        && beforeDelete.size === stat.size && beforeDelete.mtimeNs === stat.mtimeNs && beforeDelete.ctimeNs === stat.ctimeNs) {
                        await this.io.unlink(owned.file);
                    }
                } catch { /* A changed, locked or uninspectable path is deliberately preserved. */ }
            }
            for (const directory of [...directories.keys()].reverse()) {
                try {
                    await verifyOwnedDirectory(directory, false);
                    await this.io.rmdir(directory); // Non-recursive: any remaining content protects the directory.
                } catch { /* Never remove content introduced or changed by another actor. */ }
            }
            let remains = false;
            try { remains = directories.size > 0 && !!await this.inspect(root); } catch { remains = directories.size > 0; }
            const message = (error as NodeJS.ErrnoException)?.code === 'EEXIST'
                ? 'A destination path already exists. Existing files were not replaced.'
                : error instanceof Error ? error.message : 'Could not create the resource.';
            const failure = new Error(remains ? `${message} Some generated files were preserved at ${root}; review them before retrying.` : message);
            if (error instanceof Error) { failure.name = error.name; }
            throw failure;
        }
    }

    private verifyPlan(plan: ResourcePlan): ResourcePlan {
        const expected = createResourcePlan({ name: plan.name, templateId: plan.templateId });
        if (plan.files.length !== expected.files.length || plan.files.some((file, index) => file.path !== expected.files[index].path || file.content !== expected.files[index].content)) {
            throw new Error('The resource files no longer match the template preview. Generate a new preview.');
        }
        return expected;
    }

    private async inspect(file: string): Promise<BigIntStats | undefined> {
        try { return await this.io.lstat(file, { bigint: true }); }
        catch (error) { if (missing(error)) { return undefined; } throw error; }
    }

    private async rejectResourceAncestor(directory: string): Promise<void> {
        let cursor = path.resolve(directory);
        for (;;) {
            for (const manifest of ['fxmanifest.lua', '__resource.lua']) {
                if (await this.inspect(path.join(cursor, manifest))) {
                    throw new Error(`Choose a folder outside the existing resource at ${cursor}.`);
                }
            }
            const parent = path.dirname(cursor);
            if (parent === cursor) { return; }
            cursor = parent;
        }
    }
}

const scaffolder = new ResourceScaffolder();
export const validateResourceDestination = (parent: vscode.Uri, name: string): Promise<ResourceDestination> => scaffolder.validateResourceDestination(parent, name);
export const createResourceScaffold = (parent: vscode.Uri, plan: ResourcePlan, options?: ResourceScaffoldOptions): Promise<{ folder: vscode.Uri; manifest: vscode.Uri }> => scaffolder.createResourceScaffold(parent, plan, options);
