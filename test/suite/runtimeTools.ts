import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { validLogSource, resolveLogSource, openLogSource, logSourceResources } from '../../src/runtimeLogSources';
import { validWorkspaceHealth, WorkspaceHealthSession, type WorkspaceHealth } from '../../src/workspaceHealthSession';
import { getRuntimeLogHtml } from '../../src/runtimeLogHtml';
import { getWorkspaceHealthHtml } from '../../src/workspaceHealthHtml';
import type { WorkspaceHealthMessage, WorkspaceHealthView } from '../../src/runtimeToolsTypes';
import type { ResourceLocation } from '../../src/resourceDetailsTypes';
import type { Resource } from '../../src/resources';

type Test = [string, () => void | Promise<void>];
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function report(): WorkspaceHealth {
    return { files: 4, resources: 3, counts: { duplicates: 1, missing: 1, ambiguous: 0 }, truncated: 0, notes: ['Indexed snapshot.'], issues: [
        { kind: 'duplicate', name: 'alpha', targets: [
            { name: 'alpha', uri: 'file://server-a/share/alpha', manifestUri: 'file://server-a/share/alpha/fxmanifest.lua' },
            { name: 'alpha', uri: 'file://server-b/share/alpha', manifestUri: 'file://server-b/share/alpha/fxmanifest.lua' },
        ], targetCount: 2, kinds: [] },
        { kind: 'missing', name: 'missing', resource: { name: 'caller', uri: 'file:///workspace/caller', manifestUri: 'file:///workspace/caller/fxmanifest.lua' },
            targets: [], targetCount: 0, kinds: ['dependency', 'import'] },
    ] };
}
function harness() {
    const messages: WorkspaceHealthMessage[] = [];
    const requests: ReturnType<typeof deferred<unknown>>[] = [];
    const opened: ResourceLocation[] = [];
    let outputCalls = 0;
    const state: { gate?: ReturnType<typeof deferred<void>> } = {};
    const session = new WorkspaceHealthSession(async (method, params) => {
        assert.equal(method, 'qbx/workspaceHealth'); assert.deepEqual(params, {});
        const response = deferred<unknown>(); requests.push(response); return response.promise;
    }, (message) => messages.push(message), async (location, current) => {
        if (state.gate) { await state.gate.promise; }
        if (current()) { opened.push(location); }
    }, () => { outputCalls++; });
    return { session, messages, requests, opened, state, outputCalls: () => outputCalls };
}
function latest(h: ReturnType<typeof harness>): WorkspaceHealthView {
    const message = h.messages.at(-1); assert.ok(message?.type === 'health'); return message.data;
}
async function load(h: ReturnType<typeof harness>) {
    const pending = h.session.refresh(); h.requests.at(-1)!.resolve(report()); await pending; return latest(h);
}
function tabs(type: string): vscode.Tab[] {
    return vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) =>
        tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes(type));
}
async function waitFor(what: string, probe: () => boolean): Promise<void> {
    const start = Date.now();
    while (!probe()) {
        if (Date.now() - start > 5000) { throw new Error(`Timed out: ${what}`); }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}
async function temporary<T>(body: (root: string) => Promise<T>): Promise<T> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qbx-runtime-tools-'));
    try { return await body(root); }
    finally {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('qbx-runtime-tools-'));
        await fs.rm(root, { recursive: true, force: true });
    }
}

const tests: Test[] = [
    ['runtime tools HTML restricts scripts and keeps untrusted attributes inert', () => {
        for (const html of [getRuntimeLogHtml, getWorkspaceHealthHtml]) {
            const rendered = html('https://bad.test/\"><script>injected()</script>', 'safe-nonce');
            assert.ok(rendered.includes("default-src 'none'"));
            assert.ok(rendered.includes("script-src 'nonce-safe-nonce'"));
            assert.ok(rendered.includes("connect-src 'none'"));
            assert.ok(!rendered.includes('<script>injected()'));
        }
    }],
    ['health validates bounded snapshots and preserves distinct UNC source paths', async () => {
        assert.equal(validWorkspaceHealth(report()), true);
        for (const invalid of [null, { ...report(), files: -1 }, { ...report(), issues: Array(501).fill(report().issues[0]) },
            { ...report(), issues: [{ ...report().issues[0], targets: [{ name: 'bad', uri: 'command:bad', manifestUri: 'file:///a' }] }] }]) {
            assert.equal(validWorkspaceHealth(invalid), false);
        }
        const h = harness();
        try {
            const view = await load(h);
            assert.notEqual(view.issues[0].targets[0].path, view.issues[0].targets[1].path);
            assert.ok(view.issues[0].targets[0].path.startsWith('//server-a/'));
            await h.session.handle({ type: 'openSource', id: view.issues[0].targets[0].id, uri: 'file:///unrelated' });
            assert.equal(h.opened[0].uri, report().issues[0].targets[0].manifestUri);
            await h.session.handle({ type: 'openSource', id: 'file:///unrelated' });
            await h.session.handle({ type: 'output' });
            assert.equal(h.opened.length, 1); assert.equal(h.outputCalls(), 1);
        } finally { h.session.dispose(); }
    }],
    ['health refresh rejects obsolete successes and failures and revokes previous actions', async () => {
        const h = harness();
        try {
            const old = await load(h);
            const first = h.session.refresh();
            await h.session.handle({ type: 'openSource', id: old.issues[0].targets[0].id });
            const second = h.session.refresh();
            h.requests[2].resolve({ ...report(), files: 99 }); await second;
            h.requests[1].reject(new Error('obsolete')); await first;
            assert.equal(latest(h).files, 99); assert.equal(h.opened.length, 0);
            const bad = h.session.refresh(); h.requests[3].resolve({ bad: true }); await bad;
            assert.equal(latest(h).server.ok, false);
            assert.deepEqual(latest(h).issues, []);
        } finally { h.session.dispose(); }
    }],
    ['health disposal invalidates pending source navigation, requests and messages', async () => {
        const h = harness();
        const view = await load(h);
        h.state.gate = deferred<void>();
        const opening = h.session.handle({ type: 'openSource', id: view.issues[0].targets[0].id });
        const pending = h.session.refresh();
        h.session.dispose();
        h.state.gate.resolve(); h.requests[1].resolve(report());
        const count = h.messages.length;
        await Promise.all([opening, pending]);
        await h.session.handle({ type: 'ready' }); await h.session.handle({ type: 'output' });
        assert.equal(h.messages.length, count); assert.equal(h.opened.length, 0); assert.equal(h.outputCalls(), 0);
    }],
    ['Lua log source resolution stays inside the chosen resource including directory links', async () => temporary(async (root) => {
        const folder = path.join(root, 'alpha'); const external = path.join(root, 'external');
        await fs.mkdir(path.join(folder, 'server'), { recursive: true }); await fs.mkdir(external);
        await fs.writeFile(path.join(folder, 'server', 'main.lua'), 'print("safe")\n');
        await fs.writeFile(path.join(external, 'outside.lua'), 'print("outside")\n');
        await fs.symlink(external, path.join(folder, 'jump'), process.platform === 'win32' ? 'junction' : 'dir');
        const resource: Resource = { name: 'alpha', folder: vscode.Uri.file(folder), manifest: vscode.Uri.file(path.join(folder, 'fxmanifest.lua')) };
        const source = { resource: 'alpha', path: 'server/main.lua', line: 1 };
        assert.equal((await resolveLogSource(source, resource))?.fsPath, vscode.Uri.file(await fs.realpath(path.join(folder, 'server', 'main.lua'))).fsPath);
        assert.equal(await resolveLogSource({ ...source, path: 'jump/outside.lua' }, resource), undefined);
        assert.equal(await resolveLogSource({ ...source, path: 'missing.lua' }, resource), undefined);
        assert.equal(logSourceResources(source, [resource, { ...resource, folder: vscode.Uri.file(external) }]).length, 2);
        for (const candidate of ['../external/outside.lua', '/server/main.lua', 'C:\\server.lua', 'server/../main.lua', 'server/main.txt', 'server/main.lua:stream']) {
            assert.equal(validLogSource({ ...source, path: candidate }), false, candidate);
            assert.equal(await resolveLogSource({ ...source, path: candidate }, resource), undefined);
        }
        assert.equal(validLogSource({ ...source, line: 0 }), false);
        assert.equal(validLogSource({ ...source, line: Number.MAX_SAFE_INTEGER }), false);
    })],
    ['Lua log traces open the requested editor line and honor cancellation', async () => {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri; assert.ok(root);
        const folder = vscode.Uri.joinPath(root, 'myresource');
        const resource: Resource = { name: 'myresource', folder, manifest: vscode.Uri.joinPath(folder, 'fxmanifest.lua') };
        await openLogSource({ resource: 'myresource', path: 'server/main.lua', line: 2 }, [resource], () => true);
        const editor = vscode.window.activeTextEditor; assert.ok(editor);
        assert.ok(editor.document.uri.fsPath.endsWith(path.join('myresource', 'server', 'main.lua')));
        assert.equal(editor.selection.start.line, 1);
        await openLogSource({ resource: 'myresource', path: 'client/main.lua', line: 2 }, [resource], () => false);
        assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), editor.document.uri.toString());
    }],
    ['runtime log and workspace health commands reuse tabs and reopen after disposal', async () => temporary(async (root) => {
        const extension = vscode.extensions.getExtension('qbox.qbx-lua'); assert.ok(extension); await extension.activate();
        const uri = vscode.Uri.file(path.join(root, 'server.log')); await fs.writeFile(uri.fsPath, 'SCRIPT ERROR: @myresource/server/main.lua:2: example\n');
        try {
            await vscode.commands.executeCommand('qbxLua.openRuntimeLog', uri);
            await vscode.commands.executeCommand('qbxLua.workspaceHealth');
            await waitFor('runtime tools tabs', () => tabs('runtimeLog').length === 1 && tabs('workspaceHealth').length === 1);
            await vscode.commands.executeCommand('qbxLua.openRuntimeLog', uri);
            await vscode.commands.executeCommand('qbxLua.workspaceHealth');
            assert.equal(tabs('runtimeLog').length, 1); assert.equal(tabs('workspaceHealth').length, 1);
            await vscode.window.tabGroups.close([...tabs('runtimeLog'), ...tabs('workspaceHealth')], true);
            await waitFor('runtime tools disposal', () => tabs('runtimeLog').length === 0 && tabs('workspaceHealth').length === 0);
            await vscode.commands.executeCommand('qbxLua.openRuntimeLog', uri);
            await vscode.commands.executeCommand('qbxLua.workspaceHealth');
            await waitFor('runtime tools reopening', () => tabs('runtimeLog').length === 1 && tabs('workspaceHealth').length === 1);
        } finally { await vscode.window.tabGroups.close([...tabs('runtimeLog'), ...tabs('workspaceHealth')], true); }
    })],
];

export async function runRuntimeToolsTests(): Promise<void> {
    const failures: string[] = [];
    for (const [name, run] of tests) {
        try { await run(); console.log(`  ok   ${name}`); }
        catch (error) { failures.push(name); console.error(`  FAIL ${name}\n${error instanceof Error ? error.stack : String(error)}`); }
    }
    if (failures.length) { throw new Error(`${failures.length} runtime tools tests failed: ${failures.join(', ')}`); }
}
