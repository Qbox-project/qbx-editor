import type * as vscode from 'vscode';
import type { ReferenceRequest } from './referenceTypes';

export type LuaQuote = "'" | '"';

/**
 * The quote that strings written into `uri` use, decided by the language server as for its own
 * completions: the formatter's `quote_style`, or else the quote most strings of that open document
 * use. `'` without a document, or when the server cannot answer.
 */
export async function luaQuote(request: ReferenceRequest, uri?: vscode.Uri): Promise<LuaQuote> {
    try {
        const quote = await request<unknown>('qbx/quote', uri?.scheme === 'file' ? { uri: uri.toString() } : null);
        return quote === '"' ? '"' : "'";
    } catch { return "'"; }
}

/** A snippet written with `'` around its strings, with `quote` around them instead. */
export function withQuote(body: string, quote: LuaQuote): string {
    return quote === "'" ? body : body.replaceAll("'", '"');
}
