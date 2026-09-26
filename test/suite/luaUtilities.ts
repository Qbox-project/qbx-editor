import * as assert from 'node:assert/strict';
import { hexColor, joaatHash, jsonToLua, luaString, MAX_JSON_BYTES, MAX_LUA_BYTES, rgbColor } from '../../src/luaUtilitiesCore';
import { getLuaUtilitiesHtml } from '../../src/luaUtilitiesHtml';
import { LuaUtilitiesSession, type UtilityActions, type UtilityMessage } from '../../src/luaUtilitiesSession';

type Test = [string, () => void | Promise<void>];
function deferred(): { promise: Promise<void>; resolve(): void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}
function sessionHarness(overrides: Partial<UtilityActions<{ version: number }>> = {}) {
    const messages: UtilityMessage[] = [];
    const copied: string[] = [];
    const inserted: string[] = [];
    const target = { version: 7 };
    const session = new LuaUtilitiesSession((message) => messages.push(message), {
        capture: () => ({ target, name: 'selected.lua · line 2', selection: '{"value":true}' }),
        copy: async (text) => { copied.push(text); },
        insert: async (text, captured, current) => { assert.equal(captured, target); assert.equal(current(), true); inserted.push(text); },
        ...overrides,
    });
    return { session, messages, copied, inserted, target };
}

const coreTests: Test[] = [
    ['Lua joaat matches known asset hashes and folds only supported ASCII casing', () => {
        assert.deepEqual(joaatHash('adder'), { hex: '0xB779A091', signed: '-1216765807', unsigned: '3078201489' });
        assert.deepEqual(joaatHash('AdDeR'), joaatHash('adder'));
        assert.equal(joaatHash('WEAPON_PISTOL').hex, '0x1B06D571');
        assert.equal(joaatHash('weapon_unarmed').hex, '0xA2719263');
        assert.deepEqual(joaatHash(''), { hex: '0x00000000', signed: '0', unsigned: '0' });
        assert.notDeepEqual(joaatHash(' adder'), joaatHash('adder'), 'input is not silently trimmed');
        for (const value of ['É', 'é', 'İ', '😀', 'a\0b', 'a\nb']) { assert.throws(() => joaatHash(value), /ASCII/, JSON.stringify(value)); }
        assert.throws(() => joaatHash('a'.repeat(4097)), /4,096/);
    }],
    ['Lua color helpers round-trip channels, shorthand and alpha with strict range checks', () => {
        assert.deepEqual(hexColor('#08f'), rgbColor(0, 136, 255));
        assert.deepEqual(hexColor(' #08f8 '), rgbColor(0, 136, 255, 136));
        assert.equal(hexColor('#aabbccdd').hexAlpha, '#AABBCCDD');
        assert.equal(rgbColor(1, 2, 3, 4).table, '{ r = 1, g = 2, b = 3, a = 4 }');
        assert.equal(rgbColor(1, 2, 3).vector, 'vec3(1, 2, 3)');
        assert.equal(rgbColor(255, 0, 4, 0).rgba, '255, 0, 4, 0');
        for (const invalid of ['#12', '#12345', '#1234567', '#gggggg', 'rgb(0,0,0)', '0x123456']) { assert.throws(() => hexColor(invalid)); }
        for (const channel of [-1, 256, 0.5, NaN, Infinity]) { assert.throws(() => rgbColor(channel, 0, 0), /whole numbers/); }
    }],
    ['JSON conversion emits safe Lua keys and literal strings with deterministic source order', () => {
        const result = jsonToLua('{"2":"two","1":"one","end":true,"a-b":"quote\\\"\\\\path","__proto__":{"x":1},"valid_name":[1,false]}');
        assert.equal(result.text, '{\n    ["2"] = "two",\n    ["1"] = "one",\n    ["end"] = true,\n    ["a-b"] = "quote\\\"\\\\path",\n    __proto__ = {\n        x = 1,\n    },\n    valid_name = {\n        [1] = 1,\n        [2] = false,\n    },\n}');
        assert.deepEqual(result.warnings, []);
        const hostile = '"]; os.execute("anything"); --';
        assert.ok(jsonToLua(JSON.stringify({ [hostile]: '<script>alert(1)</script>' })).text.includes(`[${luaString(hostile)}] = "<script>alert(1)</script>"`));
        assert.equal(luaString('\\u1234'), '"\\\\u1234"', 'literal backslash-u must not become a Unicode escape');
        assert.equal(luaString('\0' + '123\n\t😀'), '"\\u{0}123\\n\\t😀"');
        assert.equal(luaString('\u202e'), '"\\u{202e}"');
        assert.throws(() => jsonToLua('"\\ud800"'), /unpaired/);
        assert.throws(() => jsonToLua('{"\\udfff":1}'), /unpaired/);
    }],
    ['JSON numeric tokens retain full 64-bit integers and reject lossy or out-of-range conversions', () => {
        assert.equal(jsonToLua('[9007199254740993,9223372036854775807,-9223372036854775808]').text,
            '{\n    [1] = 9007199254740993,\n    [2] = 9223372036854775807,\n    [3] = (-9223372036854775807 - 1),\n}');
        const decimals = jsonToLua('[1.2300,1e-3,-0]');
        assert.ok(decimals.text.includes('1.2300'));
        assert.ok(decimals.text.includes('1e-3'));
        assert.ok(decimals.text.includes('-0.0'));
        assert.ok(decimals.warnings.some((warning) => warning.includes('floating-point')));
        for (const invalid of ['9223372036854775808', '-9223372036854775809', '123456789012345678901234', '1e999', '1e-999', '9007199254740993.0', '1e19']) { assert.throws(() => jsonToLua(invalid), /range|precision/, invalid); }
        assert.equal(jsonToLua('"90071992547409931234567890"').text, '"90071992547409931234567890"');
    }],
    ['JSON null conversion is explicit and malformed, duplicate and excessive input is rejected', () => {
        const preserved = jsonToLua('[null,1]');
        assert.ok(preserved.text.includes('[1] = json.null'));
        assert.ok(preserved.warnings.some((warning) => warning.includes('json.null')));
        const removed = jsonToLua('[null,1]', 'nil');
        assert.ok(removed.text.includes('[1] = nil,\n    [2] = 1'));
        assert.ok(removed.warnings.some((warning) => warning.includes('holes')));
        assert.equal(jsonToLua('{}').text, '{}'); assert.equal(jsonToLua('[]').text, '{}');
        for (const invalid of ['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '{"x":1,}', '[1,]', '// comment\n{}', 'NaN', '', '{} {}']) { assert.throws(() => jsonToLua(invalid), /JSON|Duplicate/); }
        assert.throws(() => jsonToLua(' '.repeat(MAX_JSON_BYTES + 1)), /128 KiB/);
        assert.throws(() => jsonToLua('['.repeat(65) + '0' + ']'.repeat(65)), /nesting/);
        assert.throws(() => jsonToLua('[' + '0,'.repeat(10001) + '0]'), /10,000/);
        assert.throws(() => jsonToLua('['.repeat(64) + '0,'.repeat(3000) + '0' + ']'.repeat(64)), /512 KiB/);
    }],
    ['Lua utility session ignores arbitrary protocols and bounds clipboard and insertion payloads', async () => {
        const h = sessionHarness();
        for (const message of [null, [], { type: 'openExternal', requestId: 1, url: 'command:evil' }, { type: 'insert', requestId: -1, text: 'bad' }, { type: 'copy', requestId: 0.1, text: 'bad' }]) { await h.session.handle(message); }
        assert.deepEqual(h.copied, []); assert.deepEqual(h.inserted, []);
        await h.session.handle({ type: 'copy', requestId: 2, text: 'x'.repeat(MAX_LUA_BYTES + 1) });
        assert.equal(h.messages.at(-1)?.type, 'error');
        await h.session.handle({ type: 'copy', requestId: 3, text: '$0 ${1:x} \\literal' });
        assert.deepEqual(h.copied, ['$0 ${1:x} \\literal']);
        await h.session.handle({ type: 'selection', requestId: 4 });
        assert.ok(h.messages.some((message) => message.type === 'selection' && message.text === '{"value":true}'));
        await h.session.handle({ type: 'insert', requestId: 5, text: '{ x = 1 }', uri: 'file:///arbitrary.lua', version: 999 });
        assert.deepEqual(h.inserted, ['{ x = 1 }']);
        assert.ok(h.messages.some((message) => message.type === 'target' && message.name === undefined));
        h.session.dispose();
    }],
    ['Lua utility actions serialize, invalidate captured work and stop posting after disposal', async () => {
        const pending = deferred();
        let current: (() => boolean) | undefined;
        const h = sessionHarness({ insert: async (_text, _target, valid) => { current = valid; await pending.promise; assert.equal(valid(), false); } });
        const first = h.session.handle({ type: 'insert', requestId: 1, text: '42' });
        await h.session.handle({ type: 'copy', requestId: 2, text: 'unexpected' });
        assert.deepEqual(h.copied, []);
        assert.ok(h.messages.some((message) => message.type === 'error' && message.requestId === 2));
        h.session.capture();
        assert.equal(current?.(), false);
        h.session.dispose(); const count = h.messages.length;
        pending.resolve(); await first;
        assert.equal(h.messages.length, count);
        await h.session.handle({ type: 'copy', requestId: 3, text: 'unexpected' });
        assert.deepEqual(h.copied, []);
    }],
    ['Lua utilities HTML has offline CSP and escapes asset and nonce attributes', () => {
        const html = getLuaUtilitiesHtml('https://local.invalid/" onload="bad', 'test" bad="1');
        assert.ok(html.includes("connect-src 'none'"));
        assert.ok(html.includes("default-src 'none'"));
        assert.ok(html.includes("base-uri 'none'"));
        assert.ok(html.includes('nonce="test&quot; bad=&quot;1"'));
        assert.ok(html.includes('src="https://local.invalid/&quot; onload=&quot;bad"'));
        assert.ok(!html.includes('<iframe') && !html.includes('onclick='));
        assert.ok(html.includes('.notice{color:var(--vscode-foreground,'));
        assert.ok(html.includes('.notice.error{color:var(--vscode-errorForeground,'));
    }],
];

async function run(tests: Test[]): Promise<void> {
    let failures = 0;
    for (const [name, body] of tests) { try { await body(); console.log(`  ✓ ${name}`); } catch (reason) { failures++; console.error(`  ✗ ${name}`, reason); } }
    assert.equal(failures, 0, `${failures} Lua utility tests failed`);
}
export async function runLuaUtilitiesCoreTests(): Promise<void> { await run(coreTests); }

export async function runLuaUtilitiesTests(): Promise<void> {
    await run(coreTests);
    const vscode = await import('vscode');
    const { LuaEditorTargetTracker } = await import('../../src/referenceBrowser.js');
    const { LuaUtilitiesBrowser } = await import('../../src/luaUtilitiesBrowser.js');
    await run([
        ['Real Lua utilities webview applies the initial target and a recaptured target', async () => {
            const extension = vscode.extensions.getExtension('qbox.qbx-lua'); assert.ok(extension);
            const document = await vscode.workspace.openTextDocument({ language: 'lua', content: 'local value = 1\nprint(value)\n' });
            let editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
            editor.selection = new vscode.Selection(1, 0, 1, 12);
            const browser = new LuaUtilitiesBrowser(extension.extensionUri);
            const tabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith('qbxLua.luaUtilities'));
            const rendered = async (line: number, replace: boolean): Promise<void> => {
                let subscription: import('vscode').Disposable | undefined;
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    await new Promise<void>((resolve, reject) => {
                        subscription = browser.onDidRenderTarget((state) => {
                            if (!state.name?.includes(` · line ${line}`)) { return; }
                            try {
                                assert.equal(state.name.includes('replace selection'), replace);
                                assert.equal(state.canInsert, true, 'the rendered insert buttons must be enabled for the received target');
                                resolve();
                            } catch (error) { reject(error); }
                        });
                        timer = setTimeout(() => reject(new Error('The real Lua utilities webview did not apply the captured editor target within 10 seconds.')), 10_000);
                        browser.show();
                    });
                } finally { subscription?.dispose(); if (timer) { clearTimeout(timer); } }
            };
            try {
                await rendered(2, true);
                assert.equal(tabs().length, 1);
                editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
                editor.selection = new vscode.Selection(0, 0, 0, 0);
                await rendered(1, false);
                assert.equal(tabs().length, 1, 'recapture should reuse the existing webview');
                await vscode.window.tabGroups.close(tabs(), true);
                await rendered(1, false);
                assert.equal(tabs().length, 1, 'reopening should complete a fresh host/webview handshake');
            } finally {
                browser.dispose(); await vscode.window.tabGroups.close(tabs(), true);
                await vscode.window.showTextDocument(document); await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
            }
        }],
        ['Lua utility insertion uses the captured selection literally and rejects changed documents', async () => {
            const document = await vscode.workspace.openTextDocument({ language: 'lua', content: 'before\n{"value":1}\nafter' });
            let editor = await vscode.window.showTextDocument(document);
            editor.selection = new vscode.Selection(1, 0, 1, 11);
            const tracker = new LuaEditorTargetTracker();
            try {
                const target = tracker.capture(); assert.ok(target);
                const text = '{ value = "$0 ${1:not-a-snippet}" }';
                await tracker.insert({ insertText: text }, target, () => true);
                assert.equal(document.getText(), `before\n${text}\nafter`);
                await assert.rejects(tracker.insert({ insertText: 'lost edit' }, target, () => true), /changed|closed/);
                editor = await vscode.window.showTextDocument(document);
                const second = tracker.capture(); assert.ok(second);
                await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), '-- changed\n'));
                await assert.rejects(tracker.insert({ insertText: 'lost edit' }, second, () => true), /changed|closed/);
            } finally { tracker.dispose(); await vscode.window.showTextDocument(document); await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor'); }
        }],
        ['Lua utility command opens one reusable panel with packaged lazy assets', async () => {
            const commands = await vscode.commands.getCommands(true);
            assert.ok(commands.includes('qbxLua.openLuaUtilities'));
            const before = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith('qbxLua.luaUtilities'));
            await vscode.commands.executeCommand('qbxLua.openLuaUtilities');
            await vscode.commands.executeCommand('qbxLua.openLuaUtilities');
            const panels = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith('qbxLua.luaUtilities'));
            // TabGroups is updated asynchronously by the workbench after the command returns.
            const deadline = Date.now() + 5000;
            while (!panels().length && Date.now() < deadline) { await new Promise((resolve) => setTimeout(resolve, 50)); }
            assert.equal(panels().length, 1);
            if (!before.length) { await vscode.window.tabGroups.close(panels()); }
        }],
    ]);
}
