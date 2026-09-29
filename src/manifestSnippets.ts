import * as vscode from 'vscode';
import { luaQuote, withQuote } from './luaQuote';
import type { ReferenceRequest } from './referenceTypes';
import { parseSnippetFile, type ParsedSnippet } from './snippetFormat';

/** The bundled manifest snippets, written with `'` around their strings. */
export async function loadManifestSnippets(extensionUri: vscode.Uri): Promise<ParsedSnippet[]> {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(extensionUri, 'snippets', 'fxmanifest.json'));
    const parsed = parseSnippetFile(Buffer.from(bytes).toString('utf8'));
    if (parsed.issues.length) { throw new Error(parsed.issues.join(' ')); }
    return parsed.snippets;
}

/**
 * Offers the bundled manifest snippets under their prefixes in Lua files, as a `snippets`
 * contribution would, but with their strings in the quote of the document.
 */
export function registerManifestSnippetCompletions(extensionUri: vscode.Uri, request: ReferenceRequest): vscode.Disposable {
    let snippets: Promise<ParsedSnippet[]> | undefined;
    return vscode.languages.registerCompletionItemProvider({ language: 'lua' }, {
        async provideCompletionItems(document) {
            snippets ??= loadManifestSnippets(extensionUri);
            const [loaded, quote] = await Promise.all([snippets, luaQuote(request, document.uri)]);
            return loaded.flatMap((snippet) => snippet.prefix.map((prefix) => {
                const item = new vscode.CompletionItem({ label: prefix, description: snippet.name }, vscode.CompletionItemKind.Snippet);
                item.insertText = new vscode.SnippetString(withQuote(snippet.body, quote));
                item.detail = snippet.description;
                return item;
            }));
        },
    });
}
