import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { LuaEditorTargetTracker } from '../../src/referenceBrowser';
import { SnippetBrowser, snippetFromSelection } from '../../src/snippetBrowser';
import { getSnippetHtml } from '../../src/snippetHtml';
import { SnippetSession } from '../../src/snippetSession';
import { addSnippetToText, parseSnippetFile, SnippetStore } from '../../src/snippetStore';
import { MAX_SNIPPET_BODY_BYTES, MAX_SNIPPET_FILE_BYTES, MAX_SNIPPETS_PER_FILE } from '../../src/snippetFormat';
import type { RecipeSnippet, SnippetCatalog, SnippetHostMessage } from '../../src/snippetTypes';
import { filterSnippetCatalog, normalizeSnippetViewState, snippetPage } from '../../src/snippetViewState';

type Test = [name: string, body: () => void | Promise<void>];

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

const builtin: RecipeSnippet = {
    id: 'builtin:thread', label: 'Create thread', description: 'Run a Lua thread',
    body: 'CreateThread(function()\n    ${1:Wait(0)}\nend)$0', preview: 'CreateThread(function()\n    Wait(0)\nend)',
    prefix: ['thread'], source: 'builtin', sourceLabel: 'Built-in',
};
const personal: RecipeSnippet = {
    id: 'personal:example', label: 'My event', description: 'Register an event', body: "RegisterNetEvent('${1:event}')$0",
    prefix: ['event'], source: 'personal', sourceLabel: 'Personal',
};
const workspace: RecipeSnippet = {
    id: 'workspace:example', label: 'Garage check', description: 'Test vehicle access', body: 'HasGarageAccess(${1:vehicle})$0',
    prefix: ['garage'], source: 'workspace', sourceLabel: 'Workspace example',
};

function sessionHarness() {
    const loads: ReturnType<typeof deferred<SnippetCatalog>>[] = [];
    const messages: SnippetHostMessage[] = [];
    const copied: string[] = [];
    const inserted: { item: RecipeSnippet; target: string | undefined }[] = [];
    const edited: RecipeSnippet[] = [];
    const duplicated: RecipeSnippet[] = [];
    const managed: string[] = [];
    const state: { target: string | undefined; gate?: ReturnType<typeof deferred<void>>; cancelled: boolean } = { target: 'first.lua', cancelled: false };
    const session = new SnippetSession<string>(async () => {
        const load = deferred<SnippetCatalog>();
        loads.push(load);
        return load.promise;
    }, (message) => messages.push(message), {
        captureInsertionTarget: () => state.target,
        copy: async (text) => { copied.push(text); },
        insert: async (item, target, isCurrent) => {
            if (state.gate) { await state.gate.promise; }
            if (isCurrent()) { inserted.push({ item, target }); }
        },
        edit: async (item, isCurrent) => { if (isCurrent()) { edited.push(item); } },
        duplicate: async (item, _target, isCurrent) => {
            if (state.gate) { await state.gate.promise; }
            if (isCurrent() && !state.cancelled) { duplicated.push(item); return true; }
            return false;
        },
        manage: async (action, _target, isCurrent) => {
            if (state.gate) { await state.gate.promise; }
            if (isCurrent() && !state.cancelled) { managed.push(action); return true; }
            return false;
        },
    });
    return { session, loads, messages, copied, inserted, edited, duplicated, managed, state };
}

async function loadCatalog(h: ReturnType<typeof sessionHarness>, items = [builtin, personal, workspace]): Promise<void> {
    const loading = h.session.handle({ type: 'load', requestId: 1 });
    h.loads.at(-1)!.resolve({ items, issues: [] });
    await loading;
}

async function closeTestDocument(document: vscode.TextDocument): Promise<void> {
    if (!document.isClosed) {
        await vscode.window.showTextDocument(document);
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
}

async function withStore(body: (fixture: { store: SnippetStore; root: string; global: vscode.Uri; folders: vscode.WorkspaceFolder[] }) => Promise<void>): Promise<void> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qbx-snippet-tests-'));
    const global = vscode.Uri.file(path.join(root, 'profile'));
    const folders: vscode.WorkspaceFolder[] = ['one', 'two'].map((name, index) => ({ name, index, uri: vscode.Uri.file(path.join(root, name)) }));
    await Promise.all([global, ...folders.map((folder) => folder.uri)].map((uri) => fs.mkdir(uri.fsPath, { recursive: true })));
    const store = new SnippetStore(global, () => folders);
    try { await body({ store, root, global, folders }); }
    finally {
        store.dispose();
        const prefix = `${path.resolve(root)}${path.sep}`;
        for (const document of vscode.workspace.textDocuments) {
            if (document.uri.scheme === 'file' && path.resolve(document.uri.fsPath).startsWith(prefix)) {
                await closeTestDocument(document);
            }
        }
        assert.ok(path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
        assert.ok(path.basename(root).startsWith('qbx-snippet-tests-'));
        await fs.rm(root, { recursive: true, force: true });
    }
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

function webviewTabs(viewType?: string): vscode.Tab[] {
    return vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) =>
        tab.input instanceof vscode.TabInputWebview && (viewType === undefined || tab.input.viewType === viewType));
}

const tests: Test[] = [
    ['snippet webview has nonce-only scripts and cannot inject resource attributes', () => {
        const html = getSnippetHtml('https://local.test/script.js?x="><script>alert(1)</script>', 'snippet-nonce');
        assert.match(html, /default-src 'none'/);
        assert.match(html, /script-src 'nonce-snippet-nonce'/);
        assert.match(html, /connect-src 'none'/);
        assert.equal((html.match(/<script\b/g) ?? []).length, 1);
        assert.match(html, /&quot;&gt;&lt;script&gt;/);
        assert.doesNotMatch(html, /unsafe-inline|unsafe-eval|<iframe\b/);
    }],
    ['custom snippets parse JSONC and retain raw placeholder syntax while reporting malformed entries', () => {
        const text = `{
            // Comments and trailing commas are supported.
            "Thread": { "prefix": ["thread", "worker"], "description": "Run code", "body": ["CreateThread(function()", "    $1", "end)$0"], },
            "One line": { "prefix": "line", "body": "print('$1')$0" },
        }`;
        const parsed = parseSnippetFile(text);
        assert.deepEqual(parsed.issues, []);
        assert.equal(parsed.snippets.length, 2);
        assert.deepEqual(parsed.snippets[0], {
            name: 'Thread', prefix: ['thread', 'worker'], description: 'Run code', body: 'CreateThread(function()\n    $1\nend)$0',
        });
        assert.equal(parsed.snippets[1].body, "print('$1')$0");
        const duplicate = parseSnippetFile('{"Repeated":{"body":"first"},"Repeated":{"body":"second"}}');
        assert.ok(duplicate.issues.some((issue) => /duplicat/i.test(issue)));
        const broken = parseSnippetFile('{"Broken":');
        assert.ok(broken.issues.length > 0);
        assert.deepEqual(broken.snippets, []);
        const mixed = parseSnippetFile('{"Valid":{"body":"$1"},"Bad":{"body":["ok",3]}}');
        assert.ok(mixed.issues.length > 0);
        assert.ok(mixed.snippets.some((item) => item.name === 'Valid'));
        assert.ok(!mixed.snippets.some((item) => item.name === 'Bad'));
    }],
    ['snippet parsing enforces byte and entry limits and preserves BOM/comment content when adding', () => {
        assert.ok(parseSnippetFile(' '.repeat(MAX_SNIPPET_FILE_BYTES + 1)).issues.length > 0);
        const oversizedBody = JSON.stringify({ TooBig: { body: 'a'.repeat(MAX_SNIPPET_BODY_BYTES + 1) } });
        assert.ok(parseSnippetFile(oversizedBody).issues.some((issue) => /128 KiB/.test(issue)));
        const tooMany = Object.fromEntries(Array.from({ length: MAX_SNIPPETS_PER_FILE + 1 }, (_, index) => [`Snippet ${index}`, { body: 'x' }]));
        assert.ok(parseSnippetFile(JSON.stringify(tooMany)).issues.some((issue) => /1000/.test(issue)));
        assert.ok(parseSnippetFile(JSON.stringify({ BadPrefix: { body: 'x', prefix: ['one', 2] } })).issues.length > 0);
        assert.ok(parseSnippetFile(JSON.stringify({ BadDescription: { body: 'x', description: false } })).issues.length > 0);
        const bom = '\uFEFF{\r\n    // Keep BOM and comment.\r\n    "Existing": { "body": "$1" },\r\n}\r\n';
        const result = addSnippetToText(bom, 'Added', 'print("${1:value}")$0');
        assert.ok(result.text.startsWith('\uFEFF'));
        assert.ok(result.text.includes('// Keep BOM and comment.\r\n'));
        assert.deepEqual(parseSnippetFile(result.text).issues, []);
        assert.equal(parseSnippetFile(result.text).snippets.find((item) => item.name === 'Added')?.body, 'print("${1:value}")$0');
    }],
    ['personal and multi-root snippet libraries create independently and retain stable IDs', async () => withStore(async ({ store, folders }) => {
        const sources = store.sources();
        assert.equal(sources.length, 3);
        assert.equal(sources[0].kind, 'personal');
        assert.equal(new Set(sources.map((source) => source.id)).size, 3);
        for (const source of sources) {
            assert.deepEqual(await store.readSource(source), { items: [], issues: [], exists: false });
        }
        for (const [index, source] of sources.entries()) {
            await store.add(source, 'Same name', `print(${index})$0`, source.label);
        }
        const loaded = await store.load();
        assert.deepEqual(loaded.issues, []);
        assert.equal(loaded.items.length, 3);
        assert.equal(new Set(loaded.items.map((item) => item.id)).size, 3, 'same names in different libraries need distinct IDs');
        assert.deepEqual((await store.load()).items.map((item) => item.id), loaded.items.map((item) => item.id));
        for (const [index, source] of sources.entries()) {
            const parsed = parseSnippetFile(await fs.readFile(source.uri.fsPath, 'utf8'));
            assert.equal(parsed.snippets[0].body, `print(${index})$0`);
        }
        folders.pop();
        assert.equal(store.sources().length, 2, 'removed workspace roots stop contributing libraries');
        assert.equal((await store.load()).items.length, 2);
    })],
    ['adding snippets preserves comments and refuses duplicate names or malformed JSON without overwriting', async () => withStore(async ({ store }) => {
        const source = store.sources()[0];
        await fs.mkdir(path.dirname(source.uri.fsPath), { recursive: true });
        const initial = '{\n    // Keep this explanation.\n    "Existing": { "body": "$1", "description": "unchanged" },\n}\n';
        await fs.writeFile(source.uri.fsPath, initial);
        await store.add(source, 'New', 'print("${1:value}")$0', 'new description');
        const saved = await fs.readFile(source.uri.fsPath, 'utf8');
        assert.ok(saved.includes('// Keep this explanation.'));
        const parsed = parseSnippetFile(saved);
        assert.deepEqual(parsed.issues, []);
        assert.equal(parsed.snippets.find((item) => item.name === 'Existing')?.body, '$1');
        assert.equal(parsed.snippets.find((item) => item.name === 'New')?.body, 'print("${1:value}")$0');
        await assert.rejects(store.add(source, 'New', 'overwritten'));
        assert.equal(await fs.readFile(source.uri.fsPath, 'utf8'), saved);
        const broken = '{"Do not overwrite":';
        await fs.writeFile(source.uri.fsPath, broken);
        await assert.rejects(store.add(source, 'Another', 'body'));
        assert.equal(await fs.readFile(source.uri.fsPath, 'utf8'), broken);
    })],
    ['overlapping additions are refused without data loss and failed writes preserve existing paths', async () => withStore(async ({ store, folders }) => {
        const source = store.sources()[0];
        const outcomes = await Promise.allSettled([store.add(source, 'First', 'first'), store.add(source, 'Second', 'second')]);
        assert.equal(outcomes[0].status, 'fulfilled');
        assert.equal(outcomes[1].status, 'rejected', 'an overlapping write should fail explicitly');
        assert.deepEqual(parseSnippetFile(await fs.readFile(source.uri.fsPath, 'utf8')).snippets.map((item) => item.name), ['First']);
        await store.add(source, 'Second', 'second');
        const parsed = parseSnippetFile(await fs.readFile(source.uri.fsPath, 'utf8'));
        assert.deepEqual(parsed.snippets.map((item) => item.name).sort(), ['First', 'Second']);
        const workspaceSource = store.sources().find((item) => item.kind === 'workspace')!;
        const blockedParent = path.join(folders[0].uri.fsPath, '.vscode');
        await fs.writeFile(blockedParent, 'Keep this regular file.');
        await assert.rejects(store.add(workspaceSource, 'Cannot save', 'body'));
        assert.equal(await fs.readFile(blockedParent, 'utf8'), 'Keep this regular file.');
    })],
    ['snippet writes refuse dirty editor buffers and open creates only the requested library', async () => withStore(async ({ store }) => {
        const source = store.sources()[0];
        await store.open(source);
        const document = vscode.window.activeTextEditor?.document;
        assert.ok(document);
        assert.equal(document.uri.toString(), source.uri.toString());
        assert.deepEqual(parseSnippetFile(await fs.readFile(source.uri.fsPath, 'utf8')).issues, []);
        const saved = await fs.readFile(source.uri.fsPath, 'utf8');
        const editor = await vscode.window.showTextDocument(document);
        await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), '// Unsaved user edit\n'));
        assert.ok(document.isDirty);
        await assert.rejects(store.add(source, 'Unsafe addition', 'body'), /save|unsaved|dirty|changes/i);
        assert.equal(await fs.readFile(source.uri.fsPath, 'utf8'), saved);
        assert.ok(document.getText().startsWith('// Unsaved user edit'));
        for (const other of store.sources().slice(1)) {
            assert.equal((await store.readSource(other)).exists, false);
        }
    })],
    ['opening a workspace snippet JSON file directly selects JSONC without the management command', async () => withStore(async ({ store }) => {
        const extension = vscode.extensions.getExtension('qbox.qbx-lua');
        assert.ok(extension);
        await extension.activate();
        const source = store.sources().find((item) => item.kind === 'workspace')!;
        await fs.mkdir(path.dirname(source.uri.fsPath), { recursive: true });
        await fs.writeFile(source.uri.fsPath, '{\n// Commented library\n"Example": {"body": "$1"},\n}\n');
        const document = await vscode.workspace.openTextDocument(source.uri);
        assert.equal(document.languageId, 'jsonc', 'the filename contribution must work before store.open forces a language');
    })],
    ['offline catalog loading keeps personal snippets and bundled manifest recipes available', async () => withStore(async ({ store, global }) => {
        const extension = vscode.extensions.getExtension('qbox.qbx-lua');
        assert.ok(extension);
        const personalSource = store.sources()[0];
        await store.add(personalSource, 'Offline personal', 'print("${1:offline}")$0');
        const original = await fs.readFile(personalSource.uri.fsPath, 'utf8');
        const requested: string[] = [];
        const browser = new SnippetBrowser(extension.extensionUri, global, async (method) => {
            requested.push(method);
            throw new Error('Test language server is offline');
        });
        try {
            const catalog = await browser.loadCatalog();
            assert.deepEqual(requested, ['qbx/snippets']);
            assert.equal(catalog.items.find((item) => item.source === 'personal' && item.label === 'Offline personal')?.body, 'print("${1:offline}")$0');
            const manifests = catalog.items.filter((item) => item.id.startsWith('builtin:manifest:'));
            assert.equal(manifests.length, 2, 'manifest recipes must not depend on a running language server');
            assert.ok(manifests.some((item) => item.body.includes("fx_version 'cerulean'")));
            assert.ok(catalog.issues.some((issue) => issue.includes('Test language server is offline')));
            assert.equal(await fs.readFile(personalSource.uri.fsPath, 'utf8'), original, 'browsing must not rewrite the library');
        } finally { browser.dispose(); }
    })],
    ['snippet library changes notify the browser and saved edits become available', async () => withStore(async ({ store }) => {
        const source = store.sources()[0];
        let changes = 0;
        const subscription = store.onDidChange(() => { changes += 1; });
        try {
            await store.add(source, 'Original', '$1');
            await waitFor('snippet creation event', () => changes > 0 ? true : undefined);
            await store.open(source);
            const document = vscode.window.activeTextEditor!.document;
            const editor = await vscode.window.showTextDocument(document);
            const before = changes;
            const updated = '{"Edited":{"prefix":"edited","body":"print(42)$0"}}';
            await editor.edit((edit) => edit.replace(new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length)), updated));
            await waitFor('snippet document change event', () => changes > before ? true : undefined);
            assert.equal((await store.readSource(source)).items[0].label, 'Edited', 'the open editor buffer is the displayed library');
            const beforeSave = changes;
            assert.ok(await document.save());
            await waitFor('snippet save event', () => changes > beforeSave ? true : undefined);
            assert.equal(parseSnippetFile(await fs.readFile(source.uri.fsPath, 'utf8')).snippets[0].body, 'print(42)$0');
            const beforeDelete = changes;
            await fs.unlink(source.uri.fsPath);
            await waitFor('snippet file deletion event', () => changes > beforeDelete ? true : undefined);
            await assert.rejects(fs.stat(source.uri.fsPath), { code: 'ENOENT' });
        } finally { subscription.dispose(); }
    })],
    ['saving a Lua selection escapes snippet metacharacters and inserts the exact selected code', async () => {
        const literal = "local template = '${1:name}'; local price = '$5'; local path = [[C:\\tmp}]]";
        const source = await vscode.workspace.openTextDocument({ language: 'lua', content: literal });
        const destination = await vscode.workspace.openTextDocument({ language: 'lua', content: '' });
        const sourceEditor = await vscode.window.showTextDocument(source, { preview: false });
        sourceEditor.selection = new vscode.Selection(new vscode.Position(0, 0), source.positionAt(literal.length));
        const tracker = new LuaEditorTargetTracker();
        try {
            const sourceTarget = tracker.capture();
            assert.ok(sourceTarget);
            const escaped = snippetFromSelection(sourceTarget);
            assert.notEqual(escaped, literal, 'dollar signs and backslashes must not become snippet variables');
            assert.throws(() => snippetFromSelection(undefined), /Select code/);
            assert.throws(() => snippetFromSelection({ ...sourceTarget, selection: new vscode.Selection(0, 0, 0, 0) }), /Select code/);
            await vscode.window.showTextDocument(destination, { preview: false });
            const target = await waitFor('destination Lua editor', () => {
                const selected = tracker.capture();
                return selected?.document === destination ? selected : undefined;
            });
            await tracker.insert({ insertText: escaped, insertSnippet: escaped }, target, () => true);
            assert.equal(destination.getText(), literal);
            assert.equal(source.getText(), literal);
            const currentSourceEditor = await vscode.window.showTextDocument(source);
            await currentSourceEditor.edit((edit) => edit.insert(source.positionAt(literal.length), ' -- changed'));
            assert.throws(() => snippetFromSelection(sourceTarget), /Select code/, 'a saved selection must not read a changed document');
        } finally {
            tracker.dispose();
            await closeTestDocument(source);
            await closeTestDocument(destination);
        }
    }],
    ['snippet view state rejects malformed values and local search ranks names without mutating the catalog', () => {
        const state = normalizeSnippetViewState({ query: 'x'.repeat(300), source: ['personal'], offset: -10, selectedId: 1, showBody: 'true' });
        assert.equal(state.query.length, 256);
        assert.equal(state.source, 'all');
        assert.equal(state.offset, 0);
        assert.equal(state.selectedId, '');
        assert.equal(state.showBody, false);
        const items = [workspace, personal, builtin];
        assert.deepEqual(filterSnippetCatalog(items, { query: 'LUA THREAD', source: 'all' }), [builtin]);
        assert.deepEqual(filterSnippetCatalog(items, { query: 'RegisterNetEvent', source: 'personal' }), [personal]);
        assert.deepEqual(filterSnippetCatalog(items, { query: 'RegisterNetEvent', source: 'workspace' }), []);
        assert.deepEqual(filterSnippetCatalog(items, { query: 'garage', source: 'all' }), [workspace]);
        assert.deepEqual(items, [workspace, personal, builtin], 'sorting must not mutate the catalog used for ID lookup');
        const bodyMatch = { ...personal, id: 'personal:mention', label: 'A mention', body: 'thread' };
        assert.equal(filterSnippetCatalog([bodyMatch, builtin], { query: 'thread', source: 'all' })[0], builtin, 'exact prefix beats incidental body text');
        const many = Array.from({ length: 121 }, (_, index) => ({ ...personal, id: `personal:${index}` }));
        assert.deepEqual(snippetPage(many, 500), { items: many.slice(100), total: 121, offset: 100 });
        assert.deepEqual(snippetPage([], 50), { items: [], total: 0, offset: 0 });
        assert.equal(snippetPage(many, -1).offset, 0);
        assert.equal(snippetPage(many, 0, 999).items.length, 50, 'pages remain bounded');
    }],
    ['snippet actions use only host catalog entries and preserve editable snippet syntax', async () => {
        const h = sessionHarness();
        try {
            await loadCatalog(h);
            for (const [index, action] of ['copy', 'insert', 'duplicate', 'edit'].entries()) {
                await h.session.handle({ type: 'action', requestId: index + 2, id: builtin.id, action,
                    body: 'FORGED', source: 'personal', path: 'file:///private', command: 'evil' });
            }
            assert.deepEqual(h.copied, [builtin.body], 'Copy copies syntax, not the rendered preview or supplied body');
            assert.deepEqual(h.inserted, [{ item: builtin, target: 'first.lua' }]);
            assert.deepEqual(h.duplicated, [builtin]);
            assert.deepEqual(h.edited, [], 'built-in recipes cannot be edited');
            await h.session.handle({ type: 'action', requestId: 6, id: personal.id, action: 'edit', path: 'file:///private' });
            assert.deepEqual(h.edited, [personal]);
        } finally { h.session.dispose(); }
    }],
    ['invalid snippet messages and arbitrary IDs cannot invoke clipboard, editor or file actions', async () => {
        const h = sessionHarness();
        try {
            await loadCatalog(h);
            for (const message of [null, [], {}, 'copy',
                { type: 'load', requestId: '1' }, { type: 'load', requestId: -1 },
                { type: 'action', requestId: 2, id: 'file:///private', action: 'edit' },
                { type: 'action', requestId: 2, id: '__proto__', action: 'insert' },
                { type: 'action', requestId: 2, id: personal.id, action: ['copy'] },
                { type: 'action', requestId: 2, id: personal.id, action: 'execute' },
                { type: 'manage', requestId: 2, action: ['personal'] },
                { type: 'manage', requestId: 2, action: 'openFile', path: 'file:///private' },
            ]) { await h.session.handle(message); }
            assert.equal(h.loads.length, 1);
            assert.deepEqual([h.copied, h.inserted, h.edited, h.duplicated, h.managed], [[], [], [], [], []]);
        } finally { h.session.dispose(); }
    }],
    ['snippet refresh ignores obsolete loads and errors and invalidates old action IDs', async () => {
        const h = sessionHarness();
        try {
            const older = h.session.handle({ type: 'load', requestId: 1 });
            const newer = h.session.handle({ type: 'load', requestId: 2 });
            h.loads[1].resolve({ items: [personal], issues: [] });
            await newer;
            h.loads[0].resolve({ items: [builtin], issues: [] });
            await older;
            assert.deepEqual(h.messages.filter((message) => message.type === 'catalog').map((message) => message.requestId), [2]);
            await h.session.handle({ type: 'action', requestId: 3, id: builtin.id, action: 'copy' });
            assert.deepEqual(h.copied, []);
            const staleFailure = h.session.handle({ type: 'load', requestId: 4 });
            h.session.invalidate();
            await h.session.handle({ type: 'action', requestId: 5, id: personal.id, action: 'copy' });
            h.loads[2].reject(new Error('Obsolete failure'));
            await staleFailure;
            assert.deepEqual(h.copied, []);
            assert.ok(!h.messages.some((message) => message.type === 'error' && message.requestId === 4));
            const failed = h.session.handle({ type: 'load', requestId: 6 });
            h.loads[3].reject(new Error('Snippet storage unavailable'));
            await failed;
            assert.ok(h.messages.some((message) => message.type === 'error' && message.requestId === 6));
        } finally { h.session.dispose(); }
    }],
    ['snippet actions serialize prompts, retain their captured target and respect cancellation', async () => {
        const h = sessionHarness();
        try {
            await loadCatalog(h);
            h.state.gate = deferred<void>();
            const first = h.session.handle({ type: 'action', requestId: 2, id: builtin.id, action: 'insert' });
            h.state.target = 'second.lua';
            await h.session.handle({ type: 'action', requestId: 3, id: personal.id, action: 'copy' });
            assert.deepEqual(h.copied, [], 'busy actions must not overlap user prompts or writes');
            assert.ok(h.messages.some((message) => message.type === 'error' && message.requestId === 3));
            h.state.gate.resolve();
            await first;
            assert.equal(h.inserted[0]?.target, 'first.lua');
            h.state.gate = undefined;
            h.state.cancelled = true;
            await h.session.handle({ type: 'action', requestId: 4, id: personal.id, action: 'duplicate' });
            await h.session.handle({ type: 'manage', requestId: 5, action: 'new' });
            assert.deepEqual([h.duplicated, h.managed], [[], []]);
            assert.ok(h.messages.some((message) => message.type === 'actionComplete' && message.requestId === 4 && /cancel/i.test(message.message)));
        } finally { h.session.dispose(); }
    }],
    ['disposing the snippet browser cancels pending loads and insertions', async () => {
        const h = sessionHarness();
        const pending = h.session.handle({ type: 'load', requestId: 1 });
        h.session.dispose();
        h.loads[0].resolve({ items: [builtin], issues: [] });
        await pending;
        assert.deepEqual(h.messages, []);
        await h.session.handle({ type: 'load', requestId: 2 });
        assert.equal(h.loads.length, 1);

        const action = sessionHarness();
        await loadCatalog(action);
        action.state.gate = deferred<void>();
        const insertion = action.session.handle({ type: 'action', requestId: 2, id: builtin.id, action: 'insert' });
        action.session.dispose();
        action.state.gate.resolve();
        await insertion;
        assert.deepEqual(action.inserted, []);
        assert.ok(!action.messages.some((message) => message.type === 'actionComplete'));
    }],
    ['snippet browser commands share one tab and reopen cleanly after closing', async () => {
        const extension = vscode.extensions.getExtension('qbox.qbx-lua');
        assert.ok(extension);
        await extension.activate();
        const commands = await vscode.commands.getCommands(true);
        for (const command of ['qbxLua.openSnippets', 'qbxLua.showSnippets', 'qbxLua.saveSelectionAsSnippet',
            'qbxLua.editPersonalSnippets', 'qbxLua.editWorkspaceSnippets']) {
            assert.ok(commands.includes(command), `${command} should be registered`);
        }
        const before = new Set(webviewTabs());
        await vscode.commands.executeCommand('qbxLua.openSnippets');
        const first = await waitFor('snippet browser tab', () => webviewTabs().find((tab) => !before.has(tab)));
        assert.ok(first.input instanceof vscode.TabInputWebview);
        const viewType = first.input.viewType;
        try {
            await vscode.commands.executeCommand('qbxLua.showSnippets');
            await vscode.commands.executeCommand('qbxLua.openSnippets');
            assert.equal(webviewTabs(viewType).length, 1, 'the old and new commands must reveal one browser');
            await vscode.window.tabGroups.close(webviewTabs(viewType), true);
            await waitFor('snippet tab disposal', () => webviewTabs(viewType).length === 0 ? true : undefined);
            await vscode.commands.executeCommand('qbxLua.showSnippets');
            await waitFor('snippet tab reopening', () => webviewTabs(viewType).length === 1 ? true : undefined);
        } finally {
            await vscode.window.tabGroups.close(webviewTabs(viewType), true);
        }
    }],
];

/** Snippet tests use temporary files and fake actions; they never edit the user's snippet library. */
export async function runSnippetTests(): Promise<void> {
    const failures: string[] = [];
    for (const [name, body] of tests) {
        try {
            await body();
            console.log(`  ok   ${name}`);
        } catch (error) {
            failures.push(name);
            console.error(`  FAIL ${name}\n${error instanceof Error ? error.stack : String(error)}`);
        }
    }
    if (failures.length > 0) {
        throw new Error(`${failures.length} snippet test(s) failed: ${failures.join(', ')}`);
    }
}
