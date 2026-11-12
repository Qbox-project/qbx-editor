import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { mcpConfiguration, mcpLauncherSource, writeMcpLauncher } from '../../src/assistantSetup';
import { loadManifestSnippets, manifestSnippetPrefixes } from '../../src/manifestSnippets';
import { ReferenceBrowser } from '../../src/referenceBrowser';
import { ReportPanel } from '../../src/reportBrowser';
import type { ReportView } from '../../src/reportTypes';
import { unknownResource } from '../../src/resourceControls';
import { ResourceIndex } from '../../src/resources';
import { CFG_LANGUAGE } from '../../src/serverCfgProvider';
import { MAX_SQL_FUNCTIONS, SQL_FUNCTIONS_GRAMMAR, SQL_GRAMMAR, SqlHighlighting, boundedFunctions, grammarText, isSqlFunctionName, sqlFunctionsGrammar, sqlGrammar } from '../../src/sqlHighlighting';
import { hubItems } from '../../src/toolHub';
import type { Test } from './runner';

async function temporary<T>(prefix: string, run: (folder: string) => Promise<T>): Promise<T> {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    try { return await run(folder); } finally { await fs.rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
}

async function waitFor<T>(what: string, probe: () => Promise<T | undefined> | T | undefined, timeoutMs = 20000): Promise<T> {
    const started = Date.now();
    for (;;) {
        const value = await probe();
        if (value !== undefined) { return value; }
        if (Date.now() - started > timeoutMs) { throw new Error(`timed out waiting for ${what}`); }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function extension(): vscode.Extension<unknown> {
    const found = vscode.extensions.getExtension('qbox.qbx-lua');
    assert.ok(found, 'extension should be installed in the test host');
    return found;
}

interface Manifest {
    capabilities: { untrustedWorkspaces: { supported: string }; virtualWorkspaces: { supported: boolean } };
    activationEvents: string[];
    contributes: {
        commands: { command: string; title: string; category?: string }[];
        menus: Record<string, { command?: string; submenu?: string; when?: string }[]>;
        keybindings: { command: string; key: string; mac?: string; when?: string }[];
        languages: { id: string; filenames?: string[] }[];
    };
}

const tests: Test[] = [
    ['every contributed command, menu entry and keybinding names a command the extension registers', async () => {
        const own = extension();
        await own.activate();
        const manifest = own.packageJSON as Manifest;
        const registered = new Set(await vscode.commands.getCommands(true));
        const contributed = new Set(manifest.contributes.commands.map((command) => command.command));
        for (const command of contributed) { assert.ok(registered.has(command), `${command} is contributed but not registered`); }
        for (const [menu, entries] of Object.entries(manifest.contributes.menus)) {
            for (const entry of entries) {
                if (entry.command) { assert.ok(contributed.has(entry.command), `${menu} uses ${entry.command}, which is not contributed`); }
            }
        }
        for (const binding of manifest.contributes.keybindings) {
            assert.ok(contributed.has(binding.command), binding.command);
            assert.ok(binding.when?.includes('qbxLua.hasResources'), 'a shortcut of this extension only acts in a workspace with resources');
        }
        assert.equal(manifest.contributes.keybindings.find((binding) => binding.command === 'qbxLua.resources.restart')?.key, 'ctrl+alt+r');
        assert.deepEqual(manifest.contributes.menus.commandPalette, [{ command: 'qbxLua.showSnippets', when: 'false' }], 'the second name of the snippet browser stays out of the palette');
        for (const view of ['reference', 'snippets', 'luaUtilities', 'assets', 'resourceDetails', 'runtimeLog', 'workspaceHealth', 'nuiPreview', 'dataChecks', 'localeMatrix']) {
            assert.ok(manifest.activationEvents.includes(`onWebviewPanel:qbxLua.${view}`), `${view} tabs wake the extension to be restored`);
        }
        assert.equal(manifest.capabilities.virtualWorkspaces.supported, false);

        // The manifest on disk names its texts by key; VS Code's own %APP_…% variables are no keys.
        const raw = await fs.readFile(path.join(own.extensionPath, 'package.json'), 'utf8');
        const texts = JSON.parse(await fs.readFile(path.join(own.extensionPath, 'package.nls.json'), 'utf8')) as Record<string, string>;
        const keys = [...new Set(raw.match(/%[a-z][A-Za-z0-9_.-]*%/g) ?? [])].map((key) => key.slice(1, -1));
        assert.ok(keys.length > 50, 'titles and descriptions are in package.nls.json');
        for (const key of keys) { assert.ok(texts[key]?.trim(), `package.nls.json has no text for ${key}`); }
        assert.deepEqual(Object.keys(texts).filter((key) => !keys.includes(key)), [], 'package.nls.json holds no text the manifest does not use');
        assert.ok(manifest.contributes.commands.every((command) => !command.title.includes('%')), 'VS Code resolved every title');
    }],
    ['the tool list leads with the resource being edited and leaves out what an untrusted workspace cannot do', async () => {
        const registered = new Set(await vscode.commands.getCommands(true));
        const active = { name: 'garage', folder: vscode.Uri.file(path.join(os.tmpdir(), 'garage')), manifest: vscode.Uri.file(path.join(os.tmpdir(), 'garage', 'fxmanifest.lua')) };
        const trusted = hubItems(active, true);
        assert.equal(trusted[0].kind, vscode.QuickPickItemKind.Separator);
        assert.equal(trusted[0].label, 'garage');
        assert.deepEqual([trusted[1].command, trusted[1].argument?.toString()], ['qbxLua.resources.restart', active.folder.toString()]);
        for (const item of trusted) {
            if (item.command) { assert.ok(registered.has(item.command), `${item.command} is in the tool list but not registered`); }
        }
        assert.ok(!trusted.some((item) => item.command === 'qbxLua.showStatus'), 'the list does not offer to open itself');
        const restricted = hubItems(active, false).map((item) => item.command);
        for (const command of ['qbxLua.resources.restart', 'qbxLua.resources.ensure', 'qbxLua.resources.stop', 'qbxLua.openNuiPreview', 'qbxLua.resources.configureConnection']) {
            assert.ok(!restricted.includes(command), `${command} needs a trusted workspace`);
        }
        assert.ok(restricted.includes('qbxLua.resources.details') && restricted.includes('qbxLua.openReference'));
        assert.ok(!hubItems(undefined, true).some((item) => item.argument), 'without a resource being edited no action names one');
    }],
    ['MCP configuration points every client at one launcher that starts the installed server', () => temporary('qbx-editor-mcp-', async (folder) => {
        const launcher = path.join(folder, 'global storage', 'qbx-lua-mcp.js');
        const generic = JSON.parse(mcpConfiguration('mcpServers', launcher, ['C:\\server data\\resources', '/srv/resources'])) as { mcpServers: Record<string, { command: string; args: string[] }> };
        assert.deepEqual(generic.mcpServers['qbox-lua'], { command: 'node', args: [launcher, '--workspace', 'C:\\server data\\resources', '--workspace', '/srv/resources'] });
        const code = JSON.parse(mcpConfiguration('vscode', launcher, ['/srv/resources'])) as { servers: Record<string, { type: string; args: string[] }> };
        assert.equal(code.servers['qbox-lua'].type, 'stdio');
        assert.equal(mcpConfiguration('claude', '/home/me/a b/launcher.js', ['/srv/my resources']), 'claude mcp add qbox-lua -- node "/home/me/a b/launcher.js" --workspace "/srv/my resources"');
        assert.match(mcpLauncherSource('C:\\ext\\dist\\assistantMcp.js'), /require\("C:\\\\ext\\\\dist\\\\assistantMcp\.js"\)\.startAssistantMcp\(process\.argv\.slice\(2\)\)/);

        const context = { globalStorageUri: vscode.Uri.file(path.dirname(launcher)), extensionUri: extension().extensionUri };
        const written = await writeMcpLauncher(context);
        assert.equal(written.fsPath.toLowerCase(), launcher.toLowerCase());
        const before = (await fs.stat(launcher)).mtimeMs;
        await writeMcpLauncher(context);
        assert.equal((await fs.stat(launcher)).mtimeMs, before, 'a launcher that is current is left alone');
        const run = spawnSync(process.execPath, [launcher], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30000, windowsHide: true });
        assert.equal(run.status, 1, run.stderr);
        assert.match(run.stderr, /Qbox Lua MCP: .*--workspace/, 'the launcher reaches the server of the extension, which asks for its folders');
    })],
    ['the shared SQL grammar stays bounded, takes only function names, and can be reset to this workspace', () => temporary('qbx-editor-sql-', async (folder) => {
        assert.deepEqual(boundedFunctions(['A', 'B'], ['B', 'C']), ['A', 'B', 'C']);
        assert.deepEqual(boundedFunctions(['old1', 'old2', 'mine'], ['mine', 'new'], 3), ['old2', 'mine', 'new'], 'the oldest function of another workspace goes first');
        assert.deepEqual(boundedFunctions(['a', 'b'], ['c', 'd', 'e'], 2), ['d', 'e']);
        assert.equal(boundedFunctions(Array.from({ length: MAX_SQL_FUNCTIONS + 40 }, (_, index) => `F${index}`), []).length, MAX_SQL_FUNCTIONS);
        for (const name of ['Fetch', 'DB.fetch', 'DB:query', 'exports.my-db:scalar', '_private.run']) { assert.ok(isSqlFunctionName(name), name); }
        for (const name of ['', '1abc', 'a b', 'a(b)', 'x|y', 'a\\b', 'a'.repeat(129), 42, null]) { assert.ok(!isSqlFunctionName(name), String(name)); }

        await fs.mkdir(path.join(folder, 'syntaxes'));
        await fs.writeFile(path.join(folder, SQL_GRAMMAR), grammarText(sqlGrammar()));
        await fs.writeFile(path.join(folder, SQL_FUNCTIONS_GRAMMAR), grammarText(sqlFunctionsGrammar([])));
        const context = { extensionMode: vscode.ExtensionMode.Production, asAbsolutePath: (relative: string) => path.join(folder, relative) } as unknown as vscode.ExtensionContext;
        const output = vscode.window.createOutputChannel('qbx-sql-bounds-test');
        const highlighting = new SqlHighlighting(context, output, () => true);
        (highlighting as unknown as { offerReload(message: string): void }).offerReload = () => undefined;
        const listed = async () => (JSON.parse(await fs.readFile(path.join(folder, SQL_FUNCTIONS_GRAMMAR), 'utf8')) as { functions: string[] }).functions;
        try {
            await highlighting.sync(['Other.query', 'not a name', 'x|y']);
            await highlighting.sync(['DB.fetch']);
            assert.deepEqual(await listed(), ['Other.query', 'DB.fetch'], 'names are kept in the order they arrived, without what is no function path');
            assert.equal(await highlighting.reset(['DB.fetch']), true);
            assert.deepEqual(await listed(), ['DB.fetch'], 'reset drops what other workspaces added');
            assert.equal(await highlighting.reset(['DB.fetch']), false, 'a grammar that is already reset is left alone');
            assert.deepEqual((await fs.readdir(path.join(folder, 'syntaxes'))).sort(), ['sql-functions.injection.json', 'sql.injection.json'], 'no temporary file stays behind');
        } finally {
            output.dispose();
        }
    })],
    ['manifest snippet prefixes are offered by what is typed and where', async () => {
        const snippets = await loadManifestSnippets(extension().extensionUri);
        const offered = (typed: string, manifest: boolean) => manifestSnippetPrefixes(snippets, typed, manifest).map((entry) => entry.prefix);
        assert.deepEqual(offered('fxm', true), ['fxmanifest']);
        assert.deepEqual(offered('MAN', true), ['manifest']);
        assert.deepEqual(offered('fxm', false), [], 'a script is not offered a whole manifest');
        assert.deepEqual(offered('qbx', false), ['qbxconfig']);
        assert.deepEqual(offered('local', true), [], 'other words ask nothing of the language server');
        assert.deepEqual(offered('', false), ['qbxconfig']);
    }],
    ['a file names the resource it lies in, and only folders with Lua files reach the language index', () => temporary('qbx-editor-folders-', async (folder) => {
        const root = vscode.Uri.file(path.join(folder, 'workspace'));
        const garage = vscode.Uri.joinPath(root, '[local]', 'garage');
        const inner = vscode.Uri.joinPath(garage, 'vendor_copy', 'inner');
        for (const [file, text] of [
            [vscode.Uri.joinPath(garage, 'fxmanifest.lua'), "fx_version 'cerulean'\n"], [vscode.Uri.joinPath(garage, 'client', 'main.lua'), 'print(1)\n'],
            [vscode.Uri.joinPath(garage, 'web', 'src', 'app.js'), 'export {}\n'], [vscode.Uri.joinPath(inner, 'fxmanifest.lua'), "fx_version 'cerulean'\n"],
            [vscode.Uri.joinPath(inner, 'shared.lua'), 'return {}\n'], [vscode.Uri.joinPath(root, 'notes', 'readme.md'), '# notes\n'],
        ] as const) {
            await fs.mkdir(path.dirname(file.fsPath), { recursive: true });
            await fs.writeFile(file.fsPath, text);
        }
        const index = new ResourceIndex([root]);
        let events = 0;
        const subscription = index.onDidChangeFolders(() => events++);
        try {
            await index.ready;
            const script = vscode.Uri.joinPath(garage, 'client', 'main.lua');
            assert.equal(index.containing(script)?.name, 'garage');
            assert.equal(index.containing(vscode.Uri.joinPath(inner, 'shared.lua'))?.name, 'inner', 'the innermost resource holds a file of a nested one');
            assert.equal(index.containing(vscode.Uri.joinPath(root, 'notes', 'readme.md')), undefined);
            assert.equal(await index.resolve(script), undefined, 'a script is still not a resource');
            assert.equal((await index.owner(script))?.name, 'garage', 'but an action on it means its resource');
            assert.equal((await index.owner(garage))?.name, 'garage');
            assert.equal(await index.owner(vscode.Uri.joinPath(garage, 'client')), undefined, 'a folder inside a resource names nothing');
            assert.equal(await index.owner(vscode.Uri.joinPath(root, 'notes', 'readme.md')), undefined);

            // Past the scan that learns which folders hold Lua files, so deletions are judged by it.
            await pause(3000);
            events = 0;
            const dist = vscode.Uri.joinPath(garage, 'web', 'dist');
            await fs.mkdir(path.join(dist.fsPath, 'assets'), { recursive: true });
            await fs.writeFile(path.join(dist.fsPath, 'assets', 'index.js'), 'export {}\n');
            await pause(2500);
            await fs.rm(dist.fsPath, { recursive: true, force: true });
            await pause(2500);
            assert.equal(events, 0, 'the build output of an interface appears and vanishes without a reindex');

            const written = vscode.Uri.joinPath(garage, 'written');
            await fs.mkdir(written.fsPath, { recursive: true });
            await fs.writeFile(path.join(written.fsPath, 'one.lua'), 'return {}\n');
            await pause(2500);
            assert.equal(events, 0, 'Lua files written one by one announce themselves; their folder adds nothing');

            // A folder moved in arrives as one folder event, with no event for the files in it.
            const staged = path.join(folder, 'staged', 'modules'), modules = vscode.Uri.joinPath(garage, 'modules');
            await fs.mkdir(staged, { recursive: true });
            await fs.writeFile(path.join(staged, 'bridge.lua'), 'return {}\n');
            await fs.rename(staged, modules.fsPath);
            await waitFor('a moved-in folder with Lua files to be reported', () => (events > 0 ? true : undefined));
            await pause(1500);
            events = 0;
            await fs.rm(modules.fsPath, { recursive: true, force: true });
            await waitFor('a removed folder with Lua files to be reported', () => (events > 0 ? true : undefined));
        } finally {
            subscription.dispose();
            index.dispose();
        }
    })],
    ['a restored reference tab is taken over instead of a second one opening', async () => {
        const browser = new ReferenceBrowser(extension().extensionUri, async () => { throw new Error('no server in this test'); });
        const tabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith('qbxLua.reference'));
        const existing = tabs().length;
        const panel = vscode.window.createWebviewPanel('qbxLua.reference', 'FiveM Reference', vscode.ViewColumn.Beside, {});
        try {
            browser.restore(panel);
            assert.match(panel.webview.html, /referenceWebview\.js/);
            assert.equal(panel.webview.options.enableScripts, true);
            browser.show();
            await pause(300);
            assert.equal(tabs().length, existing + 1, 'show reveals the restored tab');
            const second = vscode.window.createWebviewPanel('qbxLua.reference', 'FiveM Reference', vscode.ViewColumn.Beside, {});
            let closed = false;
            second.onDidDispose(() => { closed = true; });
            browser.restore(second);
            assert.equal(closed, true, 'a second restored tab of a single-tab tool closes');
        } finally {
            browser.dispose();
            panel.dispose();
        }
    }],
    ['a report tab shows what its check finds and checks again on request', async () => {
        let runs = 0;
        const view = (): ReportView => ({ title: 'Test report', subtitle: `run ${runs}`, stats: [{ label: 'Runs', value: String(runs) }], notes: [],
            sections: [{ title: 'Rows', columns: ['Name'], rows: [{ cells: ['garage'], link: { id: 'one', label: 'fxmanifest.lua:1' } }] }] });
        const report = new ReportPanel(extension().extensionUri, 'qbxLua.dataChecks', 'Test report', async (status) => { runs++; status('reading'); return { view: view(), links: new Map() }; });
        const seen: ReportView[] = [];
        const subscription = report.onDidReport((shown) => seen.push(shown));
        try {
            await report.show();
            assert.equal(seen.length, 1);
            assert.equal(seen[0].subtitle, 'run 1');
            assert.equal(report.visible, true);
            await report.refresh();
            assert.equal(seen[1].subtitle, 'run 2');
            await report.show();
            assert.equal(runs, 3, 'showing an open report checks again');
        } finally {
            subscription.dispose();
            report.dispose();
        }
        assert.equal(report.visible, false);
    }],
    ['server.cfg gets its own language with completion, hovers and checks', () => temporary('qbx-editor-cfg-', async (folder) => {
        await fs.writeFile(path.join(folder, 'permissions.cfg'), 'add_ace group.admin command allow\n');
        const file = path.join(folder, 'server.cfg');
        await fs.writeFile(file, 'endpoint_add_tcp "0.0.0.0:30120"\nexec permissions.cfg\nexec missing.cfg\nensure \nsv_enforceGameBuild 3258\n');
        const document = await vscode.workspace.openTextDocument(file);
        assert.equal(document.languageId, CFG_LANGUAGE, 'server.cfg is a FiveM configuration file by its name');
        await vscode.window.showTextDocument(document);
        try {
            const diagnostics = await waitFor('the check of exec targets', () => {
                const found = vscode.languages.getDiagnostics(document.uri);
                return found.length > 0 ? found : undefined;
            });
            assert.deepEqual(diagnostics.map((diagnostic) => [diagnostic.range.start.line, diagnostic.severity, /missing\.cfg does not exist/.test(diagnostic.message)]), [[2, vscode.DiagnosticSeverity.Warning, true]]);
            const labels = async (line: number, character: number): Promise<string[]> => {
                const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', document.uri, new vscode.Position(line, character));
                return list.items.map((item) => (typeof item.label === 'string' ? item.label : item.label.label));
            };
            const commands = await labels(5, 0);
            assert.ok(commands.includes('ensure') && commands.includes('sv_hostname') && commands.includes('add_ace'), commands.join(', '));
            assert.ok((await labels(3, 7)).includes('myresource'), 'ensure completes the resources of the workspace');
            assert.ok((await labels(4, 20)).includes('3258'));
            const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', document.uri, new vscode.Position(4, 4));
            const text = hovers.flatMap((hover) => hover.contents).map((content) => (typeof content === 'string' ? content : content.value)).join('\n');
            assert.match(text, /game build clients must run/);
            const links = await vscode.commands.executeCommand<vscode.DocumentLink[]>('vscode.executeLinkProvider', document.uri);
            assert.deepEqual(links.map((link) => [link.range.start.line, path.basename(link.target?.fsPath ?? '')]), [[1, 'permissions.cfg']]);
        } finally {
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        }
    })],
    ['a server reply about an unknown resource is recognized, so a refresh can be offered', () => {
        assert.ok(unknownResource("^3Couldn't find resource garage.^7\n"));
        assert.ok(unknownResource('Couldnt find resource garage'));
        assert.ok(!unknownResource('Started resource garage'));
        return Promise.resolve();
    }],
];

/** The tools around the language server: palette and menus, the tool list, MCP setup, restored tabs, reports and server.cfg. */
export async function runEditorToolTests(): Promise<void> {
    const failures: string[] = [];
    for (const [name, body] of tests) {
        try {
            await body();
            console.log(`  ok   ${name}`);
        } catch (error) {
            failures.push(name);
            console.error(`  FAIL ${name}\n${error instanceof Error ? error.stack : String(error)}`);
        }
    }
    if (failures.length > 0) {
        throw new Error(`${failures.length} editor tool test(s) failed: ${failures.join(', ')}`);
    }
}
