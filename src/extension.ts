import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { HoverRequest, LanguageClient, LanguageClientOptions, ServerOptions, State, TransportKind, type Hover as ProtocolHover, type HoverParams } from 'vscode-languageclient/node';
import { HoverLevels, verboseHoverClass, type HoverLevelSettings, type LevelHover } from './hoverLevels';
import { luaQuote } from './luaQuote';
import { registerManifestSnippetCompletions } from './manifestSnippets';
import { ResourceControls } from './resourceControls';
import type { Resource, ResourceIndex } from './resources';
import { ReferenceBrowser } from './referenceBrowser';
import { ReferenceCatalogs, withCatalogs, type CatalogData } from './referenceCatalogs';
import { SETTINGS_SCHEMA_SCHEME, SettingsSchemaProvider, type RuleInfo } from './settingsSchema';
import { registerSidebar } from './sidebar';
import { SnippetBrowser } from './snippetBrowser';
import { SqlHighlighting } from './sqlHighlighting';
import { registerServerCfg } from './serverCfgProvider';
import { registerTerminalSourceLinks } from './terminalLinks';
import { showToolHub } from './toolHub';

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
const LUA_DOCUMENTS = [{ scheme: 'file', language: 'lua' }];
const CONFLICTING_EXTENSIONS = ['sumneko.lua', 'overextended.cfxlua-vscode', 'ihyajb.qbcore-code-snippets'];

let client: LanguageClient | undefined;
let statusItem: vscode.StatusBarItem;
let languageStatus: vscode.LanguageStatusItem;
let workspaceResources: ResourceIndex | undefined;
let activeResource: () => Resource | undefined = () => undefined;
let output: vscode.OutputChannel;
let settingsSchema: SettingsSchemaProvider;
let starting: Promise<void> | undefined;
let reindexTimer: ReturnType<typeof setTimeout> | undefined;
let reindexRunning = false;
let reindexRequested = false;
let sqlHighlighting: SqlHighlighting | undefined;
let sqlRefreshTimer: ReturnType<typeof setTimeout> | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<import('./assistantVscode.js').AssistantApi> {
    output = vscode.window.createOutputChannel('Qbox Lua');
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
    statusItem.command = 'qbxLua.showStatus';
    statusItem.name = 'Qbox Lua';
    languageStatus = vscode.languages.createLanguageStatusItem('qbxLua.status', LUA_DOCUMENTS);
    languageStatus.name = 'Qbox Lua';
    languageStatus.command = { command: 'qbxLua.showStatus', title: 'Tools' };
    context.subscriptions.push(output, statusItem, languageStatus);
    // Registered before the server starts: a settings file that asks for these schemas is what activates the extension.
    settingsSchema = new SettingsSchemaProvider();
    context.subscriptions.push(settingsSchema, vscode.workspace.registerTextDocumentContentProvider(SETTINGS_SCHEMA_SCHEME, settingsSchema));
    sqlHighlighting = new SqlHighlighting(context, output);
    void sqlHighlighting.sync();
    // Where VS Code has hover buttons, this provider shows the server's hovers instead of the client's own.
    const verboseHover = verboseHoverClass();
    const hoverLevels = verboseHover && new HoverLevels(verboseHover, context.globalState, hoverSettings, requestHover);
    if (hoverLevels) {
        context.subscriptions.push(vscode.languages.registerHoverProvider(LUA_DOCUMENTS, hoverLevels));
    }
    const resourceControls = new ResourceControls(context);
    context.subscriptions.push(resourceControls, registerSidebar(resourceControls.resourceIndex));
    workspaceResources = resourceControls.resourceIndex;
    activeResource = () => resourceControls.activeResource();
    let discovered = false;
    void resourceControls.resourceIndex.ready.then(() => { discovered = true; updateStatusVisibility(); }, () => { discovered = true; });
    const request = async <T>(method: string, params: unknown, token?: vscode.CancellationToken): Promise<T> => {
        await ensureStarted(context);
        if (!client || client.state !== State.Running) {
            throw new Error('The Qbox Lua language server is not running. Use Qbox Lua: Restart Language Server, then retry.');
        }
        return token ? client.sendRequest<T>(method, params, token) : client.sendRequest<T>(method, params);
    };
    let catalogs: Promise<import('./referenceCatalogs.js').ReferenceCatalogs> | undefined;
    const loadCatalogs = () => catalogs ??= (async () => {
        const data = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(context.extensionUri, 'data', 'reference-catalogs.json'));
        return new ReferenceCatalogs(JSON.parse(Buffer.from(data).toString('utf8')) as CatalogData);
    })();
    const referenceBrowser = new ReferenceBrowser(context.extensionUri, withCatalogs(request, loadCatalogs));
    const snippetBrowser = new SnippetBrowser(context.extensionUri, context.globalStorageUri, request);
    context.subscriptions.push(referenceBrowser, snippetBrowser, registerManifestSnippetCompletions(context.extensionUri, request));
    const textureEdits = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<vscode.CustomDocument>>();
    const textures = async (): Promise<import('./textureEditor.js').TextureProvider> => (await import('./textureEditor.js')).textureProvider(context.extensionUri, textureEdits);
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
    // Each tool loads its code when a command first asks for it, or when VS Code restores its tab.
    const utilitiesBrowser = async () => {
        const { LuaUtilitiesBrowser } = await import('./luaUtilitiesBrowser.js');
        return extraToolsDisposed ? undefined : utilities ??= new LuaUtilitiesBrowser(context.extensionUri);
    };
    const assetController = async () => {
        const { AssetController } = await import('./assetBrowser.js');
        return extraToolsDisposed ? undefined : assets ??= new AssetController(context.extensionUri, request, resourceControls.resourceIndex, context.workspaceState);
    };
    const detailsController = async () => {
        const { ResourceDetailsController } = await import('./resourceDetailsBrowser.js');
        return detailsDisposed ? undefined : resourceDetails ??= new ResourceDetailsController(context.extensionUri, request, resourceControls.resourceIndex, context.workspaceState);
    };
    const logController = async () => {
        const { RuntimeLogController } = await import('./runtimeToolsBrowser.js');
        return runtimeToolsDisposed ? undefined : runtimeLog ??= new RuntimeLogController(context.extensionUri, resourceControls.resourceIndex, context.workspaceState);
    };
    const healthController = async () => {
        const { WorkspaceHealthController } = await import('./runtimeToolsBrowser.js');
        return runtimeToolsDisposed ? undefined : workspaceHealth ??= new WorkspaceHealthController(context.extensionUri, request);
    };
    const nuiController = async () => {
        const { NuiController } = await import('./nuiBrowser.js');
        return nuiDisposed ? undefined : nuiPreview ??= new NuiController(context.extensionUri, context.workspaceState, request, resourceControls.resourceIndex);
    };
    let dataChecks: import('./dataChecks.js').DataChecks | undefined;
    let dataChecksDisposed = false;
    context.subscriptions.push({ dispose: () => { dataChecksDisposed = true; dataChecks?.dispose(); } });
    const dataCheckController = async () => {
        const { DataChecks } = await import('./dataChecks.js');
        return dataChecksDisposed ? undefined : dataChecks ??= new DataChecks(context.extensionUri, resourceControls.resourceIndex);
    };
    /** Brings the tab of a tool back after a window reload. A tab that cannot be restored closes instead of staying blank. */
    const restoresTab = (viewType: string, tool: () => Promise<{ restore(panel: vscode.WebviewPanel): unknown } | undefined> | { restore(panel: vscode.WebviewPanel): unknown }) =>
        vscode.window.registerWebviewPanelSerializer(viewType, {
            deserializeWebviewPanel: async (panel) => {
                try {
                    const controller = await tool();
                    if (controller) { await controller.restore(panel); } else { panel.dispose(); }
                } catch {
                    panel.dispose();
                }
            },
        });

    context.subscriptions.push(
        { dispose: () => { if (reindexTimer) { clearTimeout(reindexTimer); reindexTimer = undefined; } } },
        { dispose: () => { if (sqlRefreshTimer) { clearTimeout(sqlRefreshTimer); sqlRefreshTimer = undefined; } } },
        // The server watches Lua files by glob, so a resource folder that is dropped in, renamed or
        // removed only reaches its index through an explicit reindex. The initial discovery is not
        // a change: the server scans the same folders itself on startup.
        resourceControls.resourceIndex.onDidChange(() => {
            updateStatusVisibility();
            if (discovered) { scheduleReindex('resource folders changed'); }
        }),
        resourceControls.resourceIndex.onDidChangeFolders(() => { if (discovered) { scheduleReindex('a folder with Lua files changed'); } }),
        vscode.commands.registerCommand('qbxLua.restartServer', () => restart(context)),
        vscode.commands.registerCommand('qbxLua.reindex', reindex),
        vscode.commands.registerCommand('qbxLua.showSnippets', () => snippetBrowser.show()),
        vscode.commands.registerCommand('qbxLua.openSnippets', () => snippetBrowser.show()),
        vscode.commands.registerCommand('qbxLua.saveSelectionAsSnippet', () => snippetBrowser.saveSelection()),
        vscode.commands.registerCommand('qbxLua.editPersonalSnippets', () => snippetBrowser.editPersonal()),
        vscode.commands.registerCommand('qbxLua.editWorkspaceSnippets', () => snippetBrowser.editWorkspace()),
        vscode.commands.registerCommand('qbxLua.openReference', () => referenceBrowser.show()),
        vscode.commands.registerCommand('qbxLua.openLuaUtilities', async () => (await utilitiesBrowser())?.show()),
        vscode.commands.registerCommand('qbxLua.openAssets', async (uri?: unknown) => (await assetController())?.show(await resourceTarget(uri))),
        restoresTab('qbxLua.reference', () => referenceBrowser),
        restoresTab('qbxLua.snippets', () => snippetBrowser),
        restoresTab('qbxLua.luaUtilities', utilitiesBrowser),
        restoresTab('qbxLua.assets', assetController),
        restoresTab('qbxLua.resourceDetails', detailsController),
        restoresTab('qbxLua.runtimeLog', logController),
        restoresTab('qbxLua.workspaceHealth', healthController),
        restoresTab('qbxLua.nuiPreview', nuiController),
        registerTerminalSourceLinks(resourceControls.resourceIndex),
        registerServerCfg(resourceControls.resourceIndex),
        vscode.commands.registerCommand('qbxLua.checkResourceData', async (uri?: unknown) => (await dataCheckController())?.showChecks(uri)),
        vscode.commands.registerCommand('qbxLua.showLocaleMatrix', async (uri?: unknown) => (await dataCheckController())?.showLocales(uri)),
        restoresTab('qbxLua.dataChecks', async () => { const checks = await dataCheckController(); return checks && { restore: (panel: vscode.WebviewPanel) => checks.restoreChecks(panel) }; }),
        restoresTab('qbxLua.localeMatrix', async () => { const checks = await dataCheckController(); return checks && { restore: (panel: vscode.WebviewPanel) => checks.restoreLocales(panel) }; }),
        ...['qbxLua.mapViewer', 'qbxLua.mapViewerXml'].map((viewType) => vscode.window.registerCustomEditorProvider(viewType, {
            openCustomDocument: (uri: vscode.Uri) => ({ uri, dispose: () => undefined }),
            resolveCustomEditor: async (document: vscode.CustomDocument, panel: vscode.WebviewPanel) => {
                const { MapEditor } = await import('./mapEditor.js');
                await new MapEditor(context.extensionUri, document.uri, panel).open(viewType === 'qbxLua.mapViewerXml');
            },
        }, { supportsMultipleEditorsPerDocument: true })),
        vscode.window.registerCustomEditorProvider('qbxLua.modelViewer', {
            openCustomDocument: (uri: vscode.Uri) => ({ uri, dispose: () => undefined }),
            resolveCustomEditor: async (document: vscode.CustomDocument, panel: vscode.WebviewPanel) => {
                const { ModelEditor } = await import('./modelEditor.js');
                await new ModelEditor(context.extensionUri, document.uri, panel).load();
            },
        }, { supportsMultipleEditorsPerDocument: true }),
        vscode.commands.registerCommand('qbxLua.openMapViewer', async (uri?: unknown) => {
            const target = uri instanceof vscode.Uri ? uri : await chooseAssetFile('Open Map Viewer', { 'Map data': ['ymap', 'ytyp', 'xml'] }, /\.(ymap|ytyp)(\.xml)?$/i);
            if (target) {
                const { openMapViewer } = await import('./mapEditor.js');
                await openMapViewer(target);
            }
        }),
        textureEdits,
        vscode.window.registerCustomEditorProvider('qbxLua.textureViewer', {
            onDidChangeCustomDocument: textureEdits.event,
            openCustomDocument: async (uri: vscode.Uri, open: vscode.CustomDocumentOpenContext) => (await textures()).openCustomDocument(uri, open),
            resolveCustomEditor: async (document: vscode.CustomDocument, panel: vscode.WebviewPanel) => (await textures()).resolveCustomEditor(document, panel),
            saveCustomDocument: async (document: vscode.CustomDocument) => (await textures()).saveCustomDocument(document),
            saveCustomDocumentAs: async (document: vscode.CustomDocument, destination: vscode.Uri) => (await textures()).saveCustomDocumentAs(document, destination),
            revertCustomDocument: async (document: vscode.CustomDocument) => (await textures()).revertCustomDocument(document),
            backupCustomDocument: async (document: vscode.CustomDocument, backup: vscode.CustomDocumentBackupContext) => (await textures()).backupCustomDocument(document, backup),
        }, { supportsMultipleEditorsPerDocument: true }),
        vscode.commands.registerCommand('qbxLua.newTextureDictionary', async (target?: unknown, images?: unknown) => (await textures()).create(target, images)),
        vscode.commands.registerCommand('qbxLua.textures.edit', async (request?: unknown) => (await textures()).edit(request)),
        vscode.commands.registerCommand('qbxLua.openTextureViewer', async (uri?: unknown) => {
            const target = uri instanceof vscode.Uri ? uri : await chooseAssetFile('Open Texture Viewer', { Textures: ['ytd', 'dds'] }, /\.(ytd|dds)$/i);
            if (target) {
                await vscode.commands.executeCommand('vscode.openWith', target, 'qbxLua.textureViewer');
            }
        }),
        vscode.window.registerCustomEditorProvider('qbxLua.animViewer', {
            openCustomDocument: (uri: vscode.Uri) => ({ uri, dispose: () => undefined }),
            resolveCustomEditor: async (document: vscode.CustomDocument, panel: vscode.WebviewPanel) => {
                const { AnimEditor } = await import('./animEditor.js');
                await new AnimEditor(context.extensionUri, document.uri, panel).load();
            },
        }, { supportsMultipleEditorsPerDocument: true }),
        vscode.commands.registerCommand('qbxLua.openAnimViewer', async (uri?: unknown) => {
            const target = uri instanceof vscode.Uri ? uri : await chooseAssetFile('Open Animation Dictionary', { 'Animation dictionaries': ['ycd'] }, /\.ycd$/i);
            if (target) {
                await vscode.commands.executeCommand('vscode.openWith', target, 'qbxLua.animViewer');
            }
        }),
        vscode.commands.registerCommand('qbxLua.openModelViewer', async (uri?: unknown) => {
            const target = uri instanceof vscode.Uri ? uri : await chooseAssetFile('Open Model Viewer', { 'Models and collision': ['ydr', 'ydd', 'yft', 'ybn'] }, /\.(ydr|ydd|yft|ybn)$/i);
            if (target) {
                await vscode.commands.executeCommand('vscode.openWith', target, 'qbxLua.modelViewer');
            }
        }),
        vscode.commands.registerCommand('qbxLua.addAssetNameList', async () => {
            const picked = await vscode.window.showOpenDialog({ title: 'Add Asset Name List', canSelectMany: true, filters: { 'Name lists': ['txt', 'ini', 'json', 'csv'], 'All files': ['*'] } });
            if (!picked?.length) {
                return;
            }
            const config = vscode.workspace.getConfiguration(CONFIG_SECTION), current = config.get<string[]>('assets.nameLists', []);
            await config.update('assets.nameLists', [...new Set([...current, ...picked.map((uri) => uri.fsPath)])], vscode.ConfigurationTarget.Global);
            void vscode.window.showInformationMessage(`Asset viewers now resolve hashes with ${picked.length === 1 ? 'that name list' : `those ${picked.length} name lists`}.`);
        }),
        vscode.commands.registerCommand('qbxLua.assistantSetup', async () => {
            await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.joinPath(context.extensionUri, 'docs', 'assistant-tools.md'));
        }),
        vscode.commands.registerCommand('qbxLua.copyMcpConfiguration', async () => {
            const { copyMcpConfiguration } = await import('./assistantSetup.js');
            await copyMcpConfiguration(context);
        }),
        vscode.commands.registerCommand('qbxLua.resetSqlFunctions', resetSqlFunctions),
        vscode.commands.registerCommand('qbxLua.resources.create', async (uri?: unknown) => {
            const { ResourceWizard } = await import('./resourceWizard.js');
            if (wizardDisposed) { return; }
            resourceWizard ??= new ResourceWizard(() => luaQuote(request));
            await resourceWizard.show(uri);
        }),
        vscode.commands.registerCommand('qbxLua.resources.details', async (uri?: unknown) => (await detailsController())?.show(await resourceTarget(uri))),
        vscode.commands.registerCommand('qbxLua.showStatus', showStatus),
        vscode.commands.registerCommand('qbxLua.openRuntimeLog', async (uri?: unknown) => (await logController())?.show(uri)),
        vscode.commands.registerCommand('qbxLua.workspaceHealth', async () => (await healthController())?.show()),
        vscode.commands.registerCommand('qbxLua.showOutput', () => output.show()),
        vscode.commands.registerCommand('qbxLua.openNuiPreview', async (uri?: unknown) => (await nuiController())?.show(await resourceTarget(uri))),
        vscode.workspace.onDidChangeConfiguration((event) => {
            const needsRestart = event.affectsConfiguration(`${CONFIG_SECTION}.server.path`) || event.affectsConfiguration(`${CONFIG_SECTION}.library`);
            if (needsRestart && starting) {
                void restart(context);
            }
            if (event.affectsConfiguration(`${CONFIG_SECTION}.hover`)) {
                void hoverLevels?.forget();
            }
            if (event.affectsConfiguration(`${CONFIG_SECTION}.sqlHighlighting`)) {
                void sqlHighlighting?.sync().then(refreshSqlFunctions);
            }
        }),
        // Trust lifts the restriction on `server.path` and `library`, which the server reads when it starts.
        vscode.workspace.onDidGrantWorkspaceTrust(() => {
            if (starting) {
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
            // A saved file may declare another function that takes SQL.
            if (document.languageId === 'lua') {
                scheduleSqlRefresh();
            }
        }),
        vscode.workspace.onDidChangeTextDocument(suggestAnnotationTags),
    );

    // Not awaited: the server indexes the workspace while it starts, and commands, views and the
    // API of this extension must not wait for that.
    if (await hasLuaWork()) {
        void ensureStarted(context);
    } else {
        context.subscriptions.push(
            vscode.workspace.onDidOpenTextDocument((document) => {
                if (document.languageId === 'lua') {
                    void ensureStarted(context);
                }
            }),
            resourceControls.resourceIndex.onDidChange((resources) => {
                if (resources.length > 0) {
                    void ensureStarted(context);
                }
            }),
        );
    }
    void import('./assistantSetup.js').then(({ refreshMcpLauncher }) => refreshMcpLauncher(context)).catch(() => undefined);
    const { registerAssistantTools } = await import('./assistantVscode.js');
    return registerAssistantTools(context, request);
}

/**
 * Opens the annotation tag list when the first letter is typed after `---@`. The `---@` that Enter
 * adds to an annotation block opens no list, so Enter on it can still clear it, and VS Code does
 * not suggest while typing in comments.
 */
function suggestAnnotationTags(event: vscode.TextDocumentChangeEvent): void {
    const [change] = event.contentChanges;
    if (event.document.languageId !== 'lua' || event.contentChanges.length !== 1 || !/^[A-Za-z]$/.test(change.text)) {
        return;
    }
    const typed = event.document.lineAt(change.range.start.line).text.slice(0, change.range.start.character + 1);
    if (/^[ \t]*---@[A-Za-z]$/.test(typed) && vscode.window.activeTextEditor?.document === event.document) {
        void vscode.commands.executeCommand('editor.action.triggerSuggest');
    }
}

/**
 * What a resource tool opens for: the folder of the resource `uri` names or lies in, else that of
 * the file being edited. Without either the tool asks.
 */
async function resourceTarget(uri: unknown): Promise<unknown> {
    if (uri instanceof vscode.Uri) {
        return (await workspaceResources?.owner(uri))?.folder ?? uri;
    }
    return uri ?? activeResource()?.folder;
}

/** The active file when it matches `pattern`, otherwise a file the user picks. */
async function chooseAssetFile(title: string, filters: Record<string, string[]>, pattern: RegExp): Promise<vscode.Uri | undefined> {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    const active = input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom ? input.uri : undefined;
    if (active && pattern.test(active.path)) {
        return active;
    }
    const picked = await vscode.window.showOpenDialog({ title, filters, canSelectMany: false, defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri });
    return picked?.[0];
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
        context.asAbsolutePath(path.join('..', 'qbx-lua', 'target', 'release', binaryName())),
        context.asAbsolutePath(path.join('..', 'qbx-lua', 'target', 'debug', binaryName())),
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
            strict: config.get<boolean>('diagnostics.strict', false),
        },
        inlayHints: { enable: config.get<boolean>('inlayHints.enable', true) },
        semanticTokens: { enable: config.get<boolean>('semanticTokens.enable', true) },
        hover: { verbosity: config.get<number>('hover.verbosity', 1) },
    };
}

function hoverSettings(document: vscode.TextDocument): HoverLevelSettings {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION, document);
    return { verbosity: config.get<number>('hover.verbosity', 1), remember: config.get<boolean>('hover.rememberVerbosity', false) };
}

/** The server's hover at `level`, with the `maxLevel` it answers, as lua-language-server's client asks for it. */
async function requestHover(document: vscode.TextDocument, position: vscode.Position, level: number, token: vscode.CancellationToken): Promise<LevelHover | undefined> {
    if (!client || client.state !== State.Running) {
        return undefined;
    }
    const params: HoverParams & { level: number } = { ...client.code2ProtocolConverter.asTextDocumentPositionParams(document, position), level };
    try {
        const result = (await client.sendRequest(HoverRequest.type, params, token)) as (ProtocolHover & { maxLevel?: unknown }) | null;
        const hover = client.protocol2CodeConverter.asHover(result);
        return hover && { hover, maxLevel: typeof result?.maxLevel === 'number' ? result.maxLevel : undefined };
    } catch (error) {
        return client.handleFailedRequest(HoverRequest.type, token, error, undefined);
    }
}

async function start(context: vscode.ExtensionContext): Promise<void> {
    const command = resolveServerPath(context);
    output.appendLine(`starting ${command}`);

    const serverOptions: ServerOptions = {
        run: { command, transport: TransportKind.stdio },
        debug: { command, transport: TransportKind.stdio },
    };
    const clientOptions: LanguageClientOptions = {
        documentSelector: LUA_DOCUMENTS,
        outputChannel: output,
        initializationOptions: serverSettings(),
        synchronize: { configurationSection: CONFIG_SECTION },
        // Doc comments may use HTML such as `<b>` and `<br>`, which VS Code renders from the safe
        // subset it allows, as the LuaLS client has it do.
        markdown: { supportHtml: true },
        // The provider that `activate` registers shows hovers with buttons where VS Code has them.
        middleware: verboseHoverClass() ? { provideHover: () => undefined } : undefined,
    };

    client = new LanguageClient('qbxLua', 'Qbox Lua', serverOptions, clientOptions);
    // Lists the commands VS Code runs for the server, the way rust-analyzer's client does, so a
    // completed callback wrapper call can reopen suggestions with the registered names.
    client.registerFeature({
        fillClientCapabilities(capabilities) {
            const experimental = (capabilities.experimental ?? {}) as Record<string, unknown>;
            capabilities.experimental = { ...experimental, commands: { commands: ['editor.action.triggerSuggest'] } };
        },
        initialize() {},
        getState() {
            return { kind: 'static' };
        },
        clear() {},
    });
    client.onDidChangeState((event) => {
        if (event.newState === State.Running) {
            void refreshStatus();
            void loadRules();
            void refreshSqlFunctions();
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

/** A settings file asking for the rule schemas activates the extension in any window, so only Lua work starts the server. */
async function hasLuaWork(): Promise<boolean> {
    if (vscode.workspace.textDocuments.some((document) => document.languageId === 'lua')) {
        return true;
    }
    const manifests = await vscode.workspace.findFiles('**/{fxmanifest.lua,__resource.lua}', undefined, 1);
    return manifests.length > 0;
}

function ensureStarted(context: vscode.ExtensionContext): Promise<void> {
    starting ??= start(context).then(warnAboutOtherLuaExtensions);
    return starting;
}

/**
 * Restarts follow the start or restart before them: a client that is still starting cannot be
 * stopped, and starting another beside it would leave two servers running.
 */
function restart(context: vscode.ExtensionContext): Promise<void> {
    const previous = starting;
    starting = (async () => {
        await previous?.catch(() => undefined);
        const running = client;
        client = undefined;
        await running?.stop().catch(() => undefined);
        await start(context);
    })();
    return starting;
}

async function fetchStatus(): Promise<ServerStatus | undefined> {
    if (!client || client.state !== State.Running) {
        return undefined;
    }
    return client.sendRequest<ServerStatus>('qbx/status');
}

/** Hands the rules of the server that just started to the settings schema. A server without `qbx/rules` lists none. */
async function loadRules(): Promise<void> {
    const rules = await client?.sendRequest<RuleInfo[]>('qbx/rules').catch(() => undefined);
    settingsSchema.update(Array.isArray(rules) ? rules : []);
}

/** Hands the functions that take SQL to the highlighting, unless it is off. A server without `qbx/sqlFunctions` leaves the highlighting as it is. */
async function refreshSqlFunctions(): Promise<void> {
    // The grammar is shared by every window, so the code of a workspace that is not trusted adds nothing to it.
    if (!vscode.workspace.isTrusted || !sqlHighlighting?.enabled()) {
        return;
    }
    const functions = await sqlFunctions();
    if (functions) {
        await sqlHighlighting.sync(functions);
    }
}

async function sqlFunctions(): Promise<string[] | undefined> {
    if (!client || client.state !== State.Running) {
        return undefined;
    }
    const result = await client.sendRequest<{ functions?: unknown }>('qbx/sqlFunctions').catch(() => undefined);
    return Array.isArray(result?.functions) ? result.functions.filter((name): name is string => typeof name === 'string') : undefined;
}

/** Drops the query functions that other workspaces added to the shared SQL grammar. */
async function resetSqlFunctions(): Promise<void> {
    const functions = vscode.workspace.isTrusted ? await sqlFunctions() : [];
    if (!(await sqlHighlighting?.reset(functions ?? []))) {
        void vscode.window.showInformationMessage('SQL highlighting already lists only the query functions of this workspace.');
    }
}

/** Asks for the functions that take SQL once saves settle. */
function scheduleSqlRefresh(): void {
    if (sqlRefreshTimer) {
        clearTimeout(sqlRefreshTimer);
    }
    sqlRefreshTimer = setTimeout(() => {
        sqlRefreshTimer = undefined;
        void refreshSqlFunctions();
    }, 1000);
}

function setStatus(text: string, tooltip: string): void {
    statusItem.text = text;
    statusItem.tooltip = `${tooltip}\nClick for the FiveM tools.`;
    languageStatus.text = text.replace(/^\$\([^)]*\)\s*/, '');
    languageStatus.detail = tooltip.split('\n')[0];
    languageStatus.busy = text.includes('$(sync~spin)');
    languageStatus.severity = text.includes('$(error)') ? vscode.LanguageStatusSeverity.Error : vscode.LanguageStatusSeverity.Information;
    updateStatusVisibility();
}

/** Shown while Lua is edited, on errors, and in any editor of a workspace with resources, where it opens the tools. */
function updateStatusVisibility(): void {
    const isLua = vscode.window.activeTextEditor?.document.languageId === 'lua';
    if (isLua || statusItem.text.includes('$(error)') || (statusItem.text && (workspaceResources?.entries.length ?? 0) > 0)) {
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

/** Coalesces folder-level changes into one background reindex once the file system settles. */
function scheduleReindex(reason: string): void {
    if (reindexTimer) {
        clearTimeout(reindexTimer);
    }
    reindexTimer = setTimeout(() => {
        reindexTimer = undefined;
        void reindexInBackground(reason);
    }, 1500);
}

async function reindexInBackground(reason: string): Promise<void> {
    if (reindexRunning) {
        reindexRequested = true;
        return;
    }
    if (!client || client.state !== State.Running) {
        return;
    }
    reindexRunning = true;
    try {
        const result = await client.sendRequest<{ files: number; resources: number; millis: number }>('qbx/reindex');
        output.appendLine(`reindexed because ${reason}: ${result.files} files in ${result.resources} resources (${result.millis} ms)`);
        await refreshStatus();
    } catch (error) {
        output.appendLine(`reindex after ${reason} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
        reindexRunning = false;
        if (reindexRequested) {
            reindexRequested = false;
            scheduleReindex(reason);
        }
    }
}

async function reindex(): Promise<void> {
    if (!client || client.state !== State.Running) {
        void vscode.window.showWarningMessage('The Qbox Lua language server is not running.');
        return;
    }
    setStatus('$(sync~spin) Qbox Lua', 'Indexing workspace…');
    let result: { files: number; resources: number; millis: number };
    try {
        result = await client.sendRequest<{ files: number; resources: number; millis: number }>('qbx/reindex');
    } finally {
        await refreshStatus();
    }
    void vscode.window.showInformationMessage(
        `Qbox Lua indexed ${result.files} files in ${result.resources} resources (${result.millis} ms).`,
    );
}

/** The status of the index above every tool, with the actions for the resource being edited first. */
async function showStatus(): Promise<void> {
    const status = await fetchStatus().catch(() => undefined);
    const summary = status
        ? `${status.files} files in ${status.resources} resources indexed, ${status.openDocuments} open, ${status.natives} natives`
        : starting ? 'The language server is not running. Restart it from this list.' : 'The language server starts with the first Lua file or resource.';
    await showToolHub(summary, activeResource());
}

async function warnAboutOtherLuaExtensions(): Promise<void> {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    if (!config.get<boolean>('warnAboutOtherLuaExtensions', true)) {
        return;
    }
    const active = CONFLICTING_EXTENSIONS.filter((id) => vscode.extensions.getExtension(id) !== undefined);
    if (active.length === 0) {
        return;
    }
    // Without a resource this may be another kind of Lua project, where those extensions are the right ones.
    await workspaceResources?.ready.catch(() => undefined);
    if (!workspaceResources?.entries.length) {
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
