import * as path from 'node:path';
import * as vscode from 'vscode';

export const MAX_COPY_CHARACTERS = 200_000;
export function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
export function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export async function readBounded(uri: vscode.Uri, limit: number): Promise<Buffer> {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.size > limit) { throw new Error(`This file exceeds the ${Math.floor(limit / 1024 / 1024)} MiB inspection limit.`); }
    return Buffer.from(await vscode.workspace.fs.readFile(uri));
}

/** Calls `changed` once a file has stopped changing on disk, so a viewer follows re-exports from other tools. */
export function watchFile(uri: vscode.Uri, changed: () => void): vscode.Disposable {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), path.posix.basename(uri.path)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (): void => { if (timer) { clearTimeout(timer); } timer = setTimeout(() => { timer = undefined; changed(); }, 400); };
    const subscriptions = [watcher, watcher.onDidChange(schedule), watcher.onDidCreate(schedule)];
    return { dispose: () => { if (timer) { clearTimeout(timer); } subscriptions.forEach((subscription) => subscription.dispose()); } };
}

export async function copyFromWebview(text: unknown, label: unknown): Promise<string | undefined> {
    if (typeof text !== 'string' || typeof label !== 'string' || !text || text.length > MAX_COPY_CHARACTERS) { return undefined; }
    await vscode.env.clipboard.writeText(text);
    return `Copied ${label.slice(0, 80)}.`;
}
