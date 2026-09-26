import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CloseAction, ErrorAction, LanguageClient } from 'vscode-languageclient/node';
import { openResourceSource } from '../../src/resourceDetailsBrowser';
import { getResourceDetailsHtml } from '../../src/resourceDetailsHtml';
import { ResourceDetailsSession } from '../../src/resourceDetailsSession';
import { validWorkspaceHealth } from '../../src/workspaceHealthSession';
import { validNuiResource } from '../../src/nuiValidation';
import type { ResourceDetails, ResourceDetailsMessage, ResourceDetailsView, ResourceIdentity, ResourceLocation } from '../../src/resourceDetailsTypes';

type Test = [name: string, body: () => void | Promise<void>];

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

async function processDeadline<T>(completion: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([completion, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('The Resource Details test server did not close within 5 seconds.')), 5000);
        })]);
    } finally { if (timer) { clearTimeout(timer); } }
}

function identity(name: string): ResourceIdentity {
    const uri = vscode.Uri.file(path.join(process.cwd(), 'details-fixture', name));
    return { name, uri: uri.toString(), manifestUri: vscode.Uri.joinPath(uri, 'fxmanifest.lua').toString() };
}

const alpha = identity('alpha');
const beta = identity('beta');
const eventLocation: ResourceLocation = {
    uri: vscode.Uri.joinPath(vscode.Uri.parse(alpha.uri), 'server.lua').toString(),
    range: { start: { line: 2, character: 17 }, end: { line: 2, character: 29 } },
};

function details(resource = alpha): ResourceDetails {
    const source = { ...eventLocation, uri: vscode.Uri.joinPath(vscode.Uri.parse(resource.uri), 'server.lua').toString() };
    return {
        resource,
        files: { total: 4, client: 1, server: 2, shared: 1, module: 0 },
        counts: { events: 1, exports: 1 },
        events: [{ name: 'alpha:ready', kind: 'netEvent', side: 'server', location: source, signature: '(value: string)' }],
        exports: [{ name: 'GetValue', kind: 'export', side: 'server', location: { ...source, range: { start: { line: 4, character: 8 }, end: { line: 4, character: 18 } } } }],
        dependencies: [{ name: beta.name, kinds: ['dependency', 'import'], status: 'resolved', targets: [beta], targetCount: 1 }],
        dependents: [], constraints: ['/server:7290'], notes: ['Static index snapshot.'],
        truncated: { events: 0, exports: 0, dependencies: 0, dependents: 0 },
    };
}

function harness() {
    const requests: { method: string; params: { uri: string }; response: ReturnType<typeof deferred<unknown>> }[] = [];
    const messages: ResourceDetailsMessage[] = [];
    const opened: ResourceLocation[] = [];
    const choices: ReturnType<typeof deferred<string | undefined>>[] = [];
    const state: { gate?: ReturnType<typeof deferred<void>>; openError?: Error } = {};
    const session = new ResourceDetailsSession(async (method, params) => {
        const response = deferred<unknown>();
        requests.push({ method, params, response });
        return response.promise;
    }, (message) => messages.push(message), {
        openSource: async (location, isCurrent) => {
            if (state.gate) { await state.gate.promise; }
            if (state.openError) { throw state.openError; }
            if (isCurrent()) { opened.push(location); }
        },
        chooseResource: async () => {
            const choice = deferred<string | undefined>();
            choices.push(choice);
            return choice.promise;
        },
    });
    return { session, requests, messages, opened, choices, state };
}

function latestView(h: ReturnType<typeof harness>): ResourceDetailsView {
    const message = h.messages.filter((value) => value.type === 'details').at(-1);
    assert.ok(message?.type === 'details', 'the validated snapshot should reach the webview');
    return message.data;
}

async function load(h: ReturnType<typeof harness>, value = details()): Promise<ResourceDetailsView> {
    const loading = h.session.show(value.resource.uri);
    h.requests.at(-1)!.response.resolve(value);
    await loading;
    return latestView(h);
}

function workspaceFile(relative: string): vscode.Uri {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'the fixture workspace should be open');
    return vscode.Uri.file(path.join(folder.uri.fsPath, relative));
}

function assertSameFile(actual: string | vscode.Uri | undefined, expected: vscode.Uri): void {
    assert.ok(actual, 'a file URI should be present');
    const uri = typeof actual === 'string' ? vscode.Uri.parse(actual) : actual;
    assert.equal(uri.scheme, 'file');
    const normalized = (value: vscode.Uri): string => {
        const resolved = path.resolve(value.fsPath);
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    assert.equal(normalized(uri), normalized(expected));
}

async function waitFor<T>(label: string, probe: () => T | undefined, timeout = 10000): Promise<T> {
    const started = Date.now();
    for (;;) {
        const value = probe();
        if (value !== undefined) { return value; }
        if (Date.now() - started >= timeout) { throw new Error(`Timed out waiting for ${label}`); }
        await new Promise((resolve) => setTimeout(resolve, 30));
    }
}

function tabs(viewType?: string): vscode.Tab[] {
    return vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) =>
        tab.input instanceof vscode.TabInputWebview && (viewType === undefined || tab.input.viewType === viewType));
}

const tests: Test[] = [
    ['Resource Details HTML restricts scripts and escapes resource attributes', () => {
        const html = getResourceDetailsHtml('https://local.test/script.js?x="><script>alert(1)</script>', 'details-nonce');
        assert.match(html, /default-src 'none'/);
        assert.match(html, /script-src 'nonce-details-nonce'/);
        assert.match(html, /style-src 'nonce-details-nonce'/);
        assert.match(html, /connect-src 'none'/);
        assert.equal((html.match(/<script\b/g) ?? []).length, 1);
        assert.match(html, /&quot;&gt;&lt;script&gt;/);
        assert.doesNotMatch(html, /unsafe-inline|unsafe-eval|<iframe\b/);
    }],
    ['source and dependency actions use only host-issued IDs and authoritative locations', async () => {
        const h = harness();
        try {
            const view = await load(h);
            assert.deepEqual(h.requests[0], { method: 'qbx/resourceDetails', params: { uri: alpha.uri }, response: h.requests[0].response });
            assert.equal(view.events[0].name, 'alpha:ready');
            assert.ok(view.events[0].id);
            assert.equal('location' in view.events[0], false, 'the source action authority stays in the host');
            assert.equal('uri' in view.dependencies[0].targets[0], false);
            await h.session.handle({ type: 'openSource', id: view.events[0].id, uri: 'command:evil', range: { start: 999 } });
            assert.deepEqual(h.opened, [eventLocation]);
            await h.session.handle({ type: 'openSource', id: view.resource.manifestId });
            assert.equal(h.opened.at(-1)?.uri, alpha.manifestUri);
            const navigate = h.session.handle({ type: 'openResource', id: view.dependencies[0].targets[0].id, uri: 'file:///private' });
            assert.deepEqual(h.requests.at(-1)?.params, { uri: beta.uri });
            h.requests.at(-1)!.response.resolve(details(beta));
            await navigate;
            assert.equal(latestView(h).resource.name, beta.name);
        } finally { h.session.dispose(); }
    }],
    ['malformed messages and arbitrary source or resource IDs cannot invoke actions', async () => {
        const h = harness();
        try {
            for (const message of [null, [], 'refresh', {}, { type: ['choose'] }, { type: 'executeCommand' },
                { type: 'openSource', id: 'file:///secret' }, { type: 'openResource', id: alpha.uri }]) {
                await h.session.handle(message);
            }
            assert.equal(h.requests.length, 0);
            assert.equal(h.choices.length, 0);
            const view = await load(h);
            for (const message of [
                { type: 'openSource', id: [] }, { type: 'openSource', id: 0 },
                { type: 'openSource', id: 'command:workbench.action.closeWindow' },
                { type: 'openResource', id: 'https://example.test' },
                { type: 'openResource', id: view.events[0].id },
                { type: 'openSource', id: view.dependencies[0].targets[0].id },
            ]) { await h.session.handle(message); }
            assert.deepEqual(h.opened, []);
            assert.equal(h.requests.length, 1);
        } finally { h.session.dispose(); }
    }],
    ['invalid backend snapshots and failed refreshes revoke source actions', async () => {
        const h = harness();
        try {
            const malformed: unknown[] = [
                null,
                { ...details(), files: { ...details().files, total: -1 } },
                { ...details(), resource: { ...alpha, manifestUri: 'command:evil' } },
                { ...details(), events: [{ ...details().events[0], location: { ...eventLocation, uri: 'https://example.test' } }] },
                { ...details(), events: [{ ...details().events[0], location: { ...eventLocation, range: { start: { line: -1, character: 0 }, end: { line: 0, character: 1 } } } }] },
                { ...details(), dependencies: [{ ...details().dependencies[0], status: ['resolved'] }] },
            ];
            for (const value of malformed) {
                const old = await load(h);
                const before = h.messages.length;
                const refresh = h.session.handle({ type: 'refresh' });
                h.requests.at(-1)!.response.resolve(value);
                await refresh;
                assert.ok(h.messages.slice(before).some((message) => message.type === 'error'));
                await h.session.handle({ type: 'openSource', id: old.events[0].id });
            }
            const old = await load(h);
            const refresh = h.session.handle({ type: 'refresh' });
            h.requests.at(-1)!.response.reject(new Error('Server restarting'));
            await refresh;
            assert.ok(h.messages.some((message) => message.type === 'error' && message.message.includes('Server restarting')));
            await h.session.handle({ type: 'openSource', id: old.events[0].id });
            assert.deepEqual(h.opened, []);
        } finally { h.session.dispose(); }
    }],
    ['resource switches ignore late successes and failures and invalidate prior IDs immediately', async () => {
        const h = harness();
        try {
            const old = await load(h);
            const first = h.session.show(alpha.uri);
            const firstRequest = h.requests.at(-1)!;
            await h.session.handle({ type: 'openSource', id: old.events[0].id });
            const second = h.session.show(beta.uri);
            h.requests.at(-1)!.response.resolve(details(beta));
            await second;
            const current = latestView(h);
            firstRequest.response.resolve(details());
            await first;
            assert.equal(latestView(h), current, 'an older successful load must not replace the selected resource');
            assert.deepEqual(h.opened, []);
            await h.session.handle({ type: 'openSource', id: old.events[0].id });
            assert.deepEqual(h.opened, []);
            const staleFailure = h.session.show(alpha.uri);
            const failedRequest = h.requests.at(-1)!;
            const fresh = h.session.show(beta.uri);
            h.requests.at(-1)!.response.resolve(details(beta));
            await fresh;
            const length = h.messages.length;
            failedRequest.response.reject(new Error('Old failure'));
            await staleFailure;
            assert.equal(h.messages.length, length, 'a late error cannot replace a current result');
            await h.session.handle({ type: 'ready' });
            assert.equal(latestView(h).resource.name, beta.name);
            assert.equal(h.requests.length, 5, 'ready resends the current snapshot without another server request');
        } finally { h.session.dispose(); }
    }],
    ['pending navigation checks current selection and disposal after asynchronous work', async () => {
        const h = harness();
        try {
            const view = await load(h);
            h.state.gate = deferred<void>();
            const opening = h.session.handle({ type: 'openSource', id: view.events[0].id });
            const switchResource = h.session.show(beta.uri);
            h.requests.at(-1)!.response.resolve(details(beta));
            await switchResource;
            h.state.gate.resolve();
            await opening;
            assert.deepEqual(h.opened, []);
            const current = latestView(h);
            h.state.gate = deferred<void>();
            const secondOpening = h.session.handle({ type: 'openSource', id: current.events[0].id });
            h.session.dispose();
            const length = h.messages.length;
            h.state.gate.resolve();
            await secondOpening;
            assert.deepEqual(h.opened, []);
            await h.session.handle({ type: 'refresh' });
            await h.session.handle({ type: 'choose' });
            assert.equal(h.messages.length, length);
            assert.equal(h.requests.length, 2);
            assert.equal(h.choices.length, 0);
        } finally { h.session.dispose(); }
    }],
    ['resource picker cancellation and obsolete picker results preserve the current resource', async () => {
        const h = harness();
        try {
            await load(h);
            const cancelled = h.session.handle({ type: 'choose' });
            h.choices.at(-1)!.resolve(undefined);
            await cancelled;
            assert.equal(h.requests.length, 1);
            assert.equal(latestView(h).resource.name, alpha.name);
            const choosing = h.session.handle({ type: 'choose' });
            const selected = h.session.show(beta.uri);
            h.requests.at(-1)!.response.resolve(details(beta));
            await selected;
            h.choices.at(-1)!.resolve(alpha.uri);
            await choosing;
            assert.equal(h.requests.length, 2, 'an old picker cannot reopen a resource after another selection');
            assert.equal(latestView(h).resource.name, beta.name);
            h.state.openError = new Error('File was deleted');
            await h.session.handle({ type: 'openSource', id: latestView(h).events[0].id });
            assert.ok(h.messages.some((message) => message.type === 'error' && message.message.includes('File was deleted')));
        } finally { h.session.dispose(); }
    }],
    ['disposed sessions ignore pending loads and subsequent messages', async () => {
        const h = harness();
        const loading = h.session.show(alpha.uri);
        h.session.dispose();
        const length = h.messages.length;
        h.requests[0].response.resolve(details());
        await loading;
        await h.session.show(beta.uri);
        await h.session.handle({ type: 'ready' });
        assert.equal(h.messages.length, length);
        assert.equal(h.requests.length, 1);
    }],
    ['source navigation opens the requested local range and refuses cancelled or non-file targets', async () => {
        const uri = workspaceFile('myresource/server/main.lua');
        const location: ResourceLocation = { uri: uri.toString(), range: { start: { line: 0, character: 18 }, end: { line: 0, character: 40 } } };
        await openResourceSource(location, () => true);
        const editor = vscode.window.activeTextEditor;
        assert.ok(editor);
        assertSameFile(editor.document.uri, uri);
        assert.deepEqual([editor.selection.start.line, editor.selection.start.character, editor.selection.end.line, editor.selection.end.character], [0, 18, 0, 40]);
        await openResourceSource({ ...location, uri: workspaceFile('shop/server.lua').toString() }, () => false);
        assertSameFile(vscode.window.activeTextEditor?.document.uri, uri);
        await openResourceSource({ ...location, uri: 'command:workbench.action.closeWindow' }, () => true);
        assertSameFile(vscode.window.activeTextEditor?.document.uri, uri);
    }],
    ['packaged language server details flow through the session with real dependencies and source ranges', async () => {
        const extension = vscode.extensions.getExtension('qbox.qbx-lua');
        assert.ok(extension);
        const configured = vscode.workspace.getConfiguration('qbxLua').get<string>('server.path', '').trim();
        const binary = process.platform === 'win32' ? 'qbx-lua-ls.exe' : 'qbx-lua-ls';
        const candidates = [
            path.join(extension.extensionPath, 'server', `${process.platform}-${process.arch}`, binary),
            path.join(extension.extensionPath, '..', 'qbx-lua-ls', 'target', 'release', binary),
            path.join(extension.extensionPath, '..', 'qbx-lua-ls', 'target', 'debug', binary),
        ];
        const command = configured || candidates.find((candidate) => fs.existsSync(candidate));
        assert.ok(command, 'the integration suite requires the built language server');
        const output = vscode.window.createOutputChannel('Resource Details Test Server');
        let server: ReturnType<typeof spawn> | undefined;
        let serverClosed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
        let hasClosed = false;
        const client = new LanguageClient('qbxResourceDetailsTest', 'Resource Details Test Server', async () => {
            const child = spawn(command, [], { windowsHide: true, stdio: 'pipe' });
            server = child;
            // close follows exit and drained stdio, so no client logger can still use the channel.
            serverClosed = new Promise((resolve) => child.once('close', (code, signal) => {
                hasClosed = true;
                resolve({ code, signal });
            }));
            await new Promise<void>((resolve, reject) => {
                child.once('spawn', resolve);
                child.once('error', reject);
            });
            return child;
        }, {
            documentSelector: [], outputChannel: output, workspaceFolder: vscode.workspace.workspaceFolders?.[0],
            initializationOptions: { diagnostics: { enable: false, workspace: false } },
            errorHandler: {
                error: () => ({ action: ErrorAction.Shutdown }),
                closed: () => ({ action: CloseAction.DoNotRestart }),
            },
        });
        const messages: ResourceDetailsMessage[] = [];
        const session = new ResourceDetailsSession((method, params) => client.sendRequest(method, params), (message) => messages.push(message), {
            openSource: openResourceSource, chooseResource: async () => undefined,
        });
        const failures: unknown[] = [];
        try {
            await client.start();
            const health = await client.sendRequest('qbx/workspaceHealth', {});
            assert.ok(validWorkspaceHealth(health));
            assert.ok(health.files > 0 && health.resources > 1);
            const resource = workspaceFile('myresource');
            const nui = await client.sendRequest('qbx/nuiResource', { uri: resource.toString() });
            assert.ok(validNuiResource(nui));
            assert.equal(nui.resource.name, 'myresource');
            assertSameFile(nui.resource.manifestUri, vscode.Uri.joinPath(resource, 'fxmanifest.lua'));
            const result = await client.sendRequest<ResourceDetails>('qbx/resourceDetails', { uri: resource.toString() });
            assert.equal(result.resource.name, 'myresource');
            assertSameFile(result.resource.manifestUri, vscode.Uri.joinPath(resource, 'fxmanifest.lua'));
            assert.equal(result.files.total, result.files.client + result.files.server + result.files.shared + result.files.module);
            assert.ok(result.files.client > 0 && result.files.server > 0 && result.files.shared > 0);
            assert.ok(result.events.some((event) => event.name === 'myresource:server:ping' && event.side === 'server'));
            assert.ok(result.events.some((event) => event.name === 'myresource:getGarages'));
            const dependency = result.dependencies.find((relation) => relation.name === 'mylib');
            assert.ok(dependency);
            assert.equal(dependency.status, 'resolved');
            assert.equal(dependency.targets.length, 1);
            const library = await client.sendRequest<ResourceDetails>('qbx/resourceDetails', { uri: dependency.targets[0].manifestUri });
            assert.ok(library.exports.some((item) => item.name === 'GetPlayer'));
            assert.ok(library.dependents.some((relation) => relation.name === 'myresource'));
            await assert.rejects(client.sendRequest('qbx/resourceDetails', { uri: vscode.Uri.joinPath(resource, 'server/main.lua').toString() }));
            await session.show(resource.toString());
            const message = messages.filter((value) => value.type === 'details').at(-1);
            assert.ok(message?.type === 'details', JSON.stringify(messages));
            const event = message.data.events.find((item) => item.name === 'myresource:server:ping');
            assert.ok(event);
            await session.handle({ type: 'openSource', id: event.id });
            const editor = vscode.window.activeTextEditor;
            assertSameFile(editor?.document.uri, workspaceFile('myresource/server/main.lua'));
            assert.ok(editor?.document.getText(editor.selection).includes('myresource:server:ping'));
        } catch (error) { failures.push(error); }
        finally {
            session.dispose();
            try { await client.dispose(); }
            catch (error) {
                failures.push(error);
                server?.kill();
            }
            if (serverClosed) {
                try {
                    const exit = await processDeadline(serverClosed);
                    assert.equal(exit.code, 0, `Resource Details test server exited with code ${exit.code}, signal ${exit.signal}`);
                } catch (error) {
                    failures.push(error);
                    if (!hasClosed) {
                        server?.kill();
                        try { await processDeadline(serverClosed); }
                        catch (closeError) { failures.push(closeError); }
                    }
                }
            }
            if (!server || hasClosed) { output.dispose(); }
            if (failures.length === 1) { throw failures[0]; }
            if (failures.length > 1) { throw new AggregateError(failures, 'Resource Details integration or server cleanup failed.'); }
        }
    }],
    ['Resource Details command is in the recognized resource menu and reuses one tab', async () => {
        const extension = vscode.extensions.getExtension('qbox.qbx-lua');
        assert.ok(extension);
        await extension.activate();
        assert.ok((await vscode.commands.getCommands(true)).includes('qbxLua.resources.details'));
        const manifest = extension.packageJSON as { contributes: { menus: Record<string, { command?: string; submenu?: string; when?: string }[]> } };
        assert.ok(manifest.contributes.menus['qbxLua.resources'].some((item) => item.command === 'qbxLua.resources.details'));
        const menu = manifest.contributes.menus['explorer/context'].find((item) => item.submenu === 'qbxLua.resources');
        assert.ok(menu?.when?.includes('resourcePath in qbxLua.resourceFolders'));
        assert.ok(menu?.when?.includes('explorerResourceIsFolder'));
        const before = new Set(tabs());
        await vscode.commands.executeCommand('qbxLua.resources.details', workspaceFile('myresource'));
        const first = await waitFor('Resource Details tab', () => tabs().find((tab) => !before.has(tab)));
        assert.ok(first.input instanceof vscode.TabInputWebview);
        const viewType = first.input.viewType;
        try {
            await vscode.commands.executeCommand('qbxLua.resources.details', workspaceFile('shop'));
            await vscode.commands.executeCommand('qbxLua.resources.details', workspaceFile('myresource/fxmanifest.lua'));
            assert.equal(tabs(viewType).length, 1);
            await vscode.window.tabGroups.close(tabs(viewType), true);
            await waitFor('Resource Details tab disposal', () => tabs(viewType).length === 0 ? true : undefined);
            await vscode.commands.executeCommand('qbxLua.resources.details', workspaceFile('myresource'));
            await waitFor('Resource Details tab reopening', () => tabs(viewType).length === 1 ? true : undefined);
        } finally { await vscode.window.tabGroups.close(tabs(viewType), true); }
    }],
];

/** Resource Details protocol and editor integration; no network pages or live resource commands. */
export async function runResourceDetailsTests(): Promise<void> {
    const failures: string[] = [];
    for (const [name, body] of tests) {
        try { await body(); console.log(`  ok   ${name}`); }
        catch (error) {
            failures.push(name);
            console.error(`  FAIL ${name}\n${error instanceof Error ? error.stack : String(error)}`);
        }
    }
    if (failures.length > 0) { throw new Error(`${failures.length} resource details test(s) failed: ${failures.join(', ')}`); }
}
