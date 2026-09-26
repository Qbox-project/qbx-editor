import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { createResourcePlan, renderResourcePreview, RESOURCE_TEMPLATES, resourceNameError, type ResourcePlan, type ResourceTemplateId } from '../../src/resourceTemplates';
import { runResourceWizardFlow, type ResourceWizardOperations, type ResourceWizardUi, type WizardDecision } from '../../src/resourceWizardFlow';
import { ResourceScaffolder, type ResourceDestination, type ScaffoldFileSystem } from '../../src/resourceScaffold';

type Test = [name: string, body: () => void | Promise<void>];

async function withTemporaryRoot(body: (root: vscode.Uri) => Promise<void>): Promise<void> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qbx-wizard-tests-'));
    try { await body(vscode.Uri.file(root)); }
    finally {
        assert.ok(path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
        assert.ok(path.basename(root).startsWith('qbx-wizard-tests-'));
        await fs.rm(root, { recursive: true, force: true });
    }
}

function wizardHarness() {
    const parent = vscode.Uri.file(path.join(os.tmpdir(), 'qbx-wizard-flow-parent'));
    const parents: Array<vscode.Uri | undefined> = [parent];
    const names: Array<string | undefined> = ['example'];
    const templates: Array<ResourceTemplateId | undefined> = ['lua'];
    const decisions: Array<WizardDecision | undefined> = ['create'];
    const recovery: Array<'folder' | 'name' | undefined> = [];
    const calls: string[] = [];
    const previews: { plan: ResourcePlan; destination: ResourceDestination }[] = [];
    const creations: { plan: ResourcePlan; destination: ResourceDestination }[] = [];
    const completed: ResourcePlan[] = [];
    const problems: string[] = [];
    const ui: ResourceWizardUi = {
        chooseParent: async () => { calls.push('folder'); return parents.shift(); },
        chooseName: async () => { calls.push('name'); return names.shift(); },
        chooseTemplate: async () => { calls.push('template'); return templates.shift(); },
        preview: async (plan, destination) => { calls.push('preview'); previews.push({ plan, destination }); return decisions.shift(); },
        problem: async (message) => { calls.push('problem'); problems.push(message); return recovery.shift(); },
        completed: async (_result, plan) => { calls.push('completed'); completed.push(plan); },
    };
    const operations: ResourceWizardOperations = {
        validate: async (chosen, name) => ({ parent: chosen, folder: vscode.Uri.joinPath(chosen, name) }),
        create: async (_chosen, plan, options) => {
            creations.push({ plan, destination: options.destination });
            return { folder: options.destination.folder, manifest: vscode.Uri.joinPath(options.destination.folder, 'fxmanifest.lua') };
        },
    };
    return { parent, parents, names, templates, decisions, recovery, calls, previews, creations, completed, problems, ui, operations };
}

const tests: Test[] = [
    ['resource names reject paths, bracket groups and portable filesystem hazards', () => {
        for (const name of ['my_resource', 'qbx-garage', 'Resource42', '_private', 'a'.repeat(64)]) {
            assert.equal(resourceNameError(name), undefined, name);
        }
        for (const name of ['', ' ', '.', '..', '../escape', '..\\escape', '/absolute', 'C:\\resource',
            '[local]', '[my-resource]', 'my resource', 'resource.lua', 'trailing.', 'trailing ', 'quote\'name',
            'new\nline', 'tab\tname', 'name\0null', 'résource', '🎮', 'a'.repeat(65),
            'CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'lpt9', 'CONIN$', 'CONOUT$']) {
            assert.ok(resourceNameError(name), `${JSON.stringify(name)} must be rejected`);
            assert.throws(() => createResourcePlan({ name, templateId: 'lua' }));
        }
        assert.throws(() => createResourcePlan({ name: 'safe', templateId: 'unrecognized' as never }));
    }],
    ['resource templates declare exactly the generated Lua files and order framework imports before configuration', () => {
        assert.deepEqual(RESOURCE_TEMPLATES.map((template) => template.id).sort(), ['lua', 'ox_lib', 'qbox']);
        for (const template of RESOURCE_TEMPLATES) {
            const plan = createResourcePlan({ name: 'My_resource', templateId: template.id });
            assert.equal(plan.name, 'My_resource');
            assert.deepEqual(plan.files.map((file) => file.path).sort(), ['client/main.lua', 'fxmanifest.lua', 'server/main.lua', 'shared/config.lua']);
            assert.equal(new Set(plan.files.map((file) => file.path)).size, plan.files.length);
            const manifest = plan.files.find((file) => file.path === 'fxmanifest.lua')!.content;
            assert.match(manifest, /fx_version\s+['"]cerulean['"]/);
            assert.match(manifest, /game\s+['"]gta5['"]/);
            assert.doesNotMatch(manifest, /\blua54\b|use_experimental_fxv2_oal|qb-core|oxmysql|playerdata/);
            for (const file of plan.files.filter((file) => file.path !== 'fxmanifest.lua')) {
                assert.ok(manifest.includes(file.path), `${template.id} must load ${file.path}`);
            }
            for (const file of plan.files) {
                assert.ok(file.content.endsWith('\n'), `${file.path} should end with a newline`);
                assert.ok(!file.content.includes('\r'), 'templates use consistent LF line endings');
                assert.ok(!file.path.startsWith('/') && !file.path.split('/').includes('..'));
            }
            if (template.id === 'lua') {
                assert.deepEqual(plan.dependencies, []);
                assert.doesNotMatch(manifest, /@ox_lib|@qbx_core|\bdependencies\b/);
            } else {
                const ox = manifest.indexOf('@ox_lib/init.lua');
                const config = manifest.indexOf('shared/config.lua');
                assert.ok(ox >= 0 && ox < config, 'ox_lib must initialize before local shared configuration');
                if (template.id === 'qbox') {
                    assert.deepEqual(plan.dependencies, ['ox_lib', 'qbx_core']);
                    const qbox = manifest.indexOf('@qbx_core/modules/lib.lua');
                    assert.ok(ox < qbox && qbox < config, 'Qbox helpers load after ox_lib and before configuration');
                } else {
                    assert.deepEqual(plan.dependencies, ['ox_lib']);
                    assert.ok(!manifest.includes('@qbx_core'));
                }
            }
        }
    }],
    ['resource previews contain exact file contents and keep hostile destination text inert', async () => {
        const { marked } = await import('marked');
        const plan = createResourcePlan({ name: 'example', templateId: 'qbox' });
        const destination = '/tmp/```\n[run](command:evil)\n<script>evil</script>\n```/example';
        const markdown = renderResourcePreview(plan, destination);
        const tokens = marked.lexer(markdown);
        const code = tokens.filter((token) => token.type === 'code') as Array<{ text: string; lang?: string }>;
        assert.ok(code.some((token) => token.text === destination));
        for (const file of plan.files) {
            assert.ok(code.some((token) => token.lang === 'lua' && `${token.text}\n` === file.content), file.path);
        }
        const active: string[] = [];
        marked.walkTokens(tokens, (token) => { if (token.type === 'link' || token.type === 'html') { active.push(token.type); } });
        assert.deepEqual(active, [], 'destination text must not turn into active Markdown links or HTML');
    }],
    ['scaffolding creates exact reviewed files inside a group and publishes the manifest last', async () => withTemporaryRoot(async (root) => {
        const parent = vscode.Uri.joinPath(root, '[local]');
        await fs.mkdir(parent.fsPath);
        const writes: string[] = [];
        const io: ScaffoldFileSystem = { ...fs, open: async (file, flags, mode) => {
            if (flags === 'wx+') { writes.push(String(file)); }
            return fs.open(file, flags, mode);
        } };
        const scaffolder = new ResourceScaffolder(io);
        const plan = createResourcePlan({ name: 'example', templateId: 'qbox' });
        const destination = await scaffolder.validateResourceDestination(parent, plan.name);
        const created = await scaffolder.createResourceScaffold(parent, plan, { destination });
        assert.equal(created.folder.toString(), vscode.Uri.joinPath(parent, plan.name).toString());
        assert.equal(created.manifest.toString(), vscode.Uri.joinPath(created.folder, 'fxmanifest.lua').toString());
        for (const file of plan.files) {
            assert.equal(await fs.readFile(path.join(created.folder.fsPath, file.path), 'utf8'), file.content, file.path);
        }
        assert.equal(writes.length, plan.files.length);
        assert.equal(path.basename(writes.at(-1)!), 'fxmanifest.lua', 'resource discovery sees the manifest only after all entries exist');
    })],
    ['existing empty directories, files and directory links are never reused or overwritten', async () => withTemporaryRoot(async (root) => {
        const scaffolder = new ResourceScaffolder();
        await fs.mkdir(path.join(root.fsPath, 'empty'));
        await fs.writeFile(path.join(root.fsPath, 'file'), 'existing file');
        const linkedTarget = path.join(root.fsPath, 'linked-target');
        await fs.mkdir(linkedTarget);
        await fs.writeFile(path.join(linkedTarget, 'keep.txt'), 'linked content');
        await fs.symlink(linkedTarget, path.join(root.fsPath, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
        for (const name of ['empty', 'file', 'linked']) {
            await assert.rejects(scaffolder.validateResourceDestination(root, name), /exists/);
            await assert.rejects(scaffolder.createResourceScaffold(root, createResourcePlan({ name, templateId: 'lua' })), /exists/);
        }
        assert.deepEqual(await fs.readdir(path.join(root.fsPath, 'empty')), []);
        assert.equal(await fs.readFile(path.join(root.fsPath, 'file'), 'utf8'), 'existing file');
        assert.equal(await fs.readFile(path.join(linkedTarget, 'keep.txt'), 'utf8'), 'linked content');
        assert.ok((await fs.lstat(path.join(root.fsPath, 'linked'))).isSymbolicLink());
    })],
    ['resource destinations reject missing or remote parents and nesting inside modern or legacy resources', async () => withTemporaryRoot(async (root) => {
        const scaffolder = new ResourceScaffolder();
        await assert.rejects(scaffolder.validateResourceDestination(vscode.Uri.parse('https://example.test/resources'), 'child'));
        await assert.rejects(scaffolder.validateResourceDestination(vscode.Uri.joinPath(root, 'missing'), 'child'));
        await assert.rejects(scaffolder.validateResourceDestination(root.with({ fragment: 'suffix' }), 'child'));
        for (const [index, manifest] of ['fxmanifest.lua', '__resource.lua'].entries()) {
            const existing = vscode.Uri.joinPath(root, `existing${index}`);
            const nested = vscode.Uri.joinPath(existing, 'sub', '[group]');
            await fs.mkdir(nested.fsPath, { recursive: true });
            await fs.writeFile(vscode.Uri.joinPath(existing, manifest).fsPath, '-- existing resource\n');
            await assert.rejects(scaffolder.validateResourceDestination(existing, 'child'), /existing resource/);
            await assert.rejects(scaffolder.validateResourceDestination(nested, 'child'), /existing resource/);
            assert.deepEqual(await fs.readdir(nested.fsPath), []);
        }
    })],
    ['preview tokens and generated plans cannot be forged or changed before creation', async () => withTemporaryRoot(async (root) => {
        const scaffolder = new ResourceScaffolder();
        const plan = createResourcePlan({ name: 'example', templateId: 'lua' });
        const destination = await scaffolder.validateResourceDestination(root, plan.name);
        const changed = { ...plan, files: plan.files.map((file, index) => index === 0 ? { ...file, path: '../escape.lua' } : file) };
        await assert.rejects(scaffolder.createResourceScaffold(root, changed, { destination }), /preview/);
        const forged = { parent: root, folder: vscode.Uri.joinPath(root, plan.name) };
        await assert.rejects(scaffolder.createResourceScaffold(root, plan, { destination: forged }), /preview/);
        const differentInstance = new ResourceScaffolder();
        await assert.rejects(differentInstance.createResourceScaffold(root, plan, { destination }), /preview/);
        assert.deepEqual(await fs.readdir(root.fsPath), []);
    })],
    ['a destination appearing after preview or immediately before mkdir is never merged', async () => withTemporaryRoot(async (root) => {
        const plan = createResourcePlan({ name: 'example', templateId: 'lua' });
        const scaffolder = new ResourceScaffolder();
        const destination = await scaffolder.validateResourceDestination(root, plan.name);
        await fs.mkdir(destination.folder.fsPath);
        await fs.writeFile(path.join(destination.folder.fsPath, 'keep.txt'), 'created by another actor');
        await assert.rejects(scaffolder.createResourceScaffold(root, plan, { destination }), /exists/);
        assert.deepEqual(await fs.readdir(destination.folder.fsPath), ['keep.txt']);

        const racingPlan = createResourcePlan({ name: 'racing', templateId: 'lua' });
        const racingPath = path.join(await fs.realpath(root.fsPath), racingPlan.name);
        let injected = false;
        const io: ScaffoldFileSystem = { ...fs, mkdir: (async (directory, options) => {
            if (String(directory) === racingPath) {
                injected = true;
                await fs.mkdir(directory);
                await fs.writeFile(path.join(racingPath, 'keep.txt'), 'race winner');
            }
            return fs.mkdir(directory, options);
        }) as typeof fs.mkdir };
        const racing = new ResourceScaffolder(io);
        await assert.rejects(racing.createResourceScaffold(root, racingPlan), /exists/);
        assert.equal(injected, true, 'the collision must occur inside mkdir after validation has finished');
        assert.deepEqual(await fs.readdir(racingPath), ['keep.txt']);
        assert.equal(await fs.readFile(path.join(racingPath, 'keep.txt'), 'utf8'), 'race winner');
    })],
    ['cancellation before and during file creation leaves no partial resource', async () => withTemporaryRoot(async (root) => {
        const plan = createResourcePlan({ name: 'example', templateId: 'lua' });
        const cancelled = new AbortController();
        cancelled.abort();
        await assert.rejects(new ResourceScaffolder().createResourceScaffold(root, plan, { signal: cancelled.signal }), { name: 'AbortError' });
        assert.deepEqual(await fs.readdir(root.fsPath), []);
        const during = new AbortController();
        const io: ScaffoldFileSystem = { ...fs, open: async (file, flags, mode) => {
            const handle = await fs.open(file, flags, mode);
            if (flags === 'wx+') { during.abort(); }
            return handle;
        } };
        await assert.rejects(new ResourceScaffolder(io).createResourceScaffold(root, plan, { signal: during.signal }), { name: 'AbortError' });
        assert.deepEqual(await fs.readdir(root.fsPath), [], 'opened but unwritten generated files must be rolled back');
    })],
    ['write failures remove unchanged generated artifacts but preserve concurrent user content', async () => withTemporaryRoot(async (root) => {
        const plan = createResourcePlan({ name: 'example', templateId: 'lua' });
        let writes = 0;
        const failEarly: ScaffoldFileSystem = { ...fs, open: async (file, flags, mode) => {
            if (flags === 'wx+' && ++writes === 2) { throw new Error('Simulated create failure'); }
            return fs.open(file, flags, mode);
        } };
        await assert.rejects(new ResourceScaffolder(failEarly).createResourceScaffold(root, plan), /Simulated create failure/);
        assert.deepEqual(await fs.readdir(root.fsPath), []);

        const generated: string[] = [];
        const folder = path.join(root.fsPath, plan.name);
        const preserve: ScaffoldFileSystem = { ...fs, open: async (file, flags, mode) => {
            if (flags === 'wx+') {
                if (generated.length === 2) {
                    await fs.writeFile(generated[0], 'User replaced this generated content.');
                    await fs.writeFile(path.join(folder, 'keep.txt'), 'User added this file.');
                    throw new Error('Simulated later failure');
                }
                generated.push(String(file));
            }
            return fs.open(file, flags, mode);
        } };
        await assert.rejects(new ResourceScaffolder(preserve).createResourceScaffold(root, plan), /preserved/);
        assert.equal(await fs.readFile(generated[0], 'utf8'), 'User replaced this generated content.');
        assert.equal(await fs.readFile(path.join(folder, 'keep.txt'), 'utf8'), 'User added this file.');
        await assert.rejects(fs.stat(generated[1]), { code: 'ENOENT' });
        await assert.rejects(fs.stat(path.join(folder, 'fxmanifest.lua')), { code: 'ENOENT' });
    })],
    ['cancelling any wizard prompt or its abort signal never reaches filesystem creation', async () => {
        for (const phase of ['folder', 'name', 'template', 'preview'] as const) {
            const h = wizardHarness();
            if (phase === 'folder') { h.parents[0] = undefined; }
            if (phase === 'name') { h.names[0] = undefined; }
            if (phase === 'template') { h.templates[0] = undefined; }
            if (phase === 'preview') { h.decisions[0] = undefined; }
            assert.equal(await runResourceWizardFlow(h.ui, {}, h.operations), undefined, phase);
            assert.deepEqual(h.creations, [], phase);
            assert.deepEqual(h.completed, [], phase);
        }
        const h = wizardHarness();
        const cancelled = new AbortController();
        cancelled.abort();
        await runResourceWizardFlow(h.ui, { signal: cancelled.signal }, h.operations);
        assert.deepEqual(h.calls, []);
        const duringPrompt = new AbortController();
        const prompted = wizardHarness();
        prompted.ui.chooseName = async () => { duringPrompt.abort(); return 'example'; };
        await runResourceWizardFlow(prompted.ui, { initialParent: prompted.parent, signal: duringPrompt.signal }, prompted.operations);
        assert.deepEqual(prompted.creations, []);
        assert.ok(!prompted.calls.includes('template'));
    }],
    ['wizard edits rebuild the preview and creation receives the exact final reviewed plan and destination', async () => {
        const h = wizardHarness();
        const other = vscode.Uri.file(path.join(os.tmpdir(), 'qbx-wizard-flow-other'));
        h.parents.push(other);
        h.names.splice(0, 1, 'first', 'second');
        h.templates.push('qbox');
        h.decisions.splice(0, 1, 'name', 'template', 'folder', 'create');
        const result = await runResourceWizardFlow(h.ui, {}, h.operations);
        assert.deepEqual(h.previews.map(({ plan, destination }) => [plan.name, plan.templateId, destination.parent.toString()]), [
            ['first', 'lua', h.parent.toString()], ['second', 'lua', h.parent.toString()],
            ['second', 'qbox', h.parent.toString()], ['second', 'qbox', other.toString()],
        ]);
        assert.equal(h.creations.length, 1);
        assert.equal(h.creations[0].plan, h.previews[3].plan, 'create must use the reviewed plan object');
        assert.equal(h.creations[0].destination, h.previews[3].destination, 'create must use the matching validated destination');
        assert.equal(result?.folder.toString(), vscode.Uri.joinPath(other, 'second').toString());
        assert.deepEqual(h.completed, [h.previews[3].plan]);
    }],
    ['failed validation and creation require another reviewed choice before retrying', async () => {
        const invalid = wizardHarness();
        invalid.names.splice(0, 1, '../unsafe', 'fixed');
        invalid.recovery.push('name');
        await runResourceWizardFlow(invalid.ui, {}, invalid.operations);
        assert.equal(invalid.problems.length, 1);
        assert.deepEqual(invalid.previews.map(({ plan }) => plan.name), ['fixed']);
        assert.equal(invalid.creations.length, 1);

        const h = wizardHarness();
        h.parents.push(vscode.Uri.file(path.join(os.tmpdir(), 'qbx-wizard-retry')));
        h.decisions.push('create');
        h.recovery.push('folder');
        const create = h.operations.create;
        let attempts = 0;
        h.operations.create = async (...args) => {
            attempts += 1;
            if (attempts === 1) { throw new Error('Destination appeared during preview'); }
            return create(...args);
        };
        await runResourceWizardFlow(h.ui, {}, h.operations);
        assert.equal(attempts, 2);
        assert.equal(h.previews.length, 2, 'a failed commit must not silently retry creation');
        assert.equal(h.problems.length, 1);
        assert.equal(h.completed.length, 1);
    }],
    ['a successful creation is never repeated when revealing the new manifest fails', async () => {
        const h = wizardHarness();
        h.ui.completed = async () => { throw new Error('Editor unavailable'); };
        await assert.rejects(runResourceWizardFlow(h.ui, {}, h.operations), /Resource created.*editor could not open.*Editor unavailable/);
        assert.equal(h.creations.length, 1);
        assert.deepEqual(h.problems, [], 'a reveal error must not loop back into creating files');
    }],
    ['cancellation after a successful commit returns its result without reopening UI', async () => {
        const h = wizardHarness();
        const controller = new AbortController();
        const create = h.operations.create;
        h.operations.create = async (...args) => {
            const result = await create(...args);
            controller.abort();
            return result;
        };
        const result = await runResourceWizardFlow(h.ui, { signal: controller.signal }, h.operations);
        assert.ok(result);
        assert.equal(h.creations.length, 1);
        assert.deepEqual(h.completed, []);
        assert.deepEqual(h.problems, []);
    }],
    ['resource creation is available for local Explorer folders and its lazy command loads without prompting on invalid input', async () => {
        const extension = vscode.extensions.getExtension('qbox.qbx-lua');
        assert.ok(extension);
        await extension.activate();
        const manifest = extension.packageJSON as {
            contributes: {
                commands: Array<{ command: string; category?: string; title: string }>;
                menus: Record<string, Array<{ command?: string; when?: string }>>;
            };
        };
        const command = 'qbxLua.resources.create';
        assert.ok((await vscode.commands.getCommands(true)).includes(command));
        const contributed = manifest.contributes.commands.find((entry) => entry.command === command);
        assert.equal(contributed?.category, 'FiveM');
        const menu = manifest.contributes.menus['explorer/context'].find((entry) => entry.command === command);
        assert.ok(menu?.when?.includes('resourceScheme == file'));
        assert.ok(menu?.when?.includes('explorerResourceIsFolder'));
        assert.ok(!menu?.when?.includes('qbxLua.resourceFolders'), 'new resources must be creatable in ordinary group folders');
        assert.ok((await fs.stat(vscode.Uri.joinPath(extension.extensionUri, 'dist', 'resourceWizard.js').fsPath)).isFile());
        assert.equal(await vscode.commands.executeCommand(command, 42), undefined, 'invalid arguments should load the lazy chunk and return without opening a wizard');
    }],
];

/** Resource creation tests are confined to temporary directories and injected wizard actions. */
export async function runResourceWizardTests(): Promise<void> {
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
        throw new Error(`${failures.length} resource wizard test(s) failed: ${failures.join(', ')}`);
    }
}
