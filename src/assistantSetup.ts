import * as vscode from 'vscode';

const LAUNCHER = 'qbx-lua-mcp.js';
const SERVER_NAME = 'qbox-lua';

export type McpFormat = 'mcpServers' | 'vscode' | 'claude';

/**
 * The script MCP clients launch. It lives in the extension's global storage, whose path stays the
 * same when an update moves the extension folder, and starts the server of the installed version.
 */
export function mcpLauncherSource(entry: string): string {
    return [
        '// Written by the Qbox Lua extension. It starts the MCP server of the installed version, so the',
        '// path an MCP client is configured with survives extension updates.',
        `require(${JSON.stringify(entry)}).startAssistantMcp(process.argv.slice(2)).catch((error) => {`,
        "    process.stderr.write(`Qbox Lua MCP: ${error instanceof Error ? error.message : 'Could not start.'}\\n`);",
        '    process.exitCode = 1;',
        '});',
        '',
    ].join('\n');
}

/** The configuration that makes an MCP client run `launcher` for the `workspaces` folders. */
export function mcpConfiguration(format: McpFormat, launcher: string, workspaces: readonly string[]): string {
    const args = [launcher, ...workspaces.flatMap((folder) => ['--workspace', folder])];
    if (format === 'claude') {
        return `claude mcp add ${SERVER_NAME} -- node ${args.map((arg) => (arg.startsWith('--') ? arg : JSON.stringify(arg))).join(' ')}`;
    }
    const server = { command: 'node', args };
    return `${JSON.stringify(format === 'vscode' ? { servers: { [SERVER_NAME]: { type: 'stdio', ...server } } } : { mcpServers: { [SERVER_NAME]: server } }, null, 2)}\n`;
}

type Storage = Pick<vscode.ExtensionContext, 'globalStorageUri' | 'extensionUri'>;

function launcherUri(context: Storage): vscode.Uri {
    return vscode.Uri.joinPath(context.globalStorageUri, LAUNCHER);
}

/** Writes the launcher for the installed version unless it is current, and returns where it is. */
export async function writeMcpLauncher(context: Storage): Promise<vscode.Uri> {
    const launcher = launcherUri(context);
    const source = Buffer.from(mcpLauncherSource(vscode.Uri.joinPath(context.extensionUri, 'dist', 'assistantMcp.js').fsPath));
    const current = await vscode.workspace.fs.readFile(launcher).then((bytes) => Buffer.from(bytes), () => undefined);
    if (!current?.equals(source)) {
        await vscode.workspace.fs.createDirectory(context.globalStorageUri);
        await vscode.workspace.fs.writeFile(launcher, source);
    }
    return launcher;
}

/** Points a launcher that an earlier version wrote at this version. People who never set MCP up get no file. */
export async function refreshMcpLauncher(context: Storage): Promise<void> {
    const exists = await vscode.workspace.fs.stat(launcherUri(context)).then(() => true, () => false);
    if (exists) {
        await writeMcpLauncher(context);
    }
}

const FORMATS: readonly (vscode.QuickPickItem & { format: McpFormat })[] = [
    { label: 'mcpServers JSON', description: 'Claude Desktop, Cursor, Windsurf, Cline and most other clients', format: 'mcpServers' },
    { label: 'VS Code mcp.json', description: 'for .vscode/mcp.json or the user MCP configuration', format: 'vscode' },
    { label: 'Claude Code command', description: 'a claude mcp add command for the terminal', format: 'claude' },
];

/** Copies a ready MCP configuration for the open folders. No file of any client is changed. */
export async function copyMcpConfiguration(context: Storage): Promise<void> {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file').map((folder) => folder.uri.fsPath);
    if (folders.length === 0) {
        void vscode.window.showWarningMessage('Open the folder that holds your resources first. The MCP server reads only the folders it is started with.');
        return;
    }
    const picked = await vscode.window.showQuickPick(FORMATS, { title: 'Copy MCP Configuration', placeHolder: 'Which assistant is it for?' });
    if (!picked) {
        return;
    }
    const launcher = await writeMcpLauncher(context);
    await vscode.env.clipboard.writeText(mcpConfiguration(picked.format, launcher.fsPath, folders.slice(0, 16)));
    const pasted = picked.format === 'claude' ? 'Run it in a terminal.' : 'Paste it into the MCP configuration of your assistant.';
    const choice = await vscode.window.showInformationMessage(`MCP configuration copied. ${pasted} It needs Node.js 18 or later and keeps working after extension updates.`, 'Open Setup Guide');
    if (choice === 'Open Setup Guide') {
        await vscode.commands.executeCommand('qbxLua.assistantSetup');
    }
}
