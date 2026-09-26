import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AssetController, validResourceAssets, type AssetResourceIndex } from '../../src/assetBrowser';
import { getAssetHtml } from '../../src/assetHtml';
import { assetContained } from '../../src/assetInventory';
import type { ResourceAssets } from '../../src/assetTypes';
import { ResourceIndex, type Resource } from '../../src/resources';
import { syntheticDds } from './assets';

type Test = [string, () => void | Promise<void>];
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function metadata(folder: vscode.Uri): ResourceAssets {
    const location = { uri: vscode.Uri.joinPath(folder, 'fxmanifest.lua').toString(), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
    return { resource: { name: path.basename(folder.fsPath), uri: folder.toString(), manifestUri: location.uri },
        declarations: [{ kind: 'file', value: 'red.dds', location }], references: [{ kind: 'model', value: 'adder', hash: 3078201489, location }],
        notes: ['Synthetic host integration fixture.'], truncated: { declarations: 0, references: 0 } };
}
function extensionUri(): vscode.Uri {
    const extension = vscode.extensions.getExtension('qbox.qbx-lua');
    assert.ok(extension, 'extension must be installed in the test host'); return extension.extensionUri;
}
function assetTabs(): vscode.Tab[] {
    return vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('qbxLua.assets'));
}
async function temporary(body: (root: vscode.Uri) => Promise<void>): Promise<void> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qbx-assets-host-'));
    try { await body(vscode.Uri.file(root)); }
    finally {
        assert.ok(assetContained(path.resolve(os.tmpdir()), path.resolve(root)) && path.resolve(root) !== path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('qbx-assets-host-'));
        await fs.rm(root, { recursive: true, force: true });
    }
}
async function resource(root: vscode.Uri, name: string): Promise<Resource> {
    const folder = vscode.Uri.joinPath(root, name), manifest = vscode.Uri.joinPath(folder, 'fxmanifest.lua');
    await fs.mkdir(folder.fsPath); await fs.writeFile(manifest.fsPath, "fx_version 'cerulean'\ngame 'gta5'\nfile 'red.dds'\n");
    await fs.writeFile(vscode.Uri.joinPath(folder, 'red.dds').fsPath, syntheticDds());
    return { name, folder, manifest };
}
/** A render acknowledgement travels through the real bundled webview, not a mocked panel API. */
async function expectLoaded(controller: AssetController, folder: vscode.Uri, action: () => Promise<void>): Promise<void> {
    const loaded = deferred<void>();
    const subscription = controller.onDidLoad((uri) => { if (uri === folder.toString()) { loaded.resolve(); } });
    const timeout = setTimeout(() => loaded.reject(new Error('The actual asset webview did not render its snapshot within 10 seconds.')), 10_000);
    try { await Promise.all([action(), loaded.promise]); }
    finally { clearTimeout(timeout); subscription.dispose(); }
}
const tests: Test[] = [
    ['asset source snapshots reject malformed arrays, URI schemes, hashes and locations', () => {
        const valid = metadata(vscode.Uri.file(path.join(os.tmpdir(), 'assets-schema')));
        assert.equal(validResourceAssets(valid), true);
        const clone = (): any => JSON.parse(JSON.stringify(valid));
        for (const alter of [
            (value: any) => { value.resource.uri = 'https://example.invalid/resource'; },
            (value: any) => { value.resource.manifestUri = 'command:malicious'; },
            (value: any) => { value.declarations = {}; },
            (value: any) => { value.declarations[0].value = []; },
            (value: any) => { value.references[0].kind = ['model']; },
            (value: any) => { value.references[0].hash = -1; },
            (value: any) => { value.references[0].hash = 0x100000000; },
            (value: any) => { value.references[0].location.range.start.line = -1; },
            (value: any) => { value.truncated.references = 0.5; },
            (value: any) => { value.notes = new Array(51).fill('note'); },
        ]) { const value = clone(); alter(value); assert.equal(validResourceAssets(value), false); }
        const tooMany = clone(); tooMany.references = new Array(2001).fill(valid.references[0]); assert.equal(validResourceAssets(tooMany), false);
    }],
    ['asset HTML permits only nonce scripts and bounded local media payloads', () => {
        const html = getAssetHtml('vscode-webview-resource://example/asset.js?a="<&', 'safe-nonce');
        assert.match(html, /default-src 'none'/); assert.match(html, /script-src 'nonce-safe-nonce'/);
        assert.match(html, /connect-src 'none'/); assert.match(html, /img-src data:/); assert.match(html, /media-src data:/);
        assert.match(html, /asset\.js\?a=&quot;&lt;&amp;/); assert.doesNotMatch(html, /unsafe-inline|unsafe-eval|<iframe/);
        assert.equal((html.match(/<script\b/g) ?? []).length, 1);
        assert.match(html, /role="listbox"/); assert.match(html, /aria-live="polite"/);
    }],
    ['actual asset browser renders a resource snapshot and reuses its editor tab', async () => temporary(async (root) => {
        const first = await resource(root, 'alpha'), second = await resource(root, 'beta');
        const index = new ResourceIndex([root]); await index.ready;
        const controller = new AssetController(extensionUri(), async (_method, params) => metadata(vscode.Uri.parse(params.uri)), index);
        try {
            await expectLoaded(controller, first.folder, () => controller.show(first.folder));
            assert.equal(assetTabs().length, 1);
            await expectLoaded(controller, second.folder, () => controller.show(second.manifest));
            assert.equal(assetTabs().length, 1); assert.equal(assetTabs()[0].label, 'beta — Assets');
        } finally { controller.dispose(); index.dispose(); }
    })],
    ['late resource resolution cannot replace a newer browser selection', async () => temporary(async (root) => {
        const first = await resource(root, 'old'), second = await resource(root, 'new');
        const pending = deferred<Resource | undefined>(); const entered = deferred<void>();
        const changes = new vscode.EventEmitter<readonly Resource[]>();
        const index: AssetResourceIndex = { ready: Promise.resolve(), entries: [first, second], onDidChange: changes.event,
            resolve: async (uri) => { if (uri.toString() === first.folder.toString()) { entered.resolve(); return pending.promise; } return second; } };
        const requests: string[] = [];
        const controller = new AssetController(extensionUri(), async (_method, params) => { requests.push(params.uri); return metadata(vscode.Uri.parse(params.uri)); }, index);
        try {
            const old = controller.show(first.folder); await entered.promise;
            await expectLoaded(controller, second.folder, () => controller.show(second.folder));
            pending.resolve(first); await old;
            assert.deepEqual(requests, [second.folder.toString()]); assert.equal(assetTabs()[0].label, 'new — Assets');
        } finally { pending.resolve(undefined); controller.dispose(); changes.dispose(); }
    })],
];
export async function runAssetHostTests(): Promise<void> {
    const failures: string[] = [];
    for (const [name, body] of tests) {
        try { await body(); console.log(`  ok   ${name}`); }
        catch (error) { failures.push(name); console.error(`  FAIL ${name}\n${error instanceof Error ? error.stack : String(error)}`); }
    }
    if (failures.length) { throw new Error(`${failures.length} asset host test(s) failed: ${failures.join(', ')}`); }
}
