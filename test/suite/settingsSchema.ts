import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { settingsSchema, type RuleInfo } from '../../src/settingsSchema';

type Test = [name: string, body: () => void | Promise<void>];

const unusedLocal: RuleInfo = { code: 'unused-local', category: 'suspicious', default: 'warning', fixable: false, summary: 'A local variable is never read.' };
const citizenPrefix: RuleInfo = { code: 'fivem/citizen-prefix', category: 'fivem', default: 'off', fixable: true, summary: 'Citizen. prefix.' };

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

function label(item: vscode.CompletionItem): string {
    return typeof item.label === 'string' ? item.label : item.label.label;
}

const tests: Test[] = [
    ['rules become keys with their summary, category and default level', () => {
        const schema = settingsSchema([unusedLocal, citizenPrefix], 'folder') as { properties: Record<string, { properties: Record<string, Record<string, unknown>>; additionalProperties: unknown }> };
        const rules = schema.properties['qbxLua.diagnostics.rules'];
        assert.deepEqual(Object.keys(rules.properties), ['unused-local', 'fivem/citizen-prefix']);
        assert.equal(rules.additionalProperties, false);
        assert.deepEqual(rules.properties['unused-local'], {
            enum: ['off', 'hint', 'info', 'warning', 'error'],
            markdownDescription: 'A local variable is never read.\n\nsuspicious · default `warning`',
            markdownEnumDescriptions: ['', '', '', 'The default for this rule.', ''],
        });
        assert.equal(rules.properties['fivem/citizen-prefix'].markdownDescription, 'Citizen. prefix.\n\nfivem · default `off` · fixable');
    }],
    ['without rules from the server the schema flags no key', () => {
        assert.deepEqual(settingsSchema([], 'folder'), { properties: { 'qbxLua.diagnostics.rules': {} } });
    }],
    ['workspace files nest the rules under settings', () => {
        assert.deepEqual(settingsSchema([], 'workspace'), { properties: { settings: { properties: { 'qbxLua.diagnostics.rules': {} } } } });
        const schema = settingsSchema([unusedLocal], 'workspace') as { properties: { settings: { properties: Record<string, Record<string, unknown>> } } };
        assert.equal(schema.properties.settings.properties['qbxLua.diagnostics.rules'].additionalProperties, false);
    }],
    ['user settings suggest the rules without flagging other names', () => {
        const schema = settingsSchema([unusedLocal], 'user') as { properties: Record<string, Record<string, unknown>> };
        const rules = schema.properties['qbxLua.diagnostics.rules'];
        assert.deepEqual(Object.keys(rules.properties as object), ['unused-local']);
        assert.equal(rules.additionalProperties, undefined);
        assert.equal(rules.errorMessage, undefined);
    }],
    ['settings.json suggests the server rules and flags unknown ones', async () => {
        const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qbx-settings-schema-'));
        const file = path.join(folder, '.vscode', 'settings.json');
        await fs.mkdir(path.dirname(file));
        await fs.writeFile(file, '{\n    "qbxLua.diagnostics.rules": {\n        "not-a-rule": "off",\n        \n    }\n}\n');
        try {
            const document = await vscode.workspace.openTextDocument(file);
            await vscode.window.showTextDocument(document);
            const labels = await waitFor('rule suggestions', async () => {
                const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', document.uri, new vscode.Position(3, 8));
                const found = list.items.map(label);
                return found.includes('unused-local') ? found : undefined;
            });
            assert.ok(labels.includes('fivem/citizen-prefix'), 'rules with a category prefix are listed');
            assert.ok(!labels.includes('not-a-rule'), 'keys already in the object are not suggested again');
            const unknown = await waitFor('unknown rule warning', () => {
                const found = vscode.languages.getDiagnostics(document.uri).filter((d) => d.message.includes('no rule with this name'));
                return found.length > 0 ? found : undefined;
            });
            assert.equal(unknown.length, 1);
            assert.equal(document.getText(unknown[0].range), '"not-a-rule"');
            assert.equal(unknown[0].severity, vscode.DiagnosticSeverity.Warning);
        } finally {
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            await fs.rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
        }
    }],
];

export async function runSettingsSchemaTests(): Promise<void> {
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
        throw new Error(`${failures.length} settings schema test(s) failed: ${failures.join(', ')}`);
    }
}
