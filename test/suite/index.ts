import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';

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
    [
        'activates and answers status requests',
        async () => {
            const extension = vscode.extensions.getExtension('qbox.qbx-lua');
            assert.ok(extension, 'extension should be installed in the test host');
            await vscode.workspace.openTextDocument(workspaceFile('myresource/client/main.lua')).then((doc) => vscode.window.showTextDocument(doc));
            await waitFor('activation', () => (extension.isActive ? true : undefined));
            const commands = await vscode.commands.getCommands(true);
            for (const command of ['qbxLua.restartServer', 'qbxLua.reindex', 'qbxLua.showStatus', 'qbxLua.showOutput']) {
                assert.ok(commands.includes(command), `${command} should be registered`);
            }
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
