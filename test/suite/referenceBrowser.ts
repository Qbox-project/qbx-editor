import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { getReferenceHtml, LuaEditorTargetTracker } from '../../src/referenceBrowser';
import { decodeMarkdownEntities } from '../../src/referenceMarkdown';
import { normalizeReferenceLink, normalizeReferenceSearch, referenceLinks, ReferenceSession, validReferenceId } from '../../src/referenceSession';
import type { ReferenceDetail, ReferenceHostMessage, ReferenceItem, ReferenceRequest, ReferenceSearchResult } from '../../src/referenceTypes';

type Test = [name: string, body: () => void | Promise<void>];

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

const nativeDetail: ReferenceDetail = {
    id: 'native:GetEntityCoords', kind: 'native', name: 'GetEntityCoords', side: 'shared', namespace: 'ENTITY',
    hash: '0x3FEF770D40960D5A', signature: 'GetEntityCoords(entity: integer): vector3',
    parameters: [{ name: 'entity', type: 'integer' }], returns: ['vector3'],
    documentation: 'Returns coordinates. [Controls](https://docs.fivem.net/docs/game-references/controls/)',
    sourceUrl: 'https://docs.fivem.net/natives/?_0x3FEF770D40960D5A',
    copyText: 'GetEntityCoords', insertText: 'GetEntityCoords(entity)', insertSnippet: 'GetEntityCoords(${1:entity})$0',
};
const controlDetail: ReferenceDetail = {
    id: 'control:38', kind: 'control', name: 'INPUT_PICKUP', side: 'client', numericId: 38,
    documentation: 'Default keyboard (QWERTY): `E`', sourceUrl: 'https://docs.fivem.net/docs/game-references/controls/',
    copyText: '38', insertText: '38',
};

function results(...items: ReferenceItem[]): ReferenceSearchResult {
    return { items, total: items.length, offset: 0, limit: 50, namespaces: ['ENTITY', 'PAD'] };
}

function harness() {
    const requests: { method: string; params: unknown; response: ReturnType<typeof deferred<unknown>> }[] = [];
    const messages: ReferenceHostMessage[] = [];
    const copied: string[] = [];
    const opened: string[] = [];
    const inserted: { detail: ReferenceDetail; target: string | undefined }[] = [];
    const state: { target: string | undefined; insertGate?: ReturnType<typeof deferred<void>> } = { target: 'first.lua' };
    const request: ReferenceRequest = <T>(method: string, params: unknown): Promise<T> => {
        const response = deferred<unknown>();
        requests.push({ method, params, response });
        return response.promise as Promise<T>;
    };
    const session = new ReferenceSession<string>(request, (message) => messages.push(message), {
        captureInsertionTarget: () => state.target,
        insert: async (detail, target, isCurrent) => {
            if (state.insertGate) { await state.insertGate.promise; }
            if (isCurrent()) { inserted.push({ detail, target }); }
        },
        copy: async (text) => { copied.push(text); },
        openExternal: async (url) => { opened.push(url); },
    });
    return { session, requests, messages, copied, opened, inserted, state };
}

async function select(h: ReturnType<typeof harness>, detail = nativeDetail): Promise<void> {
    const search = h.session.handle({ type: 'search', requestId: 1, params: {} });
    assert.equal(h.requests.at(-1)?.method, 'qbx/referenceSearch');
    h.requests.at(-1)!.response.resolve(results(detail));
    await search;
    const selected = h.session.handle({ type: 'detail', requestId: 2, id: detail.id });
    assert.equal(h.requests.at(-1)?.method, 'qbx/referenceDetail');
    h.requests.at(-1)!.response.resolve(detail);
    await selected;
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

async function closeUntitled(document: vscode.TextDocument): Promise<void> {
    assert.equal(document.uri.scheme, 'untitled', 'cleanup is limited to this test’s unsaved documents');
    if (!document.isClosed) {
        await vscode.window.showTextDocument(document);
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
}

const tests: Test[] = [
    ['webview HTML allows only nonce scripts/styles and escapes resource attributes', () => {
        const html = getReferenceHtml('https://local.test/script.js?x="><script>alert(1)</script>', 'test-nonce');
        assert.match(html, /default-src 'none'/);
        assert.match(html, /script-src 'nonce-test-nonce'/);
        assert.match(html, /style-src 'nonce-test-nonce'/);
        assert.match(html, /connect-src 'none'/);
        assert.match(html, /img-src 'none'/);
        assert.equal((html.match(/<script\b/g) ?? []).length, 1, 'resource attributes cannot inject another script');
        assert.match(html, /&quot;&gt;&lt;script&gt;/);
        assert.doesNotMatch(html, /unsafe-inline|unsafe-eval|<iframe\b/);
    }],
    ['reference validation bounds searches and admits only stable IDs and HTTPS links', () => {
        assert.ok(normalizeReferenceSearch({ query: '😀'.repeat(256) }), 'query limits count Unicode characters');
        assert.equal(normalizeReferenceSearch({ query: '😀'.repeat(257) }), undefined);
        assert.equal(normalizeReferenceSearch({ namespace: 'x'.repeat(65) }), undefined);
        assert.equal(normalizeReferenceSearch({ kind: ['native'] }), undefined);
        assert.equal(normalizeReferenceSearch({ side: ['client'] }), undefined);
        for (const id of [nativeDetail.id, controlDetail.id, 'pedFlag:0', 'native:N_0x580417101DDB492F']) {
            assert.ok(validReferenceId(id), id);
        }
        for (const id of [null, 38, 'control:038', 'control:-1', 'control:4294967296', 'pedFlag:0x30', 'native:',
            'native:GetEntityCoords()', 'native:GetEntityCoords\n', 'command:workbench.action.closeWindow']) {
            assert.equal(validReferenceId(id), false, String(id));
        }
        const links = referenceLinks(
            '[safe](https://docs.fivem.net/docs/) [command](command:evil) [script](javascript:evil) '
            + '[unsafe](https://user:password@example.test/private) [insecure](http://example.test/) '
            + '[duplicate](https://docs.fivem.net/docs/)',
            'command:workbench.action.closeWindow',
        );
        assert.deepEqual(links, ['https://docs.fivem.net/docs/']);
    }],
    ['Cfx native fragments become allowlisted official links without admitting arbitrary fragments or schemes', () => {
        const hash = 'F87683CDF73C3F6E';
        const official = `https://docs.fivem.net/natives/?_0x${hash}`;
        assert.equal(normalizeReferenceLink(`#_0x${hash}`), official);
        assert.equal(normalizeReferenceLink(`#\\_0x${hash}`), official, 'raw Markdown-escaped fragments use the same target');
        assert.equal(normalizeReferenceLink('#_0xabCd'), 'https://docs.fivem.net/natives/?_0xabCd');
        for (const value of ['#heading', '#_0x', '#_0x0123456789ABCDEF0', '#_0xABCG', '#_0xABCD/path', '#_0xABCD\n',
            'javascript:alert(1)', 'command:workbench.action.closeWindow', 'file:///private/file', 'data:text/html,unsafe',
            'http://docs.fivem.net/', '//docs.fivem.net/', 'https://user:password@docs.fivem.net/']) {
            assert.equal(normalizeReferenceLink(value), undefined, value);
        }
        const source = 'https://docs.fivem.net/natives/?_0x34F060F4BF92E018';
        const links = referenceLinks(
            `[SET_BLIP_ROTATION](#\\_0x${hash}) [same](#_0x${hash}) [also explicit](${official}) `
            + '[bad fragment](#heading) [bad hash](#_0xABCG) [command](command:evil) [script](javascript:evil)',
            source,
        );
        assert.deepEqual(links, [source, official], 'documented native targets are normalized and deduplicated');
    }],
    ['prose entity decoding passes only isolated entities to the decoder and returns literal text', () => {
        const calls: unknown[][] = [];
        const decoded: Record<string, string> = { '&amp;': '&', '&#35;': '#', '&#x3C;': '<', '&lt;': '<', '&gt;': '>' };
        const text = 'Rock &amp; &#35; &#x3C; &lt;script&gt;alert(1)&lt;/script&gt; &unknown; &broken <b>raw</b> &amp;lt;';
        const output = decodeMarkdownEntities(text, (...args: unknown[]) => {
            calls.push(args);
            assert.equal(args.length, 1, 'the decoder must never receive full source markup through replace callback arguments');
            const entity = args[0];
            assert.equal(typeof entity, 'string');
            assert.match(entity as string, /^&(?:#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]+);$/);
            return decoded[entity as string] ?? entity as string;
        });
        assert.equal(output, 'Rock & # < <script>alert(1)</script> &unknown; &broken <b>raw</b> &lt;');
        assert.equal(typeof output, 'string', 'decoded markup stays text for the renderer to append as a text node');
        assert.ok(calls.length > 0);
        assert.ok(calls.every(([entity]) => entity !== text));
    }],
    ['reference actions derive their text, hash and URLs from the selected backend detail', async () => {
        const h = harness();
        try {
            await select(h);
            assert.deepEqual(h.requests[1].params, { id: nativeDetail.id });
            for (const [requestId, action] of ['copy', 'copyHash', 'source', 'insert'].entries()) {
                await h.session.handle({
                    type: 'action', requestId: requestId + 3, id: nativeDetail.id, action,
                    text: 'FORGED', insertSnippet: 'FORGED', url: 'command:workbench.action.closeWindow',
                });
            }
            assert.deepEqual(h.copied, [nativeDetail.copyText, nativeDetail.hash]);
            assert.deepEqual(h.opened, [nativeDetail.sourceUrl]);
            assert.deepEqual(h.inserted, [{ detail: nativeDetail, target: 'first.lua' }]);
            assert.equal(h.requests.length, 2, 'actions use the already selected authoritative detail');
            const detailMessage = h.messages.find((message) => message.type === 'detail');
            assert.ok(detailMessage?.type === 'detail');
            assert.ok(detailMessage.links.includes('https://docs.fivem.net/docs/game-references/controls/'));
            const index = detailMessage.links.indexOf('https://docs.fivem.net/docs/game-references/controls/');
            await h.session.handle({ type: 'link', requestId: 7, id: nativeDetail.id, index, url: 'javascript:alert(1)' });
            assert.equal(h.opened.at(-1), detailMessage.links[index]);
        } finally { h.session.dispose(); }
    }],
    ['malformed and unselected IDs cannot request details or invoke actions', async () => {
        const h = harness();
        try {
            for (const message of [null, [], 'copy', {}, { type: 'unknown', requestId: 1 },
                { type: 'search', requestId: '1', params: {} },
                { type: 'search', requestId: 1, params: { query: 'x'.repeat(257) } },
                { type: 'search', requestId: 1, params: { kind: 'vehicles' } },
                { type: 'search', requestId: 1, params: { kind: ['native'] } },
                { type: 'search', requestId: 1, params: { side: 'anywhere' } },
                { type: 'search', requestId: 1, params: { offset: -1 } },
                { type: 'search', requestId: 1, params: { offset: 0.5 } },
                { type: 'detail', requestId: 1, id: 'native:../../secret' },
                { type: 'detail', requestId: 1, id: nativeDetail.id },
                { type: 'action', requestId: 1, id: nativeDetail.id, action: 'copy' },
                { type: 'link', requestId: 1, id: nativeDetail.id, index: 0 },
            ]) { await h.session.handle(message); }
            assert.equal(h.requests.length, 0);
            assert.deepEqual([h.copied, h.opened, h.inserted], [[], [], []]);
            await select(h);
            for (const message of [
                { type: 'action', requestId: 20, id: controlDetail.id, action: 'copy' },
                { type: 'action', requestId: 21, id: nativeDetail.id, action: 'runCommand' },
                { type: 'action', requestId: 21, id: nativeDetail.id, action: ['copy'] },
                { type: 'link', requestId: 22, id: nativeDetail.id, index: -1 },
                { type: 'link', requestId: 23, id: nativeDetail.id, index: 999 },
                { type: 'link', requestId: 24, id: nativeDetail.id, index: 0.5 },
                { type: 'link', requestId: 25, id: controlDetail.id, index: 0 },
            ]) { await h.session.handle(message); }
            assert.deepEqual([h.copied, h.opened, h.inserted], [[], [], []]);
        } finally { h.session.dispose(); }
    }],
    ['current backend failures are reported and invalid details never enable actions', async () => {
        const h = harness();
        try {
            const failed = h.session.handle({ type: 'search', requestId: 1, params: {} });
            h.requests[0].response.reject(new Error('Server restarting'));
            await failed;
            assert.ok(h.messages.some((message) => message.type === 'error' && message.scope === 'search' && message.requestId === 1));
            const search = h.session.handle({ type: 'search', requestId: 2, params: {} });
            h.requests[1].response.resolve(results(nativeDetail));
            await search;
            for (const [index, response] of [null, controlDetail, { ...nativeDetail, documentation: null }].entries()) {
                const requestId = index + 3;
                const selected = h.session.handle({ type: 'detail', requestId, id: nativeDetail.id });
                h.requests.at(-1)!.response.resolve(response);
                await selected;
                assert.ok(h.messages.some((message) => message.type === 'error' && message.scope === 'detail' && message.requestId === requestId));
                await h.session.handle({ type: 'action', requestId: requestId + 10, id: nativeDetail.id, action: 'copy' });
            }
            assert.deepEqual(h.copied, []);
            assert.ok(!h.messages.some((message) => message.type === 'detail'));
        } finally { h.session.dispose(); }
    }],
    ['unsupported source schemes cannot be opened by a selected reference', async () => {
        const h = harness();
        try {
            await select(h, { ...nativeDetail, sourceUrl: 'command:workbench.action.closeWindow' });
            await h.session.handle({ type: 'action', requestId: 3, id: nativeDetail.id, action: 'source' });
            assert.deepEqual(h.opened, []);
            assert.ok(h.messages.some((message) => message.type === 'error' && message.scope === 'action'));
        } finally { h.session.dispose(); }
    }],
    ['only the latest search response or failure may update the browser', async () => {
        const h = harness();
        try {
            const older = h.session.handle({ type: 'search', requestId: 1, params: { query: 'older' } });
            const newer = h.session.handle({ type: 'search', requestId: 2, params: { query: 'newer' } });
            h.requests[1].response.resolve(results(controlDetail));
            await newer;
            h.requests[0].response.resolve(results(nativeDetail));
            await older;
            assert.deepEqual(h.messages.filter((message) => message.type === 'results').map((message) => message.requestId), [2]);
            const before = h.requests.length;
            await h.session.handle({ type: 'detail', requestId: 3, id: nativeDetail.id });
            assert.equal(h.requests.length, before, 'obsolete search results cannot authorize detail requests');
            const staleFailure = h.session.handle({ type: 'search', requestId: 4, params: {} });
            const latest = h.session.handle({ type: 'search', requestId: 5, params: {} });
            h.requests.at(-1)!.response.resolve(results());
            await latest;
            h.requests.at(-2)!.response.reject(new Error('obsolete error'));
            await staleFailure;
            assert.ok(!h.messages.some((message) => message.type === 'error' && message.requestId === 4));
        } finally { h.session.dispose(); }
    }],
    ['detail races cannot change the selected action target', async () => {
        const h = harness();
        try {
            const search = h.session.handle({ type: 'search', requestId: 1, params: {} });
            h.requests[0].response.resolve(results(nativeDetail, controlDetail));
            await search;
            const older = h.session.handle({ type: 'detail', requestId: 2, id: nativeDetail.id });
            const newer = h.session.handle({ type: 'detail', requestId: 3, id: controlDetail.id });
            h.requests[2].response.resolve(controlDetail);
            await newer;
            h.requests[1].response.resolve(nativeDetail);
            await older;
            assert.deepEqual(h.messages.filter((message) => message.type === 'detail').map((message) => message.detail.id), [controlDetail.id]);
            await h.session.handle({ type: 'action', requestId: 4, id: nativeDetail.id, action: 'copy' });
            assert.deepEqual(h.copied, []);
            await h.session.handle({ type: 'action', requestId: 5, id: controlDetail.id, action: 'copy' });
            assert.deepEqual(h.copied, ['38']);
            await h.session.handle({ type: 'action', requestId: 6, id: controlDetail.id, action: 'copyHash' });
            assert.deepEqual(h.copied, ['38'], 'numeric references have no hash to copy');
        } finally { h.session.dispose(); }
    }],
    ['a new search or panel disposal invalidates outstanding detail requests', async () => {
        const h = harness();
        try {
            const initial = h.session.handle({ type: 'search', requestId: 1, params: {} });
            h.requests[0].response.resolve(results(nativeDetail));
            await initial;
            const oldDetail = h.session.handle({ type: 'detail', requestId: 2, id: nativeDetail.id });
            const nextSearch = h.session.handle({ type: 'search', requestId: 3, params: { kind: 'control' } });
            h.requests[1].response.resolve(nativeDetail);
            await oldDetail;
            assert.ok(!h.messages.some((message) => message.type === 'detail'));
            h.requests[2].response.resolve(results(controlDetail));
            await nextSearch;
            const disposedDetail = h.session.handle({ type: 'detail', requestId: 4, id: controlDetail.id });
            h.session.dispose();
            const before = h.messages.length;
            h.requests[3].response.resolve(controlDetail);
            await disposedDetail;
            assert.equal(h.messages.length, before);
            await h.session.handle({ type: 'action', requestId: 5, id: controlDetail.id, action: 'copy' });
            assert.deepEqual(h.copied, []);
        } finally { h.session.dispose(); }
    }],
    ['disposing cancels pending responses and pending editor insertions', async () => {
        const h = harness();
        const pending = h.session.handle({ type: 'search', requestId: 1, params: {} });
        h.session.dispose();
        h.requests[0].response.resolve(results(nativeDetail));
        await pending;
        assert.deepEqual(h.messages, []);
        await h.session.handle({ type: 'search', requestId: 2, params: {} });
        assert.equal(h.requests.length, 1);

        const action = harness();
        await select(action);
        action.state.insertGate = deferred<void>();
        const insertion = action.session.handle({ type: 'action', requestId: 3, id: nativeDetail.id, action: 'insert' });
        action.session.dispose();
        action.state.insertGate.resolve();
        await insertion;
        assert.deepEqual(action.inserted, []);
        assert.ok(!action.messages.some((message) => message.type === 'actionComplete'));
    }],
    ['an insertion captures its Lua target and is cancelled when selection changes', async () => {
        const h = harness();
        try {
            await select(h);
            h.state.insertGate = deferred<void>();
            const pending = h.session.handle({ type: 'action', requestId: 3, id: nativeDetail.id, action: 'insert' });
            h.state.target = 'second.lua';
            h.state.insertGate.resolve();
            await pending;
            assert.equal(h.inserted[0]?.target, 'first.lua', 'a later editor switch must not redirect an in-flight action');

            h.state.insertGate = deferred<void>();
            const obsolete = h.session.handle({ type: 'action', requestId: 4, id: nativeDetail.id, action: 'insert' });
            const search = h.session.handle({ type: 'search', requestId: 5, params: {} });
            h.requests.at(-1)!.response.resolve(results(controlDetail));
            await search;
            h.state.insertGate.resolve();
            await obsolete;
            assert.equal(h.inserted.length, 1, 'changing reference selection cancels old pending insertions');
        } finally { h.session.dispose(); }
    }],
    ['Insert edits the remembered Lua selection after focus moves to another document', async () => {
        const lua = await vscode.workspace.openTextDocument({ language: 'lua', content: 'local point = PLACEHOLDER\n' });
        const text = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'This document must stay unchanged.' });
        const editor = await vscode.window.showTextDocument(lua, { preview: false });
        const start = lua.getText().indexOf('PLACEHOLDER');
        editor.selection = new vscode.Selection(lua.positionAt(start), lua.positionAt(start + 'PLACEHOLDER'.length));
        const tracker = new LuaEditorTargetTracker();
        try {
            await vscode.window.showTextDocument(text, { preview: false });
            const target = tracker.capture();
            assert.equal(target?.document, lua);
            await tracker.insert(nativeDetail, target, () => true);
            assert.equal(lua.getText(), 'local point = GetEntityCoords(entity)\n', 'snippet placeholders become editable default text');
            assert.equal(text.getText(), 'This document must stay unchanged.');
            assert.equal(vscode.window.activeTextEditor?.document, lua);
        } finally {
            tracker.dispose();
            await closeUntitled(lua);
            await closeUntitled(text);
        }
    }],
    ['Insert refuses missing, edited, closed or cancelled Lua targets', async () => {
        const text = await vscode.workspace.openTextDocument({ language: 'plaintext', content: '' });
        await vscode.window.showTextDocument(text, { preview: false });
        const tracker = new LuaEditorTargetTracker();
        const lua = await vscode.workspace.openTextDocument({ language: 'lua', content: 'local value = ' });
        try {
            assert.equal(tracker.capture(), undefined);
            await assert.rejects(tracker.insert(controlDetail, undefined, () => true), /Lua file/);
            const editor = await vscode.window.showTextDocument(lua, { preview: false });
            const target = await waitFor('remembered Lua insertion target', () => tracker.capture());
            await editor.edit((edit) => edit.insert(lua.positionAt(lua.getText().length), '1'));
            const changed = lua.getText();
            await assert.rejects(tracker.insert(controlDetail, target, () => true), /changed or closed/);
            const fresh = tracker.capture();
            assert.ok(fresh);
            await assert.rejects(tracker.insert(controlDetail, fresh, () => false), /changed or closed/);
            assert.equal(lua.getText(), changed, 'refused insertions must not edit text');
            await closeUntitled(lua);
            await waitFor('closed untitled Lua document', () => lua.isClosed ? true : undefined);
            await assert.rejects(tracker.insert(controlDetail, fresh, () => true), /changed or closed/);
            assert.equal(tracker.capture(), undefined);
        } finally {
            tracker.dispose();
            await closeUntitled(lua);
            await closeUntitled(text);
        }
    }],
    ['Open FiveM Reference reuses its tab and can reopen after closing', async () => {
        const extension = vscode.extensions.getExtension('qbox.qbx-lua');
        assert.ok(extension);
        await extension.activate();
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('qbxLua.openReference'));
        const before = new Set(webviewTabs());
        await vscode.commands.executeCommand('qbxLua.openReference');
        const first = await waitFor('the reference webview tab', () => webviewTabs().find((tab) => !before.has(tab)));
        assert.ok(first.input instanceof vscode.TabInputWebview);
        const viewType = first.input.viewType;
        try {
            await vscode.commands.executeCommand('qbxLua.openReference');
            await vscode.commands.executeCommand('qbxLua.openReference');
            assert.equal(webviewTabs(viewType).length, 1, 'repeated commands must reveal the existing tab');
            await vscode.window.tabGroups.close(webviewTabs(viewType), true);
            await waitFor('reference tab disposal', () => webviewTabs(viewType).length === 0 ? true : undefined);
            await vscode.commands.executeCommand('qbxLua.openReference');
            await waitFor('reference tab reopening', () => webviewTabs(viewType).length === 1 ? true : undefined);
        } finally {
            await vscode.window.tabGroups.close(webviewTabs(viewType), true);
        }
    }],
];

/** Reference browser protocol and editor integration; no external pages or real clipboard writes. */
export async function runReferenceBrowserTests(): Promise<void> {
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
        throw new Error(`${failures.length} reference browser test(s) failed: ${failures.join(', ')}`);
    }
}
