import * as vscode from 'vscode';
import type { Resource } from './resources';
import { TOOL_GROUPS } from './sidebar';

export interface HubItem extends vscode.QuickPickItem {
    command?: string;
    argument?: vscode.Uri;
}

const RESOURCE_ACTIONS: readonly { label: string; command: string; icon: string; trusted?: boolean }[] = [
    { label: 'Restart', command: 'qbxLua.resources.restart', icon: 'debug-restart', trusted: true },
    { label: 'Ensure', command: 'qbxLua.resources.ensure', icon: 'play', trusted: true },
    { label: 'Stop', command: 'qbxLua.resources.stop', icon: 'debug-stop', trusted: true },
    { label: 'Resource Details', command: 'qbxLua.resources.details', icon: 'info' },
    { label: 'Open NUI Preview', command: 'qbxLua.openNuiPreview', icon: 'browser', trusted: true },
    { label: 'Browse Resource Assets', command: 'qbxLua.openAssets', icon: 'file-media' },
    { label: 'Check Resource Data', command: 'qbxLua.checkResourceData', icon: 'checklist' },
    { label: 'Open Manifest', command: 'qbxLua.resources.openManifest', icon: 'list-unordered' },
];

/** The command that opens this list, which the list itself leaves out. */
const HUB_COMMAND = 'qbxLua.showStatus';

/**
 * Every tool in one list: first the actions for `active`, the resource of the file being edited,
 * then the tools of the sidebar. Actions that need a trusted workspace are left out of others.
 */
export function hubItems(active: Resource | undefined, trusted: boolean): HubItem[] {
    const items: HubItem[] = [];
    if (active) {
        items.push({ label: active.name, kind: vscode.QuickPickItemKind.Separator });
        for (const action of RESOURCE_ACTIONS) {
            if (trusted || !action.trusted) {
                items.push({ label: `$(${action.icon}) ${action.label}`, description: active.name, command: action.command, argument: active.folder });
            }
        }
    }
    for (const group of TOOL_GROUPS) {
        items.push({ label: group.label, kind: vscode.QuickPickItemKind.Separator });
        for (const tool of group.tools) {
            if (tool.command !== HUB_COMMAND && (trusted || !tool.trusted)) {
                items.push({ label: `$(${tool.icon}) ${tool.label}`, detail: tool.detail, command: tool.command });
            }
        }
    }
    return items;
}

/** Shows the tools with `status`, what the language server has indexed, as the hint of the list. */
export async function showToolHub(status: string, active: Resource | undefined): Promise<void> {
    const picked = await vscode.window.showQuickPick(hubItems(active, vscode.workspace.isTrusted), {
        title: 'Qbox Lua for FiveM', placeHolder: status, matchOnDescription: true, matchOnDetail: true,
    });
    if (picked?.command) {
        await vscode.commands.executeCommand(picked.command, ...(picked.argument ? [picked.argument] : []));
    }
}
