import * as vscode from 'vscode';
import type { ResourceIndex } from './resources';

interface Tool { label: string; command: string; icon: string; detail: string; trusted?: boolean }
interface ToolGroup { label: string; tools: Tool[] }
type ToolNode = Tool | ToolGroup;

export const TOOL_GROUPS: readonly ToolGroup[] = [
    { label: 'Maps, models and assets', tools: [
        { label: 'Browse Resource Assets', command: 'qbxLua.openAssets', icon: 'file-media', detail: 'Search a resource\'s files, preview textures and media, and check manifest declarations.' },
        { label: 'Open Map Viewer', command: 'qbxLua.openMapViewer', icon: 'map', detail: 'Read a .ymap or .ytyp: entities, interiors, rooms and copyable coordinates.' },
        { label: 'Open Model Viewer', command: 'qbxLua.openModelViewer', icon: 'symbol-misc', detail: 'Preview a .ydr, .ydd, .yft or .ybn in 3D.' },
        { label: 'Open Texture Viewer', command: 'qbxLua.openTextureViewer', icon: 'file-media', detail: 'Preview the textures of a .ytd or a .dds, and replace, add or delete them from PNG files.' },
        { label: 'New Texture Dictionary', command: 'qbxLua.newTextureDictionary', icon: 'new-file', detail: 'Make a .ytd from PNG files, with mip levels and compression done for you.' },
        { label: 'Open Animation Dictionary', command: 'qbxLua.openAnimViewer', icon: 'run-all', detail: 'List the clips of a .ycd and copy the code that plays one.' },
        { label: 'Add Asset Name List', command: 'qbxLua.addAssetNameList', icon: 'list-flat', detail: 'Turn model hashes back into names with a list of game object names.' },
    ] },
    { label: 'Resources', tools: [
        { label: 'Create Resource', command: 'qbxLua.resources.create', icon: 'add', detail: 'Create a resource from a plain Lua, ox_lib or Qbox starter.' },
        { label: 'Resource Details', command: 'qbxLua.resources.details', icon: 'info', detail: 'Events, exports and dependencies of a resource.' },
        { label: 'Open NUI Preview', command: 'qbxLua.openNuiPreview', icon: 'browser', detail: 'Preview a built interface and mock its messages and callbacks.', trusted: true },
        { label: 'Open Runtime Log', command: 'qbxLua.openRuntimeLog', icon: 'output', detail: 'Follow a server log with links to Lua source.' },
        { label: 'Configure Resource Connection', command: 'qbxLua.resources.configureConnection', icon: 'plug', detail: 'Set the RCON connection used to start, stop and restart resources.', trusted: true },
        { label: 'Refresh Server Resource List', command: 'qbxLua.resources.refresh', icon: 'sync', detail: 'Make the running server find resources added since it started.', trusted: true },
    ] },
    { label: 'Checks', tools: [
        { label: 'Workspace Health', command: 'qbxLua.workspaceHealth', icon: 'pulse', detail: 'Duplicate resource names and unresolved dependencies.' },
        { label: 'Check Resource Data', command: 'qbxLua.checkResourceData', icon: 'checklist', detail: 'Vehicle and weapon metadata, data files, streamed assets that collide or are too large, and Asset Escrow.' },
        { label: 'Show Locale Matrix', command: 'qbxLua.showLocaleMatrix', icon: 'globe', detail: 'Which translations each language of a resource is missing.' },
    ] },
    { label: 'Reference and snippets', tools: [
        { label: 'Open FiveM Reference', command: 'qbxLua.openReference', icon: 'book', detail: 'Search natives, controls, ped flags, blips, markers and model names offline.' },
        { label: 'Open Snippet Browser', command: 'qbxLua.openSnippets', icon: 'symbol-snippet', detail: 'Preview and insert recipes and your own snippets.' },
        { label: 'Open Lua Utilities', command: 'qbxLua.openLuaUtilities', icon: 'tools', detail: 'Hashes, colours and JSON to Lua.' },
    ] },
    { label: 'Language server', tools: [
        { label: 'Show Tools and Status', command: 'qbxLua.showStatus', icon: 'check', detail: 'Every tool in one list, with what the language server has indexed.' },
        { label: 'Reindex Workspace', command: 'qbxLua.reindex', icon: 'refresh', detail: 'Read every file and manifest again.' },
        { label: 'Restart Language Server', command: 'qbxLua.restartServer', icon: 'debug-restart', detail: 'Restart and reload workspace configuration.' },
        { label: 'Show Output', command: 'qbxLua.showOutput', icon: 'output', detail: 'What the language server logged.' },
    ] },
    { label: 'Coding assistants', tools: [
        { label: 'Copy MCP Configuration', command: 'qbxLua.copyMcpConfiguration', icon: 'copy', detail: 'A ready configuration that gives Claude Code, Cursor and other assistants the read-only FiveM tools.' },
        { label: 'Show Coding Assistant Setup', command: 'qbxLua.assistantSetup', icon: 'question', detail: 'How the assistant tools work and what they can read.' },
    ] },
];

class ToolsProvider implements vscode.TreeDataProvider<ToolNode> {
    getChildren(node?: ToolNode): ToolNode[] { return node ? ('tools' in node ? node.tools : []) : [...TOOL_GROUPS]; }
    getTreeItem(node: ToolNode): vscode.TreeItem {
        if ('tools' in node) { return new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded); }
        const item = new vscode.TreeItem(node.label);
        item.iconPath = new vscode.ThemeIcon(node.icon); item.tooltip = node.detail; item.command = { command: node.command, title: node.label };
        return item;
    }
}

/** Resources as folder URIs, the argument every resource command already accepts from the Explorer menu. */
class ResourcesProvider implements vscode.TreeDataProvider<vscode.Uri>, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changed.event;
    private readonly subscription: vscode.Disposable;
    /** The folders that hold a `.fxap` file: resources whose Lua files Asset Escrow encrypted. */
    private escrowed = new Set<string>();
    constructor(private readonly index: ResourceIndex) { this.subscription = index.onDidChange(() => this.changed.fire()); }
    async getChildren(node?: vscode.Uri): Promise<vscode.Uri[]> {
        if (node) { return []; }
        await this.index.ready;
        const folders = [...this.index.entries].sort((a, b) => a.name.localeCompare(b.name) || a.folder.path.localeCompare(b.folder.path)).map((resource) => resource.folder);
        const marked = await Promise.all(folders.map((folder) => vscode.workspace.fs.stat(vscode.Uri.joinPath(folder, '.fxap')).then(() => true, () => false)));
        this.escrowed = new Set(folders.filter((_, index) => marked[index]).map((folder) => folder.toString()));
        return folders;
    }
    getTreeItem(folder: vscode.Uri): vscode.TreeItem {
        const resource = this.index.entries.find((entry) => entry.folder.toString() === folder.toString());
        const item = new vscode.TreeItem(resource?.name ?? vscode.workspace.asRelativePath(folder, false));
        const escrowed = this.escrowed.has(folder.toString());
        item.description = `${vscode.workspace.asRelativePath(vscode.Uri.joinPath(folder, '..'), true)}${escrowed ? ' · escrowed' : ''}`;
        item.tooltip = escrowed ? `${folder.fsPath}\nProtected by Asset Escrow: its encrypted Lua files cannot be read or edited.` : folder.fsPath;
        item.iconPath = new vscode.ThemeIcon(escrowed ? 'lock' : 'package'); item.contextValue = 'qbxLua.resource';
        item.command = { command: 'qbxLua.resources.openManifest', title: 'Open Manifest', arguments: [folder] };
        return item;
    }
    dispose(): void { this.subscription.dispose(); this.changed.dispose(); }
}

export function registerSidebar(index: ResourceIndex): vscode.Disposable {
    const resources = new ResourcesProvider(index);
    return vscode.Disposable.from(resources, vscode.window.registerTreeDataProvider('qbxLua.resourcesView', resources), vscode.window.registerTreeDataProvider('qbxLua.toolsView', new ToolsProvider()));
}
