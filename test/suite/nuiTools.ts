import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { NuiController } from '../../src/nuiBrowser';
import { MAX_NUI_JSON_BYTES, NuiPresetStore, parseNuiJson, validateNuiPreset } from '../../src/nuiPresets';
import { createNuiPreviewServer, type NuiPreviewServer } from '../../src/nuiPreviewServer';
import { validNuiResource } from '../../src/nuiValidation';
import type { NuiPreset, NuiResource } from '../../src/nuiTypes';
import { ResourceIndex } from '../../src/resources';

type Test = [string, () => void | Promise<void>];

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

class MemoryState implements vscode.Memento {
    readonly values = new Map<string, unknown>();
    readonly updates: string[] = [];
    gate: ReturnType<typeof deferred<void>> | undefined;
    failure: Error | undefined;

    keys(): readonly string[] { return [...this.values.keys()]; }
    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    get<T>(key: string, defaultValue?: T): T | undefined {
        return this.values.has(key) ? JSON.parse(JSON.stringify(this.values.get(key))) as T : defaultValue;
    }
    async update(key: string, value: unknown): Promise<void> {
        this.updates.push(key);
        if (this.gate) { await this.gate.promise; }
        if (this.failure) { throw this.failure; }
        if (value === undefined) { this.values.delete(key); }
        else { this.values.set(key, JSON.parse(JSON.stringify(value))); }
    }
}

function preset(name = 'Open menu'): NuiPreset {
    return { name, message: '{ "action": "open", "visible": true }', mocks: '{"getPlayer":{"name":"Example"}}' };
}

function metadata(folder = vscode.Uri.file(path.join(os.tmpdir(), 'nui-validation-fixture', 'alpha'))): NuiResource {
    return {
        resource: { name: path.basename(folder.fsPath), uri: folder.toString(), manifestUri: vscode.Uri.joinPath(folder, 'fxmanifest.lua').toString() },
        uiPage: 'web/index.html', callbacks: [{ name: 'getPlayer', location: {
            uri: vscode.Uri.joinPath(folder, 'client.lua').toString(),
            range: { start: { line: 0, character: 20 }, end: { line: 0, character: 31 } },
        } }], truncated: 0, notes: ['Local metadata fixture.'],
    };
}

function tabs(): vscode.Tab[] {
    return vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) =>
        tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('nuiPreview'));
}

async function waitFor(what: string, probe: () => boolean, timeout = 5000): Promise<void> {
    const start = Date.now();
    while (!probe()) {
        if (Date.now() - start > timeout) { throw new Error(`Timed out waiting for ${what}`); }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

async function temporary(body: (root: vscode.Uri) => Promise<void>): Promise<void> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qbx-nui-tools-'));
    try { await body(vscode.Uri.file(root)); }
    finally {
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('qbx-nui-tools-'));
        await fs.rm(root, { recursive: true, force: true });
    }
}

async function fixtureResource(root: vscode.Uri, name: string): Promise<vscode.Uri> {
    const folder = vscode.Uri.joinPath(root, name);
    await fs.mkdir(vscode.Uri.joinPath(folder, 'web').fsPath, { recursive: true });
    await fs.writeFile(vscode.Uri.joinPath(folder, 'fxmanifest.lua').fsPath, "fx_version 'cerulean'\ngame 'gta5'\nui_page 'web/index.html'\nclient_script 'client.lua'\n");
    await fs.writeFile(vscode.Uri.joinPath(folder, 'client.lua').fsPath, "RegisterNUICallback('getPlayer', function(data, cb) cb({}) end)\n");
    await fs.writeFile(vscode.Uri.joinPath(folder, 'web', 'index.html').fsPath, '<!doctype html><html><head><title>Preview fixture</title></head><body><p>Local preview fixture</p></body></html>');
    return folder;
}

function extensionUri(): vscode.Uri {
    const extension = vscode.extensions.getExtension('qbox.qbx-lua');
    assert.ok(extension, 'extension must be installed in the test host');
    assert.ok(vscode.workspace.isTrusted, 'the integration test workspace must be trusted to run fixture UI scripts');
    return extension.extensionUri;
}

/** Register before show(): the actual iframe bridge, not an HTTP fetch, must acknowledge readiness. */
async function expectPreviewReady(controller: NuiController, folder: vscode.Uri, action: () => Promise<void>): Promise<void> {
    const ready = deferred<void>();
    const subscription = controller.onDidPreviewReady((uri) => { if (uri === folder.toString()) { ready.resolve(); } });
    const timer = setTimeout(() => ready.reject(new Error('The real NUI iframe bridge did not become ready within 10 seconds.')), 10_000);
    try { await Promise.all([action(), ready.promise]); }
    finally { clearTimeout(timer); subscription.dispose(); }
}

const tests: Test[] = [
    ['NUI JSON validation enforces UTF-8 size, depth, node and mock-name bounds', () => {
        assert.deepEqual(parseNuiJson('{"visible":true}'), { visible: true });
        assert.equal(parseNuiJson('null'), null);
        assert.equal((parseNuiJson(JSON.stringify('x'.repeat(MAX_NUI_JSON_BYTES - 2))) as string).length, MAX_NUI_JSON_BYTES - 2);
        assert.throws(() => parseNuiJson(JSON.stringify('x'.repeat(MAX_NUI_JSON_BYTES - 1))), /64 KiB/);
        assert.throws(() => parseNuiJson(JSON.stringify('😀'.repeat(MAX_NUI_JSON_BYTES / 4))), /64 KiB/);
        assert.throws(() => parseNuiJson('{'), /valid JSON/);
        assert.throws(() => parseNuiJson('['.repeat(66) + '0' + ']'.repeat(66)), /nested/);
        assert.throws(() => parseNuiJson(JSON.stringify(Array(10_001).fill(0))), /many values/);
        for (const text of ['null', '[]', 'false', '{"":1}', JSON.stringify({ ['x'.repeat(257)]: 1 }),
            JSON.stringify(Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`cb${i}`, {}])))]) {
            assert.throws(() => parseNuiJson(text, true), /Mock responses/);
        }
        const hostile = parseNuiJson('{"__proto__":{"polluted":true}}', true) as Record<string, unknown>;
        assert.throws(() => parseNuiJson(JSON.stringify({ ['bad\nname']: {} }), true), /Mock responses/);
        assert.ok(Object.hasOwn(hostile, '__proto__'));
        assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
        assert.equal(validateNuiPreset(preset('  Example  ')).name, 'Example');
        for (const name of ['', ' ', 'x'.repeat(81), 'bad\nname', 'bad\0name', 'bad\x7fname']) {
            assert.throws(() => validateNuiPreset(preset(name)), /Preset names/);
        }
    }],
    ['saved NUI presets remain isolated by resource and workspace and survive a new store instance', async () => {
        const state = new MemoryState(); const store = new NuiPresetStore(state);
        const first = 'file:///workspace/alpha'; const second = 'file:///workspace/beta';
        assert.deepEqual(store.load(first), []);
        const original = preset();
        await store.save(first, original); await store.save(second, preset('Other'));
        original.message = '{}';
        assert.equal(new NuiPresetStore(state).load(first)[0].message, preset().message);
        assert.deepEqual(store.load(second).map((entry) => entry.name), ['Other']);
        assert.deepEqual(new NuiPresetStore(new MemoryState()).load(first), []);
        assert.equal(state.keys().length, 2);
        assert.ok(state.keys().every((key) => !key.includes('file:') && !key.includes('workspace/')));
        await store.save(first, { ...preset(), message: '{"replacement":true}' });
        assert.equal(store.load(first).length, 1);
        assert.equal(store.load(first)[0].message, '{"replacement":true}');
        await store.remove(first, 'Open menu');
        assert.deepEqual(store.load(first), []);
        assert.equal(store.load(second).length, 1);
    }],
    ['invalid persisted presets and rejected updates leave saved values unchanged', async () => {
        const state = new MemoryState(); const store = new NuiPresetStore(state); const uri = 'file:///workspace/alpha';
        await store.save(uri, preset());
        const key = state.keys()[0]; const original = JSON.stringify(state.values.get(key));
        const updates = state.updates.length;
        await assert.rejects(store.save(uri, { ...preset(), mocks: '[]' }), /Mock responses/);
        assert.equal(state.updates.length, updates);
        assert.equal(JSON.stringify(state.values.get(key)), original);
        state.failure = new Error('simulated persistence failure');
        await assert.rejects(store.save(uri, preset('Will fail')), /persistence failure/);
        assert.equal(JSON.stringify(state.values.get(key)), original);
        state.failure = undefined;
        await store.save(uri, preset('After recovery'));
        assert.equal(store.load(uri).length, 2, 'failed writes must release the serialization lock');
        for (const invalid of [{ version: 2, presets: [] }, { version: 1, presets: [preset(), preset()] },
            { version: 1, presets: [{ ...preset(), message: '{' }] }]) {
            state.values.set(key, invalid);
            const before = JSON.stringify(invalid); const attempts = state.updates.length;
            assert.throws(() => store.load(uri));
            await assert.rejects(store.save(uri, preset('Replacement')));
            assert.equal(state.updates.length, attempts);
            assert.equal(JSON.stringify(state.values.get(key)), before);
        }
    }],
    ['preset count, aggregate storage and overlapping writes never silently lose data', async () => {
        const state = new MemoryState(); const store = new NuiPresetStore(state); const uri = 'file:///workspace/alpha';
        for (let i = 0; i < 30; i++) { await store.save(uri, { name: `p${String(i).padStart(2, '0')}`, message: '{}', mocks: '{}' }); }
        await assert.rejects(store.save(uri, preset('31st')), /30 presets/);
        assert.equal(store.load(uri).length, 30);
        const largeUri = 'file:///workspace/large';
        for (let i = 0; i < 8; i++) { await store.save(largeUri, { name: `p${i}`, message: JSON.stringify('x'.repeat(60_000)), mocks: '{}' }); }
        await assert.rejects(store.save(largeUri, { name: 'too-large', message: JSON.stringify('x'.repeat(60_000)), mocks: '{}' }), /512 KiB/);
        assert.equal(store.load(largeUri).length, 8);
        const concurrentUri = 'file:///workspace/concurrent';
        state.gate = deferred<void>();
        const saving = store.save(concurrentUri, preset('First'));
        await assert.rejects(store.save(concurrentUri, preset('Second')), /being saved/);
        state.gate.resolve(); await saving; state.gate = undefined;
        await store.save(concurrentUri, preset('Second'));
        assert.deepEqual(store.load(concurrentUri).map((entry) => entry.name), ['First', 'Second']);
    }],
    ['NUI protocol validator rejects malformed, oversized and non-file navigation data', () => {
        const valid = metadata(); assert.equal(validNuiResource(valid), true);
        assert.equal(validNuiResource({ ...valid, uiPage: null }), true);
        assert.equal(validNuiResource({ ...valid, uiPage: 'https://example.invalid/ui' }), true, 'backend metadata may describe unsupported remote pages');
        for (const value of [null, [], {}, { ...valid, truncated: -1 }, { ...valid, truncated: 0.5 },
            { ...valid, uiPage: 'x'.repeat(16385) }, { ...valid, callbacks: Array(501).fill(valid.callbacks[0]) },
            { ...valid, notes: Array(51).fill('note') }, { ...valid, callbacks: [{ ...valid.callbacks[0], name: '' }] },
            { ...valid, resource: { ...valid.resource, uri: 'command:evil' } },
            { ...valid, resource: { ...valid.resource, manifestUri: 'file:///manifest.lua#bad' } },
            { ...valid, callbacks: [{ name: 'a', location: { ...valid.callbacks[0].location, uri: 'https://example.invalid/source' } }] },
            { ...valid, callbacks: [{ name: 'a', location: { ...valid.callbacks[0].location, range: { start: { line: 2, character: 0 }, end: { line: 1, character: 0 } } } }] },
        ]) { assert.equal(validNuiResource(value), false); }
    }],
    ['real NUI iframe bridge loads local UI and the controller reuses its tab', async () => temporary(async (root) => {
        const folder = await fixtureResource(root, 'alpha'); const index = new ResourceIndex([root]); await index.ready;
        assert.equal(index.entries.length, 1);
        const requests: string[] = [];
        const controller = new NuiController(extensionUri(), new MemoryState(), async (method, params) => {
            assert.equal(method, 'qbx/nuiResource'); requests.push(params.uri); return metadata(folder);
        }, index);
        try {
            await expectPreviewReady(controller, folder, () => controller.show(folder));
            assert.equal(tabs().length, 1);
            assert.equal(tabs()[0].label, 'alpha — NUI Preview');
            await controller.show();
            assert.equal(tabs().length, 1); assert.equal(tabs()[0].label, 'alpha — NUI Preview'); assert.equal(requests.length, 1);
            await expectPreviewReady(controller, folder, () => controller.show(vscode.Uri.joinPath(folder, 'fxmanifest.lua')));
            assert.equal(tabs().length, 1); assert.equal(requests.length, 2);
        } finally { controller.dispose(); index.dispose(); await vscode.window.tabGroups.close(tabs(), true); }
    })],
    ['obsolete metadata cannot replace a newer preview, and an invalid selection preserves an active load', async () => temporary(async (root) => {
        const alpha = await fixtureResource(root, 'alpha'); const beta = await fixtureResource(root, 'beta');
        const index = new ResourceIndex([root]); await index.ready;
        const alphaReply = deferred<unknown>(); const calls: string[] = [];
        const controller = new NuiController(extensionUri(), new MemoryState(), async (_method, params) => {
            calls.push(params.uri); return params.uri === alpha.toString() ? alphaReply.promise : metadata(beta);
        }, index);
        try {
            const first = controller.show(alpha); await waitFor('first metadata request', () => calls.length === 1);
            await controller.show(vscode.Uri.joinPath(root, 'missing'));
            await expectPreviewReady(controller, alpha, async () => { alphaReply.resolve(metadata(alpha)); await first; });
            assert.equal(tabs()[0].label, 'alpha — NUI Preview');
        } finally { alphaReply.resolve(metadata(alpha)); controller.dispose(); index.dispose(); await vscode.window.tabGroups.close(tabs(), true); }

        const otherIndex = new ResourceIndex([root]); await otherIndex.ready;
        const late = deferred<unknown>(); let called = false;
        const other = new NuiController(extensionUri(), new MemoryState(), async (_method, params) => {
            if (params.uri === alpha.toString()) { called = true; return late.promise; }
            return metadata(beta);
        }, otherIndex);
        try {
            const stale = other.show(alpha); await waitFor('obsolete metadata request', () => called);
            await expectPreviewReady(other, beta, () => other.show(beta));
            late.resolve(metadata(alpha)); await stale;
            assert.equal(tabs().length, 1); assert.equal(tabs()[0].label, 'beta — NUI Preview');
        } finally { late.resolve(metadata(alpha)); other.dispose(); otherIndex.dispose(); await vscode.window.tabGroups.close(tabs(), true); }
    })],
    ['disposing a controller closes a server that finishes starting after disposal', async () => temporary(async (root) => {
        const folder = await fixtureResource(root, 'alpha'); const index = new ResourceIndex([root]); await index.ready;
        const created = deferred<void>(); const result = deferred<NuiPreviewServer>(); let disposed = 0;
        const factory: typeof createNuiPreviewServer = async (options) => {
            assert.equal(options.root, folder.fsPath); assert.ok(options.bridgeScript.length > 0);
            created.resolve(); return result.promise;
        };
        const controller = new NuiController(extensionUri(), new MemoryState(), async () => metadata(folder), index, factory);
        const pending = controller.show(folder);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([created.promise, new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('Preview server factory was not called.')), 5000);
            })]);
            controller.dispose();
            result.resolve({ url: 'http://127.0.0.1:12345/test/', origin: 'http://127.0.0.1:12345', token: 'test-token', dispose: () => { disposed++; } });
            await pending; assert.equal(disposed, 1);
            await controller.show(folder); assert.equal(disposed, 1);
            await waitFor('disposed NUI tab', () => tabs().length === 0);
        } finally {
            if (timer) { clearTimeout(timer); }
            result.resolve({ url: '', origin: '', token: '', dispose: () => { disposed++; } });
            controller.dispose(); await pending; index.dispose(); await vscode.window.tabGroups.close(tabs(), true);
        }
    })],
    ['NUI preview command appears in the resource menu and reuses and reopens its tab', async () => {
        const extension = vscode.extensions.getExtension('qbox.qbx-lua'); assert.ok(extension); await extension.activate();
        assert.ok((await vscode.commands.getCommands(true)).includes('qbxLua.openNuiPreview'));
        const manifest = extension.packageJSON as { contributes: { menus: Record<string, { command?: string; submenu?: string; when?: string }[]> } };
        assert.ok(manifest.contributes.menus['qbxLua.resources'].some((entry) => entry.command === 'qbxLua.openNuiPreview'));
        const root = vscode.workspace.workspaceFolders?.[0]?.uri; assert.ok(root);
        const folder = vscode.Uri.joinPath(root, 'myresource');
        try {
            await vscode.commands.executeCommand('qbxLua.openNuiPreview', folder);
            await waitFor('command NUI tab', () => tabs().length === 1);
            await vscode.commands.executeCommand('qbxLua.openNuiPreview', vscode.Uri.joinPath(folder, 'fxmanifest.lua'));
            assert.equal(tabs().length, 1);
            await vscode.window.tabGroups.close(tabs(), true); await waitFor('command NUI disposal', () => tabs().length === 0);
            await vscode.commands.executeCommand('qbxLua.openNuiPreview', folder);
            await waitFor('command NUI reopening', () => tabs().length === 1);
        } finally { await vscode.window.tabGroups.close(tabs(), true); }
    }],
];

export async function runNuiToolsTests(): Promise<void> {
    const failures: string[] = [];
    for (const [name, run] of tests) {
        try { await run(); console.log(`  ok   ${name}`); }
        catch (error) { failures.push(name); console.error(`  FAIL ${name}\n${error instanceof Error ? error.stack : String(error)}`); }
    }
    if (failures.length) { throw new Error(`${failures.length} NUI tools tests failed: ${failures.join(', ')}`); }
}
