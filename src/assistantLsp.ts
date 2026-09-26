import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isRecord, aborted } from './assistantTools';

interface Pending {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    cleanup: () => void;
}

/** Private MCP child transport. Public callers never choose an LSP method or executable. */
export class AssistantLsp {
    private child: ChildProcessWithoutNullStreams | undefined;
    private ready: Promise<void> | undefined;
    private readonly pending = new Map<number, Pending>();
    private nextId = 0;
    private buffer = Buffer.alloc(0);
    private contentLength: number | undefined;
    private disposed = false;
    private failed: Error | undefined;

    constructor(private readonly binary: string, private readonly roots: readonly string[]) {}

    async request(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
        aborted(signal);
        this.ready ??= this.start();
        await this.ready;
        aborted(signal);
        return this.sendRequest(method, params, signal);
    }

    private async start(): Promise<void> {
        if (this.disposed) { throw new Error('The assistant language server is closed.'); }
        this.child = spawn(this.binary, [], { windowsHide: true, stdio: 'pipe', shell: false, cwd: this.roots[0] });
        this.child.on('error', () => this.fail(new Error('Could not start the bundled Qbox Lua language server. Install the extension build for this platform.')));
        this.child.on('exit', () => this.fail(new Error('The assistant language server exited. Restart this MCP connection.')));
        this.child.stdin.on('error', () => this.fail(new Error('The assistant language server input closed.')));
        this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
        this.child.stdout.on('error', () => this.fail(new Error('The assistant language server output closed.')));
        // Server logs can contain workspace paths. They are intentionally not tool results or MCP logs.
        this.child.stderr.on('error', () => { /* Diagnostic output is not part of the protocol. */ });
        this.child.stderr.resume();
        await this.sendRequest('initialize', {
            processId: process.pid,
            rootUri: pathToFileURL(this.roots[0]).href,
            workspaceFolders: this.roots.map((root) => ({ uri: pathToFileURL(root).href, name: path.basename(root) })),
            capabilities: {},
            initializationOptions: { diagnostics: { enable: true, workspace: false } },
            clientInfo: { name: 'qbx-read-only-mcp', version: '1' },
        }, undefined, 60_000);
        this.send({ jsonrpc: '2.0', method: 'initialized', params: {} });
    }

    private sendRequest(method: string, params: unknown, signal?: AbortSignal, timeout = 30_000): Promise<unknown> {
        if (this.disposed || this.failed) { return Promise.reject(this.failed ?? new Error('The assistant language server is closed.')); }
        if (this.pending.size >= 8) { return Promise.reject(new Error('Too many assistant language-server requests are running.')); }
        const id = ++this.nextId;
        return new Promise((resolve, reject) => {
            const cancel = (): void => {
                const pending = this.pending.get(id);
                if (!pending) { return; }
                this.pending.delete(id);
                pending.cleanup();
                this.send({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } });
                reject(new Error('Assistant language-server request cancelled or timed out.'));
            };
            const timer = setTimeout(cancel, timeout);
            const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
            this.pending.set(id, { resolve, reject, cleanup });
            signal?.addEventListener('abort', cancel, { once: true });
            if (signal?.aborted) { cancel(); return; }
            this.send({ jsonrpc: '2.0', id, method, params });
        });
    }

    private send(message: unknown): void {
        if (this.disposed || this.failed || !this.child) { return; }
        const body = JSON.stringify(message);
        this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
    }

    private receive(chunk: Buffer): void {
        if (this.disposed || this.failed) { return; }
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length) {
            if (this.contentLength === undefined) {
                const end = this.buffer.indexOf('\r\n\r\n');
                if (end < 0) { if (this.buffer.length > 8192) { this.fail(new Error('Invalid language-server response header.')); } return; }
                const header = this.buffer.subarray(0, end).toString('ascii');
                const matches = [...header.matchAll(/^Content-Length: ([0-9]+)$/gim)];
                if (end > 8192 || matches.length !== 1 || Number(matches[0][1]) > 8 * 1024 * 1024) { this.fail(new Error('Invalid or oversized language-server response.')); return; }
                this.contentLength = Number(matches[0][1]);
                this.buffer = this.buffer.subarray(end + 4);
            }
            if (this.buffer.length < this.contentLength) { return; }
            const body = this.buffer.subarray(0, this.contentLength).toString('utf8');
            this.buffer = this.buffer.subarray(this.contentLength);
            this.contentLength = undefined;
            let message: unknown;
            try { message = JSON.parse(body); } catch { this.fail(new Error('Invalid language-server JSON response.')); return; }
            if (!isRecord(message)) { this.fail(new Error('Invalid language-server response.')); return; }
            if (typeof message.method === 'string') {
                if (message.id !== undefined) { this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client method not supported.' } }); }
                continue;
            }
            if (typeof message.id !== 'number') { continue; }
            const pending = this.pending.get(message.id);
            if (!pending) { continue; }
            this.pending.delete(message.id);
            pending.cleanup();
            if (isRecord(message.error)) { pending.reject(new Error(typeof message.error.message === 'string' ? message.error.message.slice(0, 2048) : 'Language-server request failed.')); }
            else { pending.resolve(message.result); }
        }
    }

    private fail(error: Error): void {
        if (this.failed) { return; }
        this.failed = error;
        for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error); }
        this.pending.clear();
        this.buffer = Buffer.alloc(0);
        this.child?.kill();
    }

    dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true;
        this.fail(new Error('The assistant language server is closed.'));
        this.child?.stdin.destroy();
        this.child?.stdout.destroy();
        this.child?.stderr.destroy();
    }
}
