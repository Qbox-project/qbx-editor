import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { hostError, passwordError, redactResponse, ResourceConnectionStore } from '../../src/resourceControls';

class MemoryMemento implements vscode.Memento {
    readonly values = new Map<string, unknown>();
    failNextUpdate = false;

    keys(): readonly string[] { return [...this.values.keys()]; }
    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    get<T>(key: string, defaultValue?: T): T | undefined {
        return this.values.has(key) ? this.values.get(key) as T : defaultValue;
    }
    async update(key: string, value: unknown): Promise<void> {
        if (this.failNextUpdate) {
            this.failNextUpdate = false;
            throw new Error('Simulated workspace-state failure');
        }
        if (value === undefined) { this.values.delete(key); }
        else { this.values.set(key, value); }
    }
}

class MemorySecrets implements vscode.SecretStorage {
    readonly values = new Map<string, string>();
    readonly deleted: string[] = [];
    readonly onDidChange: vscode.Event<vscode.SecretStorageChangeEvent> = () => new vscode.Disposable(() => {});
    failNextStore = false;

    async keys(): Promise<string[]> { return [...this.values.keys()]; }
    async get(key: string): Promise<string | undefined> { return this.values.get(key); }
    async store(key: string, value: string): Promise<void> {
        if (this.failNextStore) {
            this.failNextStore = false;
            throw new Error('Simulated secret-storage failure');
        }
        this.values.set(key, value);
    }
    async delete(key: string): Promise<void> {
        this.deleted.push(key);
        this.values.delete(key);
    }
}

function fixture(secrets = new MemorySecrets()): {
    store: ResourceConnectionStore;
    workspaceState: MemoryMemento;
    secrets: MemorySecrets;
} {
    const workspaceState = new MemoryMemento();
    return { store: new ResourceConnectionStore({ workspaceState, secrets }), workspaceState, secrets };
}

type Test = [name: string, body: () => void | Promise<void>];

const tests: Test[] = [
    ['resource connection passwords stay in secret storage and profiles survive reload', async () => {
        const { store, workspaceState, secrets } = fixture();
        assert.equal(store.get(), undefined);
        const password = 'only-in-secret-storage-$a\\b';
        const saved = await store.save('127.0.0.1', 30120, password);
        assert.deepEqual(Object.keys(saved).sort(), ['host', 'id', 'port']);
        assert.ok(saved.id.length > 0);
        assert.deepEqual(store.get(), saved);
        assert.equal(await store.password(saved), password);
        assert.equal(secrets.values.size, 1);
        assert.equal(JSON.stringify([...workspaceState.values]).includes(password), false);
        const reloaded = new ResourceConnectionStore({ workspaceState, secrets });
        assert.deepEqual(reloaded.get(), saved);
        assert.equal(await reloaded.password(saved), password);
    }],
    ['separate workspaces cannot inherit or overwrite a saved connection', async () => {
        const sharedSecrets = new MemorySecrets();
        const first = fixture(sharedSecrets);
        const second = fixture(sharedSecrets);
        const one = await first.store.save('dev.example.test', 30120, 'first-password');
        assert.equal(second.store.get(), undefined, 'global secret storage must not select another workspace profile');
        const two = await second.store.save('staging.example.test', 30121, 'second-password');
        assert.notEqual(one.id, two.id);
        assert.equal(sharedSecrets.values.size, 2);
        assert.deepEqual(first.store.get(), one);
        assert.deepEqual(second.store.get(), two);
        assert.equal(await first.store.password(one), 'first-password');
        assert.equal(await second.store.password(two), 'second-password');
        await second.store.forget();
        assert.equal(second.store.get(), undefined);
        assert.deepEqual(first.store.get(), one);
        assert.equal(await first.store.password(one), 'first-password');
    }],
    ['replacing a connection removes the old secret', async () => {
        const { store, secrets } = fixture();
        const old = await store.save('localhost', 30120, 'old-password');
        const oldKey = [...secrets.values.keys()][0];
        const next = await store.save('127.0.0.2', 30121, 'new-password');
        assert.notEqual(next.id, old.id);
        assert.deepEqual(store.get(), next);
        assert.equal(await store.password(old), undefined);
        assert.equal(await store.password(next), 'new-password');
        assert.ok(secrets.deleted.includes(oldKey));
        assert.equal(secrets.values.size, 1);
    }],
    ['failed profile writes roll back the new secret and preserve the old connection', async () => {
        const { store, workspaceState, secrets } = fixture();
        const old = await store.save('localhost', 30120, 'old-password');
        const before = [...secrets.values.entries()];
        workspaceState.failNextUpdate = true;
        await assert.rejects(store.save('127.0.0.2', 30121, 'new-password'), /workspace-state failure/);
        assert.deepEqual(store.get(), old);
        assert.equal(await store.password(old), 'old-password');
        assert.deepEqual([...secrets.values.entries()], before);
    }],
    ['failed first profile write leaves no orphan password', async () => {
        const { store, workspaceState, secrets } = fixture();
        workspaceState.failNextUpdate = true;
        await assert.rejects(store.save('localhost', 30120, 'first-password'), /workspace-state failure/);
        assert.equal(store.get(), undefined);
        assert.equal(workspaceState.values.size, 0);
        assert.equal(secrets.values.size, 0);
    }],
    ['failed secret writes do not replace a saved profile', async () => {
        const { store, secrets } = fixture();
        const old = await store.save('localhost', 30120, 'old-password');
        secrets.failNextStore = true;
        await assert.rejects(store.save('127.0.0.2', 30121, 'new-password'), /secret-storage failure/);
        assert.deepEqual(store.get(), old);
        assert.equal(await store.password(old), 'old-password');
        assert.equal(secrets.values.size, 1);
    }],
    ['forget removes both saved address and password and is idempotent', async () => {
        const { store, workspaceState, secrets } = fixture();
        const saved = await store.save('localhost', 30120, 'saved-password');
        await store.forget();
        assert.equal(store.get(), undefined);
        assert.equal(await store.password(saved), undefined);
        assert.equal(workspaceState.values.size, 0);
        assert.equal(secrets.values.size, 0);
        await store.forget();
        assert.equal(secrets.values.size, 0);
    }],
    ['invalid persisted profiles are ignored', async () => {
        const { store, workspaceState } = fixture();
        const valid = await store.save('localhost', 30120, 'saved-password');
        const [key] = workspaceState.keys();
        for (const value of [
            null, {}, { ...valid, id: 42 }, { ...valid, host: '' },
            { ...valid, host: 'http://localhost' }, { ...valid, port: '30120' },
            { ...valid, port: 0 }, { ...valid, port: 65536 }, { ...valid, port: 1.5 },
        ]) {
            await workspaceState.update(key, value);
            assert.equal(store.get(), undefined, JSON.stringify(value));
        }
    }],
    ['connection host validation accepts addresses but rejects URLs, ports and controls', () => {
        for (const host of ['localhost', 'dev.example.test', '127.0.0.1', '::1', '2001:db8::1', '[::1]']) {
            assert.equal(hostError(host), undefined, host);
        }
        for (const host of [
            '', ' localhost', 'local host', 'localhost:30120', 'https://localhost',
            'localhost/path', 'localhost\\path', 'user@localhost', 'localhost?query',
            'localhost#fragment', 'local\x00host', 'local\x1bhost', 'local\x7fhost',
            'invalid::address', '[localhost]', '[::1]:30120',
        ]) {
            assert.ok(hostError(host), JSON.stringify(host));
        }
    }],
    ['password validation rejects whitespace and every ASCII control', () => {
        for (const password of ['abc123', 'dollar$and!symbols', 'quote"and\\slash', 'pássword']) {
            assert.equal(passwordError(password), undefined, password);
        }
        for (const password of ['', 'two words', 'trailing ', '\t', '\n', '\r', 'non\u00a0breaking']) {
            assert.ok(passwordError(password), JSON.stringify(password));
        }
        for (const code of [...Array.from({ length: 32 }, (_, i) => i), 127]) {
            assert.ok(passwordError(`before${String.fromCharCode(code)}after`), `control ${code}`);
        }
    }],
    ['server response redaction handles repeated literal secrets and terminal controls', () => {
        const secret = 'p$[x]\\word';
        assert.equal(redactResponse(`echo ${secret}; again ${secret}`, secret), 'echo [redacted]; again [redacted]');
        assert.equal(redactResponse('\x1b[31mred\x1b[0m\x00\x07\x08\x1f\x7f\n\tend', 'secret'), 'red\n\tend');
        assert.equal(redactResponse('ordinary\r\nresponse', ''), 'ordinary\r\nresponse');
        assert.equal(redactResponse('sec\x1b[31mret', 'secret'), '[redacted]', 'sanitizing must not reconstruct an exposed secret');
        assert.equal(redactResponse('sec\x00ret', 'secret'), '[redacted]');
    }],
    ['resource commands are registered and Explorer menus target recognized folders only', async () => {
        const extension = vscode.extensions.getExtension('qbox.qbx-lua');
        assert.ok(extension);
        await extension.activate();
        const commands = await vscode.commands.getCommands(true);
        for (const suffix of ['start', 'stop', 'restart', 'openManifest', 'configureConnection', 'testConnection', 'forgetConnection']) {
            assert.ok(commands.includes(`qbxLua.resources.${suffix}`), suffix);
        }
        const manifest = extension.packageJSON as {
            contributes: { menus: Record<string, { command?: string; submenu?: string; when?: string }[]> };
        };
        const menus = manifest.contributes.menus['explorer/context'];
        assert.ok(Array.isArray(menus));
        const resourceMenu = menus.find((item) => item.submenu === 'qbxLua.resources');
        assert.ok(resourceMenu, 'FiveM resource actions should be grouped in an Explorer submenu');
        assert.ok(resourceMenu.when?.includes('resourceScheme == file'));
        assert.ok(resourceMenu.when?.includes('explorerResourceIsFolder'));
        assert.ok(resourceMenu.when?.includes('resourcePath in qbxLua.resourceFolders'));
        assert.ok(!resourceMenu.when?.includes('||'), 'unrelated folders must not bypass the resource match');
        const actions = manifest.contributes.menus['qbxLua.resources'];
        assert.ok(Array.isArray(actions));
        for (const suffix of ['start', 'stop', 'restart', 'openManifest']) {
            const menu = actions.find((item) => item.command === `qbxLua.resources.${suffix}`);
            assert.ok(menu, `${suffix} should appear in the resource submenu`);
            if (suffix !== 'openManifest') {
                assert.ok(menu.when?.includes('isWorkspaceTrusted'), `${suffix} requires workspace trust`);
            }
        }
    }],
    ['Open Manifest opens the selected resource manifest without connection setup', async () => {
        const workspace = vscode.workspace.workspaceFolders?.[0];
        assert.ok(workspace, 'the fixture workspace should be open');
        const resource = vscode.Uri.joinPath(workspace.uri, 'myresource');
        const manifest = vscode.Uri.joinPath(resource, 'fxmanifest.lua');
        await vscode.commands.executeCommand('qbxLua.resources.openManifest', resource);
        assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), manifest.toString());
    }],
];

/** Pure/fake-storage tests; no resource commands or network connections are executed. */
export async function runResourceControlTests(): Promise<void> {
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
        throw new Error(`${failures.length} resource control test(s) failed: ${failures.join(', ')}`);
    }
}
