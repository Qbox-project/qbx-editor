import * as vscode from 'vscode';

/** Scheme of the schemas that `contributes.jsonValidation` attaches to settings files. */
export const SETTINGS_SCHEMA_SCHEME = 'qbx-lua';

const SETTINGS_URI = vscode.Uri.parse(`${SETTINGS_SCHEMA_SCHEME}://schemas/settings.json`);
const WORKSPACE_URI = vscode.Uri.parse(`${SETTINGS_SCHEMA_SCHEME}://schemas/workspace.json`);
const LEVELS = ['off', 'hint', 'info', 'warning', 'error'] as const;

export type RuleLevel = (typeof LEVELS)[number];

/** A rule as the server's `qbx/rules` request describes it. */
export interface RuleInfo {
    code: string;
    category: string;
    default: RuleLevel;
    fixable: boolean;
    summary: string;
}

type JsonSchema = Record<string, unknown>;

/**
 * Lists the server's rules as the keys of `qbxLua.diagnostics.rules` and flags names it does not know.
 * Without a list it adds nothing to the value schema in package.json.
 */
export function rulesSchema(rules: readonly RuleInfo[]): JsonSchema {
    if (rules.length === 0) {
        return {};
    }
    return {
        properties: Object.fromEntries(rules.map((rule) => [rule.code, ruleSchema(rule)])),
        additionalProperties: false,
        errorMessage: 'qbx-lua-ls has no rule with this name, so this level is ignored.',
    };
}

function ruleSchema(rule: RuleInfo): JsonSchema {
    const facts = [rule.category, `default \`${rule.default}\``];
    if (rule.fixable) {
        facts.push('fixable');
    }
    return {
        enum: LEVELS,
        markdownDescription: `${rule.summary}\n\n${facts.join(' · ')}`,
        markdownEnumDescriptions: LEVELS.map((level) => (level === rule.default ? 'The default for this rule.' : '')),
    };
}

/** The schema of a settings file; a `.code-workspace` file nests its settings under `settings`. */
export function settingsSchema(rules: readonly RuleInfo[], workspaceFile: boolean): JsonSchema {
    const settings = { properties: { 'qbxLua.diagnostics.rules': rulesSchema(rules) } };
    return workspaceFile ? { properties: { settings } } : settings;
}

/**
 * Serves the settings schemas from the rules of the running server, so a rule added to the server is
 * suggested without an extension update. VS Code's JSON support combines them with its own settings schema.
 */
export class SettingsSchemaProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this.changed.event;
    private rules: readonly RuleInfo[] = [];

    provideTextDocumentContent(uri: vscode.Uri): string {
        return JSON.stringify(settingsSchema(this.rules, uri.path === WORKSPACE_URI.path));
    }

    update(rules: readonly RuleInfo[]): void {
        if (JSON.stringify(rules) === JSON.stringify(this.rules)) {
            return;
        }
        this.rules = rules;
        this.changed.fire(SETTINGS_URI);
        this.changed.fire(WORKSPACE_URI);
    }

    dispose(): void {
        this.changed.dispose();
    }
}
