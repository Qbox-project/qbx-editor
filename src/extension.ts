import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, State, TransportKind } from 'vscode-languageclient/node';
import { ResourceControls } from './resourceControls';
import { ReferenceBrowser } from './referenceBrowser';
import { SnippetBrowser } from './snippetBrowser';

interface ServerStatus {
    files: number;
    resources: number;
    openDocuments: number;
    natives: number;
}

interface FileInfo {
    side: string;
    resource: string | null;
}

const CONFIG_SECTION = 'qbxLua';
const CONFLICTING_EXTENSIONS = ['sumneko.lua', 'overextended.cfxlua-vscode', 'ihyajb.qbcore-code-snippets'];

let client: LanguageClient | undefined;
let statusItem: vscode.StatusBarItem;
let output: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext): Promise<import('./assistantVscode.js').AssistantApi> {
    output = vscode.window.createOutputChannel('Qbox Lua');
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
    statusItem.command = 'qbxLua.showStatus';
    context.subscriptions.push(output, statusItem);
    const resourceControls = new ResourceControls(context);
    context.subscriptions.push(resourceControls);
    const request = async <T>(method: string, params: unknown, token?: vscode.CancellationToken): Promise<T> => {
        if (!client || client.state !== State.Running) {
            throw new Error('The Qbox Lua language server is not running. Use Qbox Lua: Restart Language Server, then retry.');
        }
        return token ? client.sendRequest<T>(method, params, token) : client.sendRequest<T>(method, params);
    };
    const referenceBrowser = new ReferenceBrowser(context.extensionUri, request);
    const snippetBrowser = new SnippetBrowser(context.extensionUri, context.globalStorageUri, request);
    context.subscriptions.push(referenceBrowser, snippetBrowser);
    let resourceWizard: import('./resourceWizard.js').ResourceWizard | undefined;
    let wizardDisposed = false;
    context.subscriptions.push({ dispose: () => { wizardDisposed = true; resourceWizard?.dispose(); } });
    let resourceDetails: import('./resourceDetailsBrowser.js').ResourceDetailsController | undefined;
    let detailsDisposed = false;
    context.subscriptions.push({ dispose: () => { detailsDisposed = true; resourceDetails?.dispose(); } });
    let runtimeLog: import('./runtimeToolsBrowser.js').RuntimeLogController | undefined;
    let workspaceHealth: import('./runtimeToolsBrowser.js').WorkspaceHealthController | undefined;
    let runtimeToolsDisposed = false;
    context.subscriptions.push({ dispose: () => { runtimeToolsDisposed = true; runtimeLog?.dispose(); workspaceHealth?.dispose(); } });
    let nuiPreview: import('./nuiBrowser.js').NuiController | undefined;
    let nuiDisposed = false;
    context.subscriptions.push({ dispose: () => { nuiDisposed = true; nuiPreview?.dispose(); } });
    let utilities: import('./luaUtilitiesBrowser.js').LuaUtilitiesBrowser | undefined;
    let assets: import('./assetBrowser.js').AssetController | undefined;
    let extraToolsDisposed = false;
    context.subscriptions.push({ dispose: () => { extraToolsDisposed = true; utilities?.dispose(); assets?.dispose(); } });

    context.subscriptions.push(
        vscode.commands.registerCommand('qbxLua.restartServer', () => restart(context)),
        vscode.commands.registerCommand('qbxLua.reindex', reindex),
        vscode.commands.registerCommand('qbxLua.showSnippets', () => snippetBrowser.show()),
        vscode.commands.registerCommand('qbxLua.openSnippets', () => snippetBrowser.show()),
        vscode.commands.registerCommand('qbxLua.saveSelectionAsSnippet', () => snippetBrowser.saveSelection()),
        vscode.commands.registerCommand('qbxLua.editPersonalSnippets', () => snippetBrowser.editPersonal()),
        vscode.commands.registerCommand('qbxLua.editWorkspaceSnippets', () => snippetBrowser.editWorkspace()),
        vscode.commands.registerCommand('qbxLua.openReference', () => referenceBrowser.show()),
        vscode.commands.registerCommand('qbxLua.openLuaUtilities', async () => {
            const { LuaUtilitiesBrowser } = await import('./luaUtilitiesBrowser.js');
            if (extraToolsDisposed) { return; }
            utilities ??= new LuaUtilitiesBrowser(context.extensionUri);
            utilities.show();
        }),
        vscode.commands.registerCommand('qbxLua.openAssets', async (uri?: unknown) => {
            const { AssetController } = await import('./assetBrowser.js');
            if (extraToolsDisposed) { return; }
            assets ??= new AssetController(context.extensionUri, request, resourceControls.resourceIndex);
            await assets.show(uri);
        }),
        vscode.commands.registerCommand('qbxLua.assistantSetup', async () => {
            await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.joinPath(context.extensionUri, 'docs', 'assistant-tools.md'));
        }),
        vscode.commands.registerCommand('qbxLua.resources.create', async (uri?: unknown) => {
            const { ResourceWizard } = await import('./resourceWizard.js');
            if (wizardDisposed) { return; }
            resourceWizard ??= new ResourceWizard();
            await resourceWizard.show(uri);
        }),
        vscode.commands.registerCommand('qbxLua.resources.details', async (uri?: unknown) => {
            const { ResourceDetailsController } = await import('./resourceDetailsBrowser.js');
            if (detailsDisposed) { return; }
            resourceDetails ??= new ResourceDetailsController(context.extensionUri, request, resourceControls.resourceIndex);
            await resourceDetails.show(uri);
        }),
        vscode.commands.registerCommand('qbxLua.showStatus', showStatus),
        vscode.commands.registerCommand('qbxLua.openRuntimeLog', async (uri?: unknown) => {
            const { RuntimeLogController } = await import('./runtimeToolsBrowser.js');
            if (runtimeToolsDisposed) { return; }
            runtimeLog ??= new RuntimeLogController(context.extensionUri, resourceControls.resourceIndex);
            await runtimeLog.show(uri);
        }),
        vscode.commands.registerCommand('qbxLua.workspaceHealth', async () => {
            const { WorkspaceHealthController } = await import('./runtimeToolsBrowser.js');
            if (runtimeToolsDisposed) { return; }
            workspaceHealth ??= new WorkspaceHealthController(context.extensionUri, request);
            await workspaceHealth.show();
        }),
        vscode.commands.registerCommand('qbxLua.showOutput', () => output.show()),
        vscode.commands.registerCommand('qbxLua.openNuiPreview', async (uri?: unknown) => {
            const { NuiController } = await import('./nuiBrowser.js');
            if (nuiDisposed) { return; }
            nuiPreview ??= new NuiController(context.extensionUri, context.workspaceState, request, resourceControls.resourceIndex);
            await nuiPreview.show(uri);
        }),
        vscode.workspace.onDidChangeConfiguration((event) => {
            const needsRestart = event.affectsConfiguration(`${CONFIG_SECTION}.server.path`) || event.affectsConfiguration(`${CONFIG_SECTION}.library`);
            if (needsRestart) {
                void restart(context);
            }
        }),
        vscode.window.onDidChangeActiveTextEditor(() => {
            updateStatusVisibility();
            void refreshStatus();
        }),
        vscode.workspace.onDidSaveTextDocument((document) => {
            if (document.fileName.endsWith('fxmanifest.lua')) {
                void refreshStatus();
            }
        }),
    );

    await start(context);
    warnAboutOtherLuaExtensions();
    const { registerAssistantTools } = await import('./assistantVscode.js');
    return registerAssistantTools(context, request);
}

export async function deactivate(): Promise<void> {
    await client?.stop();
    client = undefined;
}

function platformFolder(): string {
    return `${process.platform}-${process.arch}`;
}

function binaryName(): string {
    return process.platform === 'win32' ? 'qbx-lua-ls.exe' : 'qbx-lua-ls';
}

/** Setting, then the binary bundled for this platform, then a sibling checkout for development, then PATH. */
function resolveServerPath(context: vscode.ExtensionContext): string {
    const configured = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('server.path', '').trim();
    if (configured) {
        return configured;
    }
    const candidates = [
        context.asAbsolutePath(path.join('server', platformFolder(), binaryName())),
        context.asAbsolutePath(path.join('..', 'qbx-lua-ls', 'target', 'release', binaryName())),
        context.asAbsolutePath(path.join('..', 'qbx-lua-ls', 'target', 'debug', binaryName())),
    ];
    return candidates.find((candidate) => fs.existsSync(candidate)) ?? binaryName();
}

function serverSettings(): Record<string, unknown> {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    return {
        library: config.get<string[]>('library', []),
        diagnostics: {
            enable: config.get<boolean>('diagnostics.enable', true),
            workspace: config.get<boolean>('diagnostics.workspace', true),
            rules: config.get<Record<string, string>>('diagnostics.rules', {}),
        },
        inlayHints: { enable: config.get<boolean>('inlayHints.enable', true) },
        semanticTokens: { enable: config.get<boolean>('semanticTokens.enable', true) },
    };
}

async function start(context: vscode.ExtensionContext): Promise<void> {
    const command = resolveServerPath(context);
    output.appendLine(`starting ${command}`);

    const serverOptions: ServerOptions = {
        run: { command, transport: TransportKind.stdio },
        debug: { command, transport: TransportKind.stdio },
    };
    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: 'lua' }],
        outputChannel: output,
        initializationOptions: serverSettings(),
        synchronize: { configurationSection: CONFIG_SECTION },
    };

    client = new LanguageClient('qbxLua', 'Qbox Lua', serverOptions, clientOptions);
    client.onDidChangeState((event) => {
        if (event.newState === State.Running) {
            void refreshStatus();
        } else if (event.newState === State.Stopped) {
            setStatus('$(error) Qbox Lua', 'The language server is not running. Click for details.');
        }
    });

    setStatus('$(sync~spin) Qbox Lua', 'Indexing workspace…');
    try {
        await client.start();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setStatus('$(error) Qbox Lua', message);
        const choice = await vscode.window.showErrorMessage(
            `Qbox Lua could not start the language server (${command}): ${message}`,
            'Open Settings',
            'Show Output',
        );
        if (choice === 'Open Settings') {
            await vscode.commands.executeCommand('workbench.action.openSettings', `${CONFIG_SECTION}.server.path`);
        } else if (choice === 'Show Output') {
            output.show();
        }
    }
}

async function restart(context: vscode.ExtensionContext): Promise<void> {
    await client?.stop().catch(() => undefined);
    client = undefined;
    await start(context);
}

async function fetchStatus(): Promise<ServerStatus | undefined> {
    if (!client || client.state !== State.Running) {
        return undefined;
    }
    return client.sendRequest<ServerStatus>('qbx/status');
}

function setStatus(text: string, tooltip: string): void {
    statusItem.text = text;
    statusItem.tooltip = tooltip;
    updateStatusVisibility();
}

function updateStatusVisibility(): void {
    const isLua = vscode.window.activeTextEditor?.document.languageId === 'lua';
    if (isLua || statusItem.text.includes('$(error)')) {
        statusItem.show();
    } else {
        statusItem.hide();
    }
}

const SIDE_LABELS: Record<string, [icon: string, explanation: string]> = {
    client: ['$(device-desktop)', 'runs on the client: client and shared natives and globals are offered'],
    server: ['$(server)', 'runs on the server: server and shared natives and globals are offered'],
    shared: ['$(arrow-swap)', 'loaded on both sides: only what exists on both is safe to use'],
    module: ['$(package)', 'not listed as a script in fxmanifest.lua (loaded through require or lib.load), so it is treated as running on either side'],
    manifest: ['$(list-unordered)', 'resource manifest'],
    standalone: ['$(file)', 'no fxmanifest.lua found above this file, so it is checked on its own'],
};

async function fetchFileInfo(): Promise<FileInfo | undefined> {
    const document = vscode.window.activeTextEditor?.document;
    if (!client || client.state !== State.Running || document?.languageId !== 'lua' || document.uri.scheme !== 'file') {
        return undefined;
    }
    return client.sendRequest<FileInfo>('qbx/fileInfo', { uri: document.uri.toString() });
}

async function refreshStatus(): Promise<void> {
    const status = await fetchStatus().catch(() => undefined);
    if (!status) {
        return;
    }
    const info = await fetchFileInfo().catch(() => undefined);
    const indexed = `${status.files} files in ${status.resources} resources indexed · ${status.natives} natives`;
    if (!info) {
        setStatus('$(check) Qbox Lua', indexed);
        return;
    }
    const [icon, explanation] = SIDE_LABELS[info.side] ?? ['$(check)', ''];
    const resource = info.resource ? `${info.resource} · ` : '';
    setStatus(`${icon} ${info.side}`, `Qbox Lua · ${resource}${info.side}: ${explanation}\n${indexed}`);
}

async function reindex(): Promise<void> {
    if (!client || client.state !== State.Running) {
        void vscode.window.showWarningMessage('The Qbox Lua language server is not running.');
        return;
    }
    setStatus('$(sync~spin) Qbox Lua', 'Indexing workspace…');
    const result = await client.sendRequest<{ files: number; resources: number; millis: number }>('qbx/reindex');
    await refreshStatus();
    void vscode.window.showInformationMessage(
        `Qbox Lua indexed ${result.files} files in ${result.resources} resources (${result.millis} ms).`,
    );
}

async function showStatus(): Promise<void> {
    const status = await fetchStatus().catch(() => undefined);
    if (!status) {
        const choice = await vscode.window.showWarningMessage('The Qbox Lua language server is not running.', 'Restart', 'Show Output');
        if (choice === 'Restart') {
            await vscode.commands.executeCommand('qbxLua.restartServer');
        } else if (choice === 'Show Output') {
            output.show();
        }
        return;
    }
    const choice = await vscode.window.showInformationMessage(
        `Qbox Lua: ${status.files} files in ${status.resources} resources indexed, ${status.openDocuments} open, ${status.natives} natives.`,
        'Reindex',
        'Show Output',
    );
    if (choice === 'Reindex') {
        await reindex();
    } else if (choice === 'Show Output') {
        output.show();
    }
}

function warnAboutOtherLuaExtensions(): void {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    if (!config.get<boolean>('warnAboutOtherLuaExtensions', true)) {
        return;
    }
    const active = CONFLICTING_EXTENSIONS.filter((id) => vscode.extensions.getExtension(id) !== undefined);
    if (active.length === 0) {
        return;
    }
    void vscode.window
        .showWarningMessage(
            `Qbox Lua replaces ${active.join(', ')}. Running them side by side duplicates diagnostics, delays or hides the completion list (VS Code waits for every provider) and keeps LuaLS' memory usage. Disable them for this workspace?`,
            'Show Extensions',
            "Don't Show Again",
        )
        .then(async (choice) => {
            if (choice === 'Show Extensions') {
                await vscode.commands.executeCommand('workbench.extensions.search', `@installed ${active[0]}`);
            } else if (choice === "Don't Show Again") {
                await config.update('warnAboutOtherLuaExtensions', false, vscode.ConfigurationTarget.Global);
            }
        });
}
