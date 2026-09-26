import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ResourceIndex } from '../../src/resources';

async function write(uri: vscode.Uri): Promise<void> {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
    // Detection depends only on the file's existence, not valid Lua or a running language server.
    await vscode.workspace.fs.writeFile(uri, Buffer.from('resource detection fixture\n'));
}

async function waitFor(what: string, probe: () => boolean): Promise<void> {
    const started = Date.now();
    while (!probe()) {
        if (Date.now() - started > 15000) {
            throw new Error(`timed out waiting for ${what}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

/** Isolated file-system tests; no server process or resource commands are involved. */
export async function runResourceTests(): Promise<void> {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'qbx-editor-resources-'));
    const base = vscode.Uri.file(temporary);
    const firstRoot = vscode.Uri.joinPath(base, '[resources]');
    const secondRoot = vscode.Uri.joinPath(base, '[second-root]');
    let index: ResourceIndex | undefined;
    let subscription: vscode.Disposable | undefined;
    try {
        const garage = vscode.Uri.joinPath(firstRoot, '[local]', 'garage');
        const otherGarage = vscode.Uri.joinPath(secondRoot, 'garage');
        const legacy = vscode.Uri.joinPath(firstRoot, 'legacy');
        const category = vscode.Uri.joinPath(firstRoot, '[category]');
        await Promise.all([
            write(vscode.Uri.joinPath(garage, 'fxmanifest.lua')),
            write(vscode.Uri.joinPath(garage, '__resource.lua')),
            write(vscode.Uri.joinPath(garage, 'client', 'main.lua')),
            write(vscode.Uri.joinPath(otherGarage, 'fxmanifest.lua')),
            write(vscode.Uri.joinPath(legacy, '__resource.lua')),
            write(vscode.Uri.joinPath(category, 'fxmanifest.lua')),
            ...['node_modules', '.git', 'vendor', '.vscode-test'].map((name) =>
                write(vscode.Uri.joinPath(firstRoot, name, 'hidden', 'fxmanifest.lua'))),
        ]);
        index = new ResourceIndex([firstRoot, secondRoot]);
        await index.ready;
        assert.equal(index.entries.length, 3, 'finds both roots and legacy resources, excluding categories and generated/vendor directories');
        assert.equal(index.entries.filter((resource) => resource.name === 'garage').length, 2, 'duplicate names keep separate folder identities');
        assert.equal((await index.resolve(garage))?.manifest.fsPath, vscode.Uri.joinPath(garage, 'fxmanifest.lua').fsPath, 'modern manifest takes precedence');
        assert.equal((await index.resolve(vscode.Uri.joinPath(garage, '__resource.lua')))?.manifest.fsPath,
            vscode.Uri.joinPath(garage, 'fxmanifest.lua').fsPath, 'either existing manifest resolves to the same canonical resource');
        assert.equal((await index.resolve(legacy))?.manifest.fsPath, vscode.Uri.joinPath(legacy, '__resource.lua').fsPath);
        assert.equal(await index.resolve(vscode.Uri.joinPath(garage, 'client')), undefined, 'nested nonresource folder cannot restart its ancestor');
        assert.equal(await index.resolve(vscode.Uri.joinPath(garage, 'client', 'main.lua')), undefined, 'script file cannot restart its ancestor');
        assert.equal(await index.resolve(vscode.Uri.joinPath(firstRoot, '[local]')), undefined, 'category containing resources is not a resource');
        assert.equal(await index.resolve(category), undefined, 'category remains excluded even when it contains a manifest');
        assert.equal(await index.resolve(vscode.Uri.joinPath(firstRoot, 'vendor', 'hidden')), undefined);
        assert.equal(await index.resolve(vscode.Uri.parse('untitled:fxmanifest.lua')), undefined, 'unsupported schemes are rejected');
        assert.equal(await index.resolve(base), undefined, 'workspace parent is not an action target');
        console.log('  ok   resource discovery handles literal brackets, multiple roots and exact targets');

        let changes = 0;
        subscription = index.onDidChange(() => changes++);
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(garage, 'fxmanifest.lua'));
        assert.equal((await index.resolve(garage))?.manifest.fsPath, vscode.Uri.joinPath(garage, '__resource.lua').fsPath,
            'command resolution revalidates a deleted modern manifest before watcher delivery');
        await waitFor('legacy fallback after deleting modern manifest', () =>
            index!.entries.some((resource) => resource.folder.fsPath === garage.fsPath && resource.manifest.path.endsWith('/__resource.lua')));

        const added = vscode.Uri.joinPath(firstRoot, '[new-category]', 'new_resource');
        await write(vscode.Uri.joinPath(added, 'fxmanifest.lua'));
        await waitFor('new resource discovery', () => index!.entries.some((resource) => resource.folder.fsPath === added.fsPath));

        const renamed = vscode.Uri.joinPath(firstRoot, '[new-category]', 'renamed_resource');
        await vscode.workspace.fs.rename(added, renamed);
        await waitFor('resource folder rename', () =>
            index!.entries.some((resource) => resource.folder.fsPath === renamed.fsPath)
            && !index!.entries.some((resource) => resource.folder.fsPath === added.fsPath));

        await vscode.workspace.fs.delete(renamed, { recursive: true });
        await waitFor('resource folder deletion', () => !index!.entries.some((resource) => resource.folder.fsPath === renamed.fsPath));
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(garage, '__resource.lua'));
        assert.equal(await index.resolve(garage), undefined, 'deleted manifests cannot leave an actionable stale resource');
        await waitFor('last manifest deletion', () => !index!.entries.some((resource) => resource.folder.fsPath === garage.fsPath));
        assert.ok(changes >= 5, 'membership change events follow creation, rename and deletion');
        const stableChanges = changes;
        await index.refresh();
        assert.equal(changes, stableChanges, 'unchanged membership does not fire another event');
        index.dispose();
        await index.refresh();
        assert.equal(await index.resolve(otherGarage), undefined, 'disposed indexes cannot resolve commands');
        console.log('  ok   resource membership follows creates, renames, deletions and disposal');
    } finally {
        subscription?.dispose();
        index?.dispose();
        const cleanupPath = path.resolve(temporary);
        assert.equal(path.dirname(cleanupPath), path.resolve(os.tmpdir()), 'cleanup stays directly inside the temporary directory');
        assert.ok(path.basename(cleanupPath).startsWith('qbx-editor-resources-'), 'cleanup targets only this test fixture');
        await fs.rm(cleanupPath, { recursive: true, force: true });
    }
}
