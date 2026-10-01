import * as vscode from 'vscode';

/** Scheme of the schemas that `contributes.jsonValidation` attaches to settings files. */
export const SETTINGS_SCHEMA_SCHEME = 'qbx-lua';

/**
 * User, profile and machine settings are shared by every window, and each window may run a server
 * with other rules, so only the settings of a folder or workspace flag names the server does not know.
 */
export type SettingsFile = 'user' | 'folder' | 'workspace';

const SCHEMA_URIS: Record<SettingsFile, vscode.Uri> = {
    user: vscode.Uri.parse(`${SETTINGS_SCHEMA_SCHEME}://schemas/user-settings.json`),
    folder: vscode.Uri.parse(`${SETTINGS_SCHEMA_SCHEME}://schemas/settings.json`),
    workspace: vscode.Uri.parse(`${SETTINGS_SCHEMA_SCHEME}://schemas/workspace.json`),
};
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
 * Lists the server's rules as the keys of `qbxLua.diagnostics.rules` and, if asked, flags names it does not know.
 * Without a list it adds nothing to the value schema in package.json.
 */
export function rulesSchema(rules: readonly RuleInfo[], flagUnknown: boolean): JsonSchema {
    if (rules.length === 0) {
        return {};
    }
    const properties = Object.fromEntries(rules.map((rule) => [rule.code, ruleSchema(rule)]));
    if (!flagUnknown) {
        return { properties };
    }
    return {
        properties,
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
export function settingsSchema(rules: readonly RuleInfo[], file: SettingsFile): JsonSchema {
    const settings = { properties: { 'qbxLua.diagnostics.rules': rulesSchema(rules, file !== 'user') } };
    return file === 'workspace' ? { properties: { settings } } : settings;
}

function settingsFile(uri: vscode.Uri): SettingsFile {
    return (Object.keys(SCHEMA_URIS) as SettingsFile[]).find((file) => SCHEMA_URIS[file].path === uri.path) ?? 'folder';
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
        return JSON.stringify(settingsSchema(this.rules, settingsFile(uri)));
    }

    update(rules: readonly RuleInfo[]): void {
        if (JSON.stringify(rules) === JSON.stringify(this.rules)) {
            return;
        }
        this.rules = rules;
        for (const uri of Object.values(SCHEMA_URIS)) {
            this.changed.fire(uri);
        }
    }

    dispose(): void {
        this.changed.dispose();
    }
}
