import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { manifestValues, parseManifest } from './manifestLite';
import type { Resource, ResourceIndex } from './resources';
import { CFG_ENTRIES, RESOURCE_COMMANDS, SET_COMMANDS, cfgPosition, checkCfg, looksLikeServerCfg, parseCfg, resourceDependencies, type CfgResource } from './serverCfg';

export const CFG_LANGUAGE = 'fivem-cfg';
const SELECTOR: vscode.DocumentSelector = { language: CFG_LANGUAGE };
/** The languages VS Code gives a `.cfg` file that is not named server.cfg. */
const GENERIC_LANGUAGES = ['properties', 'ini', 'plaintext'];

/** Text as Markdown shows it literally. `appendText` would also turn its spaces into ones that do not wrap. */
function plain(text: string): string {
    return text.replace(/[\\`*_{}[\]()#+\-.!<>|~]/g, '\\$&');
}

function below(folder: string, file: string): boolean {
    const relative = path.relative(folder, file);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Language features for FXServer configuration files: completion of commands, variables, resource
 * names and files, hovers, links for `exec`, and checks of what the file starts against the
 * resources in the `resources` folder next to it.
 */
class ServerCfg implements vscode.Disposable {
    private readonly diagnostics = vscode.languages.createDiagnosticCollection(CFG_LANGUAGE);
    private readonly dependencies = new Map<string, { modified: number; names: string[] }>();
    private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly subscriptions: vscode.Disposable[];

    constructor(private readonly index: ResourceIndex) {
        this.subscriptions = [
            this.diagnostics,
            vscode.languages.registerCompletionItemProvider(SELECTOR, { provideCompletionItems: (document, position) => this.complete(document, position) }, ' ', '['),
            vscode.languages.registerHoverProvider(SELECTOR, { provideHover: (document, position) => this.hover(document, position) }),
            vscode.languages.registerDocumentLinkProvider(SELECTOR, { provideDocumentLinks: (document) => this.links(document) }),
            vscode.workspace.onDidOpenTextDocument((document) => this.opened(document)),
            vscode.workspace.onDidChangeTextDocument((event) => this.schedule(event.document)),
            vscode.workspace.onDidCloseTextDocument((document) => this.closed(document)),
            index.onDidChange(() => vscode.workspace.textDocuments.forEach((document) => this.schedule(document))),
        ];
        vscode.workspace.textDocuments.forEach((document) => this.opened(document));
    }

    /** A `.cfg` file of another name that holds server commands becomes this language, in a workspace with resources. */
    private opened(document: vscode.TextDocument): void {
        if (document.uri.scheme === 'file' && /\.cfg$/i.test(document.fileName) && GENERIC_LANGUAGES.includes(document.languageId)
            && this.index.entries.length > 0 && looksLikeServerCfg(document.getText())) {
            void vscode.languages.setTextDocumentLanguage(document, CFG_LANGUAGE);
            return;
        }
        this.schedule(document);
    }

    private closed(document: vscode.TextDocument): void {
        const key = document.uri.toString();
        clearTimeout(this.timers.get(key));
        this.timers.delete(key);
        this.diagnostics.delete(document.uri);
    }

    private schedule(document: vscode.TextDocument): void {
        if (document.languageId !== CFG_LANGUAGE) { return; }
        const key = document.uri.toString();
        clearTimeout(this.timers.get(key));
        this.timers.set(key, setTimeout(() => {
            this.timers.delete(key);
            if (!document.isClosed) { this.check(document); }
        }, 300));
    }

    /** The resources in the `resources` folder next to `document`, which is where its server finds them. */
    private neighbours(document: vscode.TextDocument): Resource[] {
        if (document.uri.scheme !== 'file') { return []; }
        const root = path.join(path.dirname(document.uri.fsPath), 'resources');
        return this.index.entries.filter((resource) => below(root, resource.folder.fsPath));
    }

    private describe(resource: Resource): CfgResource {
        const manifest = resource.manifest.fsPath;
        let names: string[] = [];
        try {
            const modified = fs.statSync(manifest).mtimeMs, known = this.dependencies.get(manifest);
            if (known?.modified === modified) {
                names = known.names;
            } else {
                names = resourceDependencies(manifestValues(parseManifest(fs.readFileSync(manifest, 'utf8')), 'dependency', 'dependencies').map((value) => value.text));
                this.dependencies.set(manifest, { modified, names });
            }
        } catch { /* A manifest that vanished declares nothing. */ }
        return { name: resource.name, dependencies: names, categories: resource.folder.fsPath.split(path.sep).filter((part) => /^\[.*\]$/.test(part)) };
    }

    private check(document: vscode.TextDocument): void {
        const neighbours = this.neighbours(document);
        const folder = path.dirname(document.uri.fsPath);
        const problems = checkCfg(parseCfg(document.getText()), {
            resources: neighbours.length > 0 ? neighbours.map((resource) => this.describe(resource)) : undefined,
            fileExists: document.uri.scheme === 'file' ? (relative) => fs.existsSync(path.resolve(folder, relative)) : undefined,
        });
        this.diagnostics.set(document.uri, problems.map((problem) => {
            const diagnostic = new vscode.Diagnostic(new vscode.Range(problem.line, problem.start, problem.line, problem.end), problem.message,
                problem.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information);
            diagnostic.source = CFG_LANGUAGE;
            return diagnostic;
        }));
    }

    private complete(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
        const at = cfgPosition(document.lineAt(position.line).text, position.character);
        if (at.kind === 'none') { return []; }
        const range = new vscode.Range(position.translate(0, -Math.min(at.prefix.length, position.character)), position);
        const item = (label: string, kind: vscode.CompletionItemKind, detail?: string, documentation?: string): vscode.CompletionItem => {
            const result = new vscode.CompletionItem(label, kind);
            result.range = range;
            result.detail = detail;
            if (documentation) { result.documentation = documentation; }
            return result;
        };
        if (at.kind === 'command' || at.kind === 'variable') {
            return Object.entries(CFG_ENTRIES).filter(([, entry]) => at.kind === 'command' || entry.kind === 'variable')
                .map(([name, entry]) => item(name, entry.kind === 'command' ? vscode.CompletionItemKind.Keyword : vscode.CompletionItemKind.Variable, entry.usage, entry.summary));
        }
        if (at.kind === 'value') {
            return (CFG_ENTRIES[at.name]?.values ?? []).map((value) => item(value, vscode.CompletionItemKind.Value));
        }
        if (at.kind === 'file') {
            const folder = path.dirname(document.uri.fsPath);
            try {
                return fs.readdirSync(folder).filter((name) => /\.cfg$/i.test(name) && name !== path.basename(document.uri.fsPath)).slice(0, 200)
                    .map((name) => item(name, vscode.CompletionItemKind.File));
            } catch {
                return [];
            }
        }
        const neighbours = this.neighbours(document);
        const resources = neighbours.length > 0 ? neighbours : [...this.index.entries];
        const categories = new Set(resources.flatMap((resource) => resource.folder.fsPath.split(path.sep).filter((part) => /^\[.*\]$/.test(part))));
        return [
            ...resources.map((resource) => item(resource.name, vscode.CompletionItemKind.Module, vscode.workspace.asRelativePath(resource.folder, false))),
            ...[...categories].map((category) => item(category, vscode.CompletionItemKind.Folder, 'every resource in this category')),
        ];
    }

    private hover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
        const command = parseCfg(document.lineAt(position.line).text).find((candidate) => candidate.tokens.some((token) => position.character >= token.start && position.character <= token.end));
        const index = command?.tokens.findIndex((token) => position.character >= token.start && position.character <= token.end) ?? -1;
        if (!command || index < 0) { return undefined; }
        const token = command.tokens[index], first = command.tokens[0].text.toLowerCase();
        const range = new vscode.Range(position.line, token.start, position.line, token.end);
        const entry = index === 0 || (index === 1 && SET_COMMANDS.includes(first)) ? CFG_ENTRIES[index === 0 ? first : token.text] ?? CFG_ENTRIES[token.text] : undefined;
        if (entry) {
            const text = new vscode.MarkdownString();
            if (entry.usage) { text.appendCodeblock(entry.usage, CFG_LANGUAGE); }
            text.appendMarkdown(plain(entry.summary));
            return new vscode.Hover(text, range);
        }
        if (index === 1 && RESOURCE_COMMANDS.includes(first)) {
            const neighbours = this.neighbours(document);
            const resource = (neighbours.length > 0 ? neighbours : this.index.entries).find((candidate) => candidate.name.toLowerCase() === token.text.toLowerCase());
            if (resource) {
                const dependencies = this.describe(resource).dependencies;
                const text = new vscode.MarkdownString();
                text.appendMarkdown(`${plain(vscode.workspace.asRelativePath(resource.folder, false))}\n\n${plain(dependencies.length ? `Depends on ${dependencies.join(', ')}.` : 'Declares no dependencies.')}`);
                return new vscode.Hover(text, range);
            }
        }
        return undefined;
    }

    private links(document: vscode.TextDocument): vscode.DocumentLink[] {
        if (document.uri.scheme !== 'file') { return []; }
        const folder = path.dirname(document.uri.fsPath);
        return parseCfg(document.getText()).flatMap((command) => {
            const [name, target] = command.tokens;
            if (name.text.toLowerCase() !== 'exec' || !target || /[$%]/.test(target.text) || !fs.existsSync(path.resolve(folder, target.text))) { return []; }
            return [new vscode.DocumentLink(new vscode.Range(command.line, target.start, command.line, target.end), vscode.Uri.file(path.resolve(folder, target.text)))];
        });
    }

    dispose(): void {
        for (const timer of this.timers.values()) { clearTimeout(timer); }
        this.subscriptions.forEach((subscription) => subscription.dispose());
    }
}

export function registerServerCfg(index: ResourceIndex): vscode.Disposable {
    return new ServerCfg(index);
}
