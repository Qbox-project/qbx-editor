import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import * as vscode from 'vscode';
import { Resource, ResourceIndex } from './resources';
import { resourceCommand, RconError, sendRconCommand, validateRconPassword } from './rcon';

const CONNECTION_KEY = 'qbxLua.resources.connection';
const SECRET_PREFIX = 'qbxLua.resources.password.';

export interface ResourceConnection {
    id: string;
    host: string;
    port: number;
}

type Storage = Pick<vscode.ExtensionContext, 'workspaceState' | 'secrets'>;

/** Addresses belong to this workspace; passwords never enter settings or workspace files. */
export class ResourceConnectionStore {
    constructor(private readonly storage: Storage) {}

    get(): ResourceConnection | undefined {
        const value = this.storage.workspaceState.get<ResourceConnection>(CONNECTION_KEY);
        if (!value || typeof value.id !== 'string' || typeof value.host !== 'string'
            || hostError(value.host) || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
            return undefined;
        }
        return value;
    }

    password(connection: ResourceConnection): Thenable<string | undefined> {
        return this.storage.secrets.get(SECRET_PREFIX + connection.id);
    }

    async save(host: string, port: number, password: string): Promise<ResourceConnection> {
        const previous = this.get();
        const next = { id: randomUUID(), host, port };
        await this.storage.secrets.store(SECRET_PREFIX + next.id, password);
        try {
            await this.storage.workspaceState.update(CONNECTION_KEY, next);
        } catch (error) {
            await this.storage.secrets.delete(SECRET_PREFIX + next.id);
            throw error;
        }
        if (previous) {
            await this.storage.secrets.delete(SECRET_PREFIX + previous.id);
        }
        return next;
    }

    async forget(): Promise<void> {
        const previous = this.get();
        if (previous) {
            await this.storage.secrets.delete(SECRET_PREFIX + previous.id);
        }
        await this.storage.workspaceState.update(CONNECTION_KEY, undefined);
    }
}

export function hostError(value: string): string | undefined {
    const address = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
    if (!value || (address !== value && isIP(address) !== 6)
        || (!isIP(address) && !/^[a-zA-Z0-9_.-]+$/.test(value))) {
        return 'Enter a hostname or IP address, without a URL, port or spaces.';
    }
    return undefined;
}

export function passwordError(value: string): string | undefined {
    return validateRconPassword(value);
}

function endpoint(connection: ResourceConnection): string {
    return `${connection.host.includes(':') ? `[${connection.host}]` : connection.host}:${connection.port}`;
}

/** Also redact server output: a custom command handler could echo sensitive input. */
export function redactResponse(text: string, password: string): string {
    const redacted = password ? text.split(password).join('[redacted]') : text;
    const clean = redacted.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    return password ? clean.split(password).join('[redacted]') : clean;
}

export class ResourceControls implements vscode.Disposable {
    private readonly index: ResourceIndex;
    private readonly store: ResourceConnectionStore;
    private readonly output = vscode.window.createOutputChannel('Qbox Lua Resources');
    private readonly subscriptions: vscode.Disposable[] = [];
    private operation: AbortController | undefined;
    private busy = false;
    private disposed = false;

    get resourceIndex(): ResourceIndex { return this.index; }

    constructor(context: vscode.ExtensionContext) {
        this.store = new ResourceConnectionStore(context);
        this.index = new ResourceIndex();
        this.subscriptions.push(this.index, this.output, this.index.onDidChange(() => this.updateContext()));
        for (const action of ['start', 'stop', 'restart'] as const) {
            this.subscriptions.push(vscode.commands.registerCommand(`qbxLua.resources.${action}`,
                (uri?: vscode.Uri) => this.exclusive(() => this.runResource(action, uri))));
        }
        this.subscriptions.push(
            vscode.commands.registerCommand('qbxLua.resources.openManifest', (uri?: vscode.Uri) => this.openManifest(uri)),
            vscode.commands.registerCommand('qbxLua.resources.configureConnection', () => this.exclusive(() => this.configure())),
            vscode.commands.registerCommand('qbxLua.resources.testConnection', () => this.exclusive(() => this.testConnection())),
            vscode.commands.registerCommand('qbxLua.resources.forgetConnection', () => this.exclusive(async () => {
                await this.store.forget();
                void vscode.window.showInformationMessage('Qbox Lua: the saved resource connection and password were removed.');
            })),
        );
        void this.index.ready.then(() => this.updateContext()).catch((error: unknown) => {
            this.output.appendLine(`Resource discovery failed: ${String(error)}`);
        });
    }

    private updateContext(): void {
        if (!this.disposed) {
            void vscode.commands.executeCommand('setContext', 'qbxLua.resourceFolders', this.index.entries.map((r) => r.folder.fsPath));
        }
    }

    private async exclusive(task: () => Promise<unknown>): Promise<void> {
        if (!vscode.workspace.isTrusted) {
            void vscode.window.showWarningMessage('Trust this workspace before controlling FiveM resources.');
            return;
        }
        if (this.busy || this.disposed) {
            if (!this.disposed) {
                void vscode.window.showInformationMessage('A FiveM resource action is already in progress.');
            }
            return;
        }
        this.busy = true;
        try {
            await task();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // Transport errors contain no packet contents or password.
            if (!this.disposed) { this.output.appendLine(message); }
            if (!this.disposed && !(error instanceof RconError && error.code === 'cancelled')) {
                this.output.show(true);
                void vscode.window.showErrorMessage(`Qbox Lua Resources: ${message}`);
            }
        } finally {
            this.busy = false;
        }
    }

    private async configure(): Promise<ResourceConnection | undefined> {
        const previous = this.store.get();
        const host = await vscode.window.showInputBox({
            title: 'FiveM resource connection (1/3)', prompt: 'RCON hostname or IP address',
            value: previous?.host ?? '127.0.0.1', ignoreFocusOut: true, validateInput: hostError,
        });
        if (host === undefined || this.disposed) { return undefined; }
        const portText = await vscode.window.showInputBox({
            title: 'FiveM resource connection (2/3)', prompt: 'RCON UDP port',
            value: String(previous?.port ?? 30120), ignoreFocusOut: true,
            validateInput: (value) => /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535
                ? undefined : 'Enter a port between 1 and 65535.',
        });
        if (portText === undefined || this.disposed) { return undefined; }
        const password = await vscode.window.showInputBox({
            title: 'FiveM resource connection (3/3)',
            prompt: 'RCON password from your server configuration. Stored in VS Code secret storage.',
            password: true, ignoreFocusOut: true, validateInput: passwordError,
        });
        if (password === undefined || this.disposed) { return undefined; }
        const address = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
        const saved = await this.store.save(address, Number(portText), password);
        void vscode.window.showInformationMessage(`FiveM resource connection saved for this workspace: ${endpoint(saved)}.`);
        return saved;
    }

    private async connection(): Promise<{ profile: ResourceConnection; password: string } | undefined> {
        let profile = this.store.get();
        if (!profile) { profile = await this.configure(); }
        if (!profile || this.disposed) { return undefined; }
        let password = await this.store.password(profile);
        if (!password) {
            profile = await this.configure();
            if (!profile || this.disposed) { return undefined; }
            password = await this.store.password(profile);
        }
        return password ? { profile, password } : undefined;
    }

    private async selectResource(uri?: vscode.Uri): Promise<Resource | undefined> {
        await this.index.ready;
        if (uri) {
            const resource = await this.index.resolve(uri);
            if (!resource) {
                void vscode.window.showWarningMessage('Select a resource folder containing fxmanifest.lua or __resource.lua, or its manifest.');
            }
            return resource;
        }
        const choices = this.index.entries.map((resource) => ({
            label: resource.name, description: vscode.workspace.asRelativePath(resource.folder, true), resource,
        }));
        if (choices.length === 0) {
            void vscode.window.showInformationMessage('No FiveM resources were found in this workspace.');
            return undefined;
        }
        const picked = await vscode.window.showQuickPick(choices, {
            title: 'FiveM resource', placeHolder: 'Choose a resource', matchOnDescription: true,
        });
        return picked ? this.index.resolve(picked.resource.folder) : undefined;
    }

    private async openManifest(uri?: vscode.Uri): Promise<void> {
        try {
            const resource = await this.selectResource(uri);
            if (resource && !this.disposed) {
                await vscode.window.showTextDocument(resource.manifest);
            }
        } catch (error) {
            void vscode.window.showErrorMessage(`Could not open the resource manifest: ${String(error)}`);
        }
    }

    private async runResource(action: 'start' | 'stop' | 'restart', uri?: vscode.Uri): Promise<void> {
        const resource = await this.selectResource(uri);
        if (!resource || this.disposed) { return; }
        const command = resourceCommand(action, resource.name);
        if (this.index.entries.filter((entry) => entry.name.toLowerCase() === resource.name.toLowerCase()).length > 1) {
            throw new Error(`Multiple workspace resources are named ${resource.name}. RCON addresses resources by name; resolve the duplicate before running this action.`);
        }
        const connection = await this.connection();
        if (!connection || this.disposed) { return; }
        // Prompts may stay open while resources are created, removed or renamed.
        await this.index.refresh();
        if (!await this.index.resolve(resource.folder)) {
            throw new Error('The selected resource no longer exists.');
        }
        if (this.index.entries.filter((entry) => entry.name.toLowerCase() === resource.name.toLowerCase()).length > 1) {
            throw new Error(`Multiple workspace resources are named ${resource.name}. RCON addresses resources by name; resolve the duplicate before running this action.`);
        }
        await this.send(connection, command);
    }

    private async testConnection(): Promise<void> {
        const connection = await this.connection();
        if (!connection || this.disposed) { return; }
        const marker = `qbx-rcon-${randomUUID()}`;
        const response = await this.send(connection, `echo ${marker}`);
        if (response.includes(marker)) {
            void vscode.window.showInformationMessage(`FiveM RCON responded at ${endpoint(connection.profile)}.`);
        } else {
            throw new Error('The server replied without the connection-test marker. Check the server response in Qbox Lua Resources.');
        }
    }

    private async send(connection: { profile: ResourceConnection; password: string }, command: string): Promise<string> {
        if (!vscode.workspace.isTrusted || this.disposed) {
            throw new Error('Resource control is unavailable in this workspace.');
        }
        const abort = new AbortController();
        this.operation = abort;
        this.output.show(true);
        this.output.appendLine(redactResponse(`[${new Date().toLocaleTimeString()}] ${endpoint(connection.profile)} > ${command}`, connection.password));
        try {
            return await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `FiveM: ${command.startsWith('echo ') ? 'Test resource connection' : command}`,
                cancellable: true,
            }, async (_progress, token) => {
                const cancellation = token.onCancellationRequested(() => abort.abort());
                try {
                    if (token.isCancellationRequested) { abort.abort(); }
                    const response = await sendRconCommand({ ...connection.profile, password: connection.password, command, signal: abort.signal });
                    if (!this.disposed) {
                        this.output.appendLine(redactResponse(response, connection.password) || '(Server acknowledged the command without output.)');
                        this.output.appendLine('');
                    }
                    return response;
                } finally {
                    cancellation.dispose();
                }
            });
        } catch (error) {
            if (error instanceof RconError && error.code === 'cancelled' && !this.disposed) {
                this.output.appendLine('Stopped waiting. A command already sent may still execute on the server.');
            }
            throw error;
        } finally {
            this.operation = undefined;
        }
    }

    dispose(): void {
        this.disposed = true;
        this.operation?.abort();
        for (const disposable of this.subscriptions) { disposable.dispose(); }
        void vscode.commands.executeCommand('setContext', 'qbxLua.resourceFolders', []);
    }
}
