import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { runRconTests } from './rcon';
import { runResourceTests } from './resources';
import { runResourceControlTests } from './resourceControls';
import { runReferenceBrowserTests } from './referenceBrowser';
import { runSnippetTests } from './snippets';
import { runResourceWizardTests } from './resourceWizard';
import { runResourceDetailsTests } from './resourceDetails';
import { runRuntimeToolsTests } from './runtimeTools';
import { runRuntimeLogCoreTests } from './runtimeLogCore';
import { runNuiToolsTests } from './nuiTools';
import { runNuiPreviewServerTests } from './nuiPreviewServer';
import { runLuaUtilitiesTests } from './luaUtilities';
import { runAssistantToolsTests } from './assistantTools';
import { runAssetTests } from './assets';
import { runAssetHostTests } from './assetsHost';

type Test = [name: string, body: () => Promise<void>];

function workspaceFile(relative: string): vscode.Uri {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'the fixture workspace should be open');
    return vscode.Uri.file(path.join(folder.uri.fsPath, relative));
}

function positionOf(document: vscode.TextDocument, needle: string, delta: number): vscode.Position {
    const offset = document.getText().indexOf(needle);
    assert.ok(offset >= 0, `${needle} not found`);
    return document.positionAt(offset + delta);
}

async function waitFor<T>(what: string, probe: () => Promise<T | undefined> | T | undefined, timeoutMs = 20000): Promise<T> {
    const started = Date.now();
    for (;;) {
        const value = await probe();
        if (value !== undefined) {
            return value;
        }
        if (Date.now() - started > timeoutMs) {
            throw new Error(`timed out waiting for ${what}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
}

function hoverText(hovers: vscode.Hover[]): string {
    return hovers
        .flatMap((hover) => hover.contents)
        .map((content) => (typeof content === 'string' ? content : content.value))
        .join('\n');
}

const tests: Test[] = [
    ['RCON transport uses exact targets and bounded authenticated responses', runRconTests],
    ['resource discovery follows folders and manifest lifecycle', runResourceTests],
    ['resource connection storage and Explorer integration', runResourceControlTests],
    ['reference browser search, actions and editor integration', runReferenceBrowserTests],
    ['snippet browser storage, actions and editor integration', runSnippetTests],
    ['resource wizard templates, creation and cancellation', runResourceWizardTests],
    ['resource details snapshots, navigation and editor integration', runResourceDetailsTests],
    ['runtime logs and workspace health editor integration', runRuntimeToolsTests],
    ['runtime log following, bounds and trace parsing', runRuntimeLogCoreTests],
    ['NUI presets, resource lifecycle and real editor preview', runNuiToolsTests],
    ['NUI local asset serving, isolation and lifetime', runNuiPreviewServerTests],
    ['Lua utility calculations, conversion and editor insertion', runLuaUtilitiesTests],
    ['Structured assistant tools, portable MCP and editor API', runAssistantToolsTests],
    ['Asset formats, texture decoding and bounded inventory', runAssetTests],
    ['Asset browser resource lifecycle and real editor rendering', runAssetHostTests],
    [
        'activates and answers status requests',
        async () => {
            const extension = vscode.extensions.getExtension('qbox.qbx-lua');
            assert.ok(extension, 'extension should be installed in the test host');
            await vscode.workspace.openTextDocument(workspaceFile('myresource/client/main.lua')).then((doc) => vscode.window.showTextDocument(doc));
            await waitFor('activation', () => (extension.isActive ? true : undefined));
            const commands = await vscode.commands.getCommands(true);
            for (const command of ['qbxLua.restartServer', 'qbxLua.reindex', 'qbxLua.showStatus', 'qbxLua.showOutput', 'qbxLua.showSnippets', 'qbxLua.openReference']) {
                assert.ok(commands.includes(command), `${command} should be registered`);
            }
        },
    ],
    [
        'problems are reported for files that were never opened',
        async () => {
            const uri = workspaceFile('myresource/server/main.lua');
            const diagnostics = await waitFor('workspace diagnostics', () => {
                const found = vscode.languages.getDiagnostics(uri).filter((d) => d.source === 'qbx-lint');
                return found.length > 0 ? found : undefined;
            });
            assert.equal(diagnostics[0].severity, vscode.DiagnosticSeverity.Warning);
        },
    ],
    [
        'hover shows documentation from another resource',
        async () => {
            const document = await vscode.workspace.openTextDocument(workspaceFile('myresource/client/main.lua'));
            const position = positionOf(document, 'MyLib.round(1.2345', 8);
            const text = await waitFor('hover', async () => {
                const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', document.uri, position);
                const value = hoverText(hovers ?? []);
                return value.includes('MyLib.round') ? value : undefined;
            });
            assert.match(text, /function MyLib\.round\(value: number, decimals\?: integer\): number/);
            assert.match(text, /Rounds a number/);
        },
    ],
    [
        'native argument hovers explain controls and ped flags in the editor',
        async () => {
            const document = await vscode.workspace.openTextDocument(workspaceFile('myresource/client/main.lua'));
            const editor = await vscode.window.showTextDocument(document);
            const original = document.getText();
            const control = 'IsControlJustPressed(0, 38)';
            const flag = 'SetPedConfigFlag(PlayerPedId(), 48, true)';
            try {
                await editor.edit((edit) => edit.insert(document.positionAt(original.length), `\n${control}\n${flag}\n`));
                for (const [call, literal, expected] of [[control, '38', 'INPUT_PICKUP'], [flag, '48', 'CPED_CONFIG_FLAG_BlockWeaponSwitching']]) {
                    const position = positionOf(document, call, call.indexOf(literal));
                    const hovers = await waitFor('native argument hover', async () => {
                        const result = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', document.uri, position);
                        return hoverText(result ?? []).includes(expected) ? result : undefined;
                    });
                    const text = hoverText(hovers);
                    assert.match(text, /https:\/\/(docs\.fivem\.net|github\.com\/citizenfx)/);
                    assert.ok(hovers.some((hover) => hover.range && document.getText(hover.range) === literal), 'hover range should cover only the ID');
                    if (call === control) {
                        assert.match(text, /\bE\b/);
                        assert.match(text, /\bLB\b/);
                        assert.match(text, /default/i);
                    }
                }
                const groupPosition = positionOf(document, control, control.indexOf('0'));
                const groupHover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', document.uri, groupPosition);
                assert.ok(!hoverText(groupHover ?? []).includes('INPUT_NEXT_CAMERA'), 'pad group zero must not be mistaken for control zero');
            } finally {
                const whole = new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length));
                await editor.edit((edit) => edit.replace(whole, original));
                await document.save();
            }
        },
    ],
    [
        'completion offers members, natives and event names',
        async () => {
            const document = await vscode.workspace.openTextDocument(workspaceFile('myresource/client/main.lua'));
            const members = await vscode.commands.executeCommand<vscode.CompletionList>(
                'vscode.executeCompletionItemProvider',
                document.uri,
                positionOf(document, 'MyLib.round(1.2345', 6),
            );
            const labels = members.items.map((item) => (typeof item.label === 'string' ? item.label : item.label.label));
            assert.ok(labels.includes('createGarage') && labels.includes('round'), labels.join(', '));

            const events = await vscode.commands.executeCommand<vscode.CompletionList>(
                'vscode.executeCompletionItemProvider',
                document.uri,
                positionOf(document, "'myresource:server:ping'", 3),
            );
            const eventLabels = events.items.map((item) => (typeof item.label === 'string' ? item.label : item.label.label));
            assert.ok(eventLabels.includes('myresource:server:ping'), eventLabels.join(', '));
        },
    ],
    [
        'event suggestions keep their namespace while typing colons',
        async () => {
            const document = await vscode.workspace.openTextDocument(workspaceFile('myresource/client/main.lua'));
            const editor = await vscode.window.showTextDocument(document);
            const original = document.getText();
            const end = document.positionAt(original.length);
            try {
                await editor.edit((edit) => edit.insert(end, "\nTriggerServerEvent('')"));
                const start = document.positionAt(document.getText().length - 2);
                editor.selection = new vscode.Selection(start, start);
                await vscode.commands.executeCommand('editor.action.triggerSuggest');
                for (const character of 'myresource:server:p') {
                    await vscode.commands.executeCommand('type', { text: character });
                    const cursor = editor.selection.active;
                    await waitFor('event completion range', async () => {
                        const list = await vscode.commands.executeCommand<vscode.CompletionList>(
                            'vscode.executeCompletionItemProvider', document.uri, cursor,
                        );
                        const event = list.items.find((item) =>
                            (typeof item.label === 'string' ? item.label : item.label.label) === 'myresource:server:ping');
                        const range = event?.range;
                        const insert = range instanceof vscode.Range ? range : range?.inserting;
                        return insert?.start.isEqual(start) && insert.end.isEqual(cursor) ? true : undefined;
                    });
                    // Let the suggest widget consume the same document change before the next key.
                    await new Promise((resolve) => setTimeout(resolve, 100));
                }
                await vscode.commands.executeCommand('acceptSelectedSuggestion');
                assert.equal(document.lineAt(start.line).text, "TriggerServerEvent('myresource:server:ping')");
            } finally {
                await vscode.commands.executeCommand('hideSuggestWidget');
                const whole = new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length));
                await editor.edit((edit) => edit.replace(whole, original));
                await document.save();
            }
        },
    ],
    [
        'framework callbacks expose local payloads and navigate to their own handlers',
        async () => {
            const server = await vscode.workspace.openTextDocument(workspaceFile('myresource/server/main.lua'));
            const client = await vscode.workspace.openTextDocument(workspaceFile('myresource/client/main.lua'));
            const originals = [server, client].map((document) => ({ document, text: document.getText() }));
            const edit = new vscode.WorkspaceEdit();
            edit.insert(server.uri, server.positionAt(server.getText().length), `
local CallbackQB = exports['qb-core']:GetCoreObject()
local CallbackESX = exports['es_extended']:getSharedObject()
---@param source integer
---@param cb function
---@param garageId string
local function editorQbHandler(source, cb, garageId) cb(garageId) end
---@param source integer
---@param cb function
---@param vehicleId integer
local function editorEsxHandler(source, cb, vehicleId) cb(vehicleId) end
CallbackQB.Functions.CreateCallback('editor:lookup', editorQbHandler)
CallbackESX.RegisterServerCallback('editor:lookup', editorEsxHandler)
`);
            edit.insert(client.uri, client.positionAt(client.getText().length), `
local CallbackQB = exports['qb-core']:GetCoreObject()
local CallbackESX = exports['es_extended']:getSharedObject()
CallbackQB.Functions.TriggerCallback('editor:lookup', function(result) end, 'central')
CallbackESX.TriggerServerCallback('editor:lookup', function(result) end, 42)
`);
            try {
                assert.ok(await vscode.workspace.applyEdit(edit));
                for (const [trigger, registration, payload, label] of [
                    ['CallbackQB.Functions.TriggerCallback', 'CallbackQB.Functions.CreateCallback', "'central'", 'garageId: string'],
                    ['CallbackESX.TriggerServerCallback', 'CallbackESX.RegisterServerCallback', '42', 'vehicleId: integer'],
                ]) {
                    const callStart = client.getText().indexOf(`${trigger}('editor:lookup'`);
                    const namePosition = client.positionAt(callStart + trigger.length + 3);
                    const suggestions = await waitFor('framework callback completion', async () => {
                        const result = await vscode.commands.executeCommand<vscode.CompletionList>(
                            'vscode.executeCompletionItemProvider', client.uri, namePosition,
                        );
                        return result?.items.find((item) =>
                            (typeof item.label === 'string' ? item.label : item.label.label) === 'editor:lookup');
                    });
                    assert.match(suggestions.detail ?? '', new RegExp(label));
                    const payloadPosition = client.positionAt(client.getText().indexOf(payload, callStart) + 1);
                    const signature = await vscode.commands.executeCommand<vscode.SignatureHelp>(
                        'vscode.executeSignatureHelpProvider', client.uri, payloadPosition,
                    );
                    assert.ok(signature?.signatures[0].label.includes(label), JSON.stringify(signature));
                    assert.equal(signature.activeParameter, 2);
                    const locations = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
                        'vscode.executeDefinitionProvider', client.uri, namePosition,
                    );
                    assert.equal(locations.length, 1, JSON.stringify(locations));
                    const location = locations[0];
                    const target = 'targetUri' in location ? location.targetUri : location.uri;
                    const range = 'targetUri' in location ? (location.targetSelectionRange ?? location.targetRange) : location.range;
                    assert.equal(target.toString(), server.uri.toString());
                    assert.ok(server.lineAt(range.start.line).text.startsWith(registration));
                    const hints = await vscode.commands.executeCommand<vscode.InlayHint[]>(
                        'vscode.executeInlayHintProvider', client.uri, client.lineAt(payloadPosition.line).range,
                    );
                    assert.ok(hints.some((hint) => hint.label === `${label.split(':')[0]}:`), JSON.stringify(hints));
                }
            } finally {
                const restore = new vscode.WorkspaceEdit();
                for (const { document, text } of originals) {
                    restore.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
                }
                assert.ok(await vscode.workspace.applyEdit(restore));
                await Promise.all(originals.map(({ document }) => document.save()));
            }
        },
    ],
    [
        'snippets are offered while typing a statement',
        async () => {
            const document = await vscode.workspace.openTextDocument(workspaceFile('myresource/client/main.lua'));
            const editor = await vscode.window.showTextDocument(document);
            const end = document.positionAt(document.getText().length);
            const original = document.getText();
            try {
                for (const [typed, label] of [['CreateThr', 'CreateThread'], ['oncac', 'onCache'], ['thre', 'thread']]) {
                    await editor.edit((edit) => edit.replace(new vscode.Range(end, document.positionAt(document.getText().length)), `\n${typed}`));
                    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
                        'vscode.executeCompletionItemProvider',
                        document.uri,
                        document.positionAt(document.getText().length),
                    );
                    const found = list.items.filter((item) => typeof item.label !== 'string' && item.label.description === 'snippet');
                    const labels = found.map((item) => (typeof item.label === 'string' ? item.label : item.label.label));
                    assert.ok(labels.includes(label), `${typed}: ${labels.join(', ') || 'no snippets'} of ${list.items.length} items`);
                }
            } finally {
                const whole = new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length));
                await editor.edit((edit) => edit.replace(whole, original));
                await document.save();
            }
        },
    ],
    [
        'diagnostics come from qbx-lint with manifest context',
        async () => {
            const uri = workspaceFile('myresource/server/main.lua');
            await vscode.workspace.openTextDocument(uri).then((doc) => vscode.window.showTextDocument(doc));
            const diagnostics = await waitFor('diagnostics', () => {
                const found = vscode.languages.getDiagnostics(uri).filter((d) => d.source === 'qbx-lint');
                return found.length > 0 ? found : undefined;
            });
            const codes = diagnostics.map((d) => String(typeof d.code === 'object' ? d.code.value : d.code));
            assert.ok(codes.includes('fivem/import-not-declared'), codes.join(', '));
        },
    ],
    [
        'formats a document and reports cross-file problems',
        async () => {
            const uri = workspaceFile('shop/client.lua');
            const document = await vscode.workspace.openTextDocument(uri);
            const edits = await vscode.commands.executeCommand<vscode.TextEdit[] | undefined>(
                'vscode.executeFormatDocumentProvider',
                uri,
                { tabSize: 4, insertSpaces: true },
            );
            assert.deepEqual(edits ?? [], [], `${document.fileName} is already formatted`);

            const diagnostics = await waitFor('shop diagnostics', () => {
                const found = vscode.languages.getDiagnostics(uri).filter((d) => d.source === 'qbx-lint');
                return found.length > 0 ? found : undefined;
            });
            const codes = diagnostics.map((d) => String(typeof d.code === 'object' ? d.code.value : d.code));
            for (const expected of ['fivem/event-argument-count', 'fivem/event-wrong-side', 'qbox/unknown-locale-key']) {
                assert.ok(codes.includes(expected), `${expected} missing from ${codes.join(', ')}`);
            }
            const locale = vscode.languages.getDiagnostics(workspaceFile('shop/locales/en.json'));
            assert.ok(locale.some((d) => d.message.includes('never_used')), 'unused locale keys are reported on the JSON file');
        },
    ],
    [
        'go to definition crosses resources',
        async () => {
            const document = await vscode.workspace.openTextDocument(workspaceFile('myresource/client/main.lua'));
            const locations = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
                'vscode.executeDefinitionProvider',
                document.uri,
                positionOf(document, 'MyLib.createGarage', 8),
            );
            assert.ok(locations.length > 0, 'expected a definition');
            const first = locations[0];
            const target = 'targetUri' in first ? first.targetUri : first.uri;
            assert.ok(target.fsPath.split(path.sep).join('/').endsWith('mylib/init.lua'), target.fsPath);
        },
    ],
];

export async function run(): Promise<void> {
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
        throw new Error(`${failures.length} test(s) failed: ${failures.join(', ')}`);
    }
}
