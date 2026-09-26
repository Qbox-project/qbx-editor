import * as vscode from 'vscode';
import { validResourceLocation } from './resourceDetailsSession';
import type { ResourceLocation } from './resourceDetailsTypes';

/** Navigate only to an indexed source supplied by a host session, never a webview URI. */
export async function openResourceSource(location: ResourceLocation, isCurrent: () => boolean): Promise<void> {
    if (!validResourceLocation(location) || !isCurrent()) { return; }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(location.uri));
    if (!isCurrent() || document.isClosed) { return; }
    const { start, end } = location.range;
    const selection = document.validateRange(new vscode.Range(start.line, start.character, end.line, end.character));
    await vscode.window.showTextDocument(document, { selection, preview: true, viewColumn: vscode.ViewColumn.One });
}
