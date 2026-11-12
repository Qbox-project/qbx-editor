import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { runTests, type Test } from './runner';

async function waitFor<T>(what: string, probe: () => Promise<T | undefined> | T | undefined, timeoutMs = 30000): Promise<T> {
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

function workspaceFile(relative: string): vscode.Uri {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'the fixture workspace should be open');
    return vscode.Uri.file(path.join(folder.uri.fsPath, relative));
}

/** The fixture workspace opened without trust, as a resource downloaded from the internet is. */
const tests: Test[] = [
    ['Restricted Mode keeps the extension enabled with Lua language features', async () => {
        assert.equal(vscode.workspace.isTrusted, false, 'this run must open the workspace in Restricted Mode');
        const extension = vscode.extensions.getExtension('qbox.qbx-lua');
        assert.ok(extension, 'an extension without limited support would be disabled here');
        const document = await vscode.workspace.openTextDocument(workspaceFile('myresource/client/main.lua'));
        await vscode.window.showTextDocument(document);
        await waitFor('activation', () => (extension.isActive ? true : undefined));
        const position = document.positionAt(document.getText().indexOf('MyLib.round(1.2345') + 8);
        await waitFor('a hover from the language server', async () => {
            const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', document.uri, position);
            const text = (hovers ?? []).flatMap((hover) => hover.contents).map((content) => (typeof content === 'string' ? content : content.value)).join('\n');
            return text.includes('MyLib.round') ? true : undefined;
        });
    }],
    ['Restricted Mode refuses the assistant tools, which read the workspace for a model', async () => {
        const extension = vscode.extensions.getExtension('qbox.qbx-lua');
        assert.ok(extension?.isActive);
        const api = extension.exports as { call(name: string, input: unknown): Promise<unknown> };
        await assert.rejects(api.call('qbx_list_resources', {}), /trust/i);
    }],
    ['Restricted Mode ignores the server path and library of the workspace', () => {
        const restricted = (vscode.extensions.getExtension('qbox.qbx-lua')?.packageJSON as {
            capabilities: { untrustedWorkspaces: { supported: string; restrictedConfigurations: string[] } };
        }).capabilities.untrustedWorkspaces;
        assert.equal(restricted.supported, 'limited');
        assert.deepEqual(restricted.restrictedConfigurations, ['qbxLua.server.path', 'qbxLua.library']);
        return Promise.resolve();
    }],
];

export async function run(): Promise<void> {
    await runTests(tests);
}
