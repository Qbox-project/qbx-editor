import * as path from 'node:path';
import * as vscode from 'vscode';
import { luaQuote, withQuote } from './luaQuote';
import type { ReferenceRequest } from './referenceTypes';
import { parseSnippetFile, type ParsedSnippet } from './snippetFormat';

const MANIFEST_NAMES = ['fxmanifest.lua', '__resource.lua'];
const MANIFEST_PREFIX = 'fxmanifest';

/** The bundled manifest snippets, written with `'` around their strings. */
export async function loadManifestSnippets(extensionUri: vscode.Uri): Promise<ParsedSnippet[]> {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(extensionUri, 'snippets', 'fxmanifest.json'));
    const parsed = parseSnippetFile(Buffer.from(bytes).toString('utf8'));
    if (parsed.issues.length) { throw new Error(parsed.issues.join(' ')); }
    return parsed.snippets;
}

/**
 * The prefixes of `snippets` that `typed` starts in a document: those of a whole manifest only in a
 * manifest file or a document that has no name yet, the others in any Lua file.
 */
export function manifestSnippetPrefixes(snippets: readonly ParsedSnippet[], typed: string, manifest: boolean): { snippet: ParsedSnippet; prefix: string }[] {
    const start = typed.toLowerCase();
    return snippets
        .filter((snippet) => manifest || !snippet.prefix.includes(MANIFEST_PREFIX))
        .flatMap((snippet) => snippet.prefix.filter((prefix) => prefix.toLowerCase().startsWith(start)).map((prefix) => ({ snippet, prefix })));
}

/**
 * Offers the bundled manifest snippets under their prefixes in Lua files, as a `snippets`
 * contribution would, but with their strings in the quote of the document. The language server is
 * asked for that quote only once a prefix is being typed.
 */
export function registerManifestSnippetCompletions(extensionUri: vscode.Uri, request: ReferenceRequest): vscode.Disposable {
    let snippets: Promise<ParsedSnippet[]> | undefined;
    return vscode.languages.registerCompletionItemProvider({ language: 'lua' }, {
        async provideCompletionItems(document, position, _token, context) {
            const word = document.getWordRangeAtPosition(position);
            const typed = word ? document.getText(new vscode.Range(word.start, position)) : '';
            if (!typed && context.triggerKind !== vscode.CompletionTriggerKind.Invoke) {
                return undefined;
            }
            snippets ??= loadManifestSnippets(extensionUri);
            const manifest = document.isUntitled || MANIFEST_NAMES.includes(path.basename(document.fileName));
            const offered = manifestSnippetPrefixes(await snippets, typed, manifest);
            if (offered.length === 0) {
                return undefined;
            }
            const quote = await luaQuote(request, document.uri);
            return offered.map(({ snippet, prefix }) => {
                const item = new vscode.CompletionItem({ label: prefix, description: snippet.name }, vscode.CompletionItemKind.Snippet);
                item.insertText = new vscode.SnippetString(withQuote(snippet.body, quote));
                item.detail = snippet.description;
                return item;
            });
        },
    });
}
