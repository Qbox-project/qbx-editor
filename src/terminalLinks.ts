import * as vscode from 'vscode';
import { parseLogSources } from './runtimeLogParser';
import { openLogSource, validLogSource, type LogSource } from './runtimeLogSources';
import type { ResourceIndex } from './resources';

interface SourceLink extends vscode.TerminalLink {
    source: LogSource;
}

/**
 * Makes `@resource/file.lua:12` open that line from any integrated terminal, such as one that runs
 * FXServer, for the resources of the workspace. Other text is left to the terminal's own links.
 */
export function registerTerminalSourceLinks(index: ResourceIndex): vscode.Disposable {
    const provider: vscode.TerminalLinkProvider<SourceLink> = {
        provideTerminalLinks(context) {
            const names = new Set(index.entries.map((resource) => resource.name.toLowerCase()));
            if (names.size === 0 || !context.line.includes('@')) {
                return [];
            }
            return parseLogSources(context.line)
                .filter((source) => validLogSource(source) && names.has(source.resource.toLowerCase()))
                .map((source) => ({ startIndex: source.start, length: source.end - source.start, tooltip: 'Open Lua source', source }));
        },
        async handleTerminalLink(link) {
            await openLogSource(link.source, index.entries, () => true);
        },
    };
    return vscode.window.registerTerminalLinkProvider(provider);
}
