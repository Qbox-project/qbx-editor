import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Resource } from './resources';

export interface LogSource { resource: string; path: string; line: number }

export function validLogSource(source: LogSource): boolean {
    const parts = source.path.replace(/\\/g, '/').split('/');
    return source.resource.length > 0 && source.resource.length <= 2048 && !/[\\/:\x00-\x1f]/.test(source.resource)
        && source.resource !== '.' && source.resource !== '..' && source.path.length <= 4096
        && !/[\x00-\x1f:]/.test(source.path) && parts.every((part) => part !== '' && part !== '.' && part !== '..')
        && /\.lua$/i.test(source.path) && Number.isSafeInteger(source.line) && source.line > 0 && source.line <= 0x7fffffff;
}

export function logSourceResources(source: LogSource, resources: readonly Resource[]): Resource[] {
    if (!validLogSource(source)) { return []; }
    return resources.filter((resource) => resource.name.toLowerCase() === source.resource.toLowerCase());
}

function within(root: string, file: string): boolean {
    const relative = path.relative(root, file);
    return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

/** Resolve only a Lua file inside a discovered resource, including after following directory links. */
export async function resolveLogSource(source: LogSource, resource: Resource): Promise<vscode.Uri | undefined> {
    if (!validLogSource(source) || resource.folder.scheme !== 'file'
        || resource.name.toLowerCase() !== source.resource.toLowerCase()) { return undefined; }
    const target = path.resolve(resource.folder.fsPath, ...source.path.replace(/\\/g, '/').split('/'));
    if (!within(resource.folder.fsPath, target)) { return undefined; }
    try {
        const [root, actual, stat] = await Promise.all([fs.realpath(resource.folder.fsPath), fs.realpath(target), fs.stat(target)]);
        return stat.isFile() && within(root, actual) ? vscode.Uri.file(actual) : undefined;
    } catch { return undefined; }
}

export async function openLogSource(source: LogSource, resources: readonly Resource[], isCurrent: () => boolean,
    cancellation?: vscode.CancellationToken): Promise<void> {
    const candidates = logSourceResources(source, resources);
    if (!isCurrent() || candidates.length === 0) { return; }
    let selected: Resource | undefined = candidates[0];
    if (candidates.length > 1) {
        selected = (await vscode.window.showQuickPick(candidates.map((resource) => ({
            label: resource.name, description: vscode.workspace.asRelativePath(resource.folder, true),
            detail: resource.folder.fsPath, resource,
        })), { title: 'Choose the resource for this log entry', matchOnDescription: true, matchOnDetail: true }, cancellation))?.resource;
    }
    if (!selected || !isCurrent()) { return; }
    const uri = await resolveLogSource(source, selected);
    if (!isCurrent()) { return; }
    if (!uri) { void vscode.window.showInformationMessage('This Lua source is unavailable inside the selected workspace resource.'); return; }
    const document = await vscode.workspace.openTextDocument(uri);
    if (!isCurrent() || document.isClosed) { return; }
    const position = document.validatePosition(new vscode.Position(source.line - 1, 0));
    await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.One,
        selection: new vscode.Range(position, position) });
}
