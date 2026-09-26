import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { AssistantMcpServer, assistantWorkspaceArguments } from '../../src/assistantMcp';
import { ASSISTANT_MAX_RESULT_BYTES, ASSISTANT_TOOLS, AssistantScope, AssistantTools, assistantRequest, isRecord } from '../../src/assistantTools';
import type { AssistantApi } from '../../src/assistantVscode';

type Test = [name: string, run: () => Promise<void> | void];

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

async function fixture(run: (root: string, outside: string) => Promise<void>): Promise<void> {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'qbx-assistant-'));
    const root = path.join(temporary, 'workspace');
    const outside = path.join(temporary, 'outside');
    try {
        await fs.mkdir(root); await fs.mkdir(outside);
        await fs.writeFile(path.join(root, 'inside.lua'), 'local value = 1\nprint(value)\n');
        await fs.writeFile(path.join(outside, 'private.lua'), 'private = true\n');
        await run(root, outside);
    } finally {
        const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(temporary));
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        assert.ok(path.basename(temporary).startsWith('qbx-assistant-'));
        await fs.rm(temporary, { recursive: true, force: true });
    }
}

class Peer {
    private nextId = 0;
    private buffer = '';
    private readonly pending = new Map<number, { timer: ReturnType<typeof setTimeout>; result: ReturnType<typeof deferred<Record<string, unknown>>> }>();
    readonly messages: Record<string, unknown>[] = [];

    constructor(private readonly input: Writable, output: Readable) {
        output.setEncoding('utf8');
        output.on('data', (chunk: string) => {
            this.buffer += chunk;
            for (;;) {
                const newline = this.buffer.indexOf('\n');
                if (newline < 0) { break; }
                const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
                const value: unknown = JSON.parse(line); assert.ok(isRecord(value)); this.messages.push(value);
                if (typeof value.id === 'number') {
                    const pending = this.pending.get(value.id);
                    if (pending) { clearTimeout(pending.timer); this.pending.delete(value.id); pending.result.resolve(value); }
                }
            }
        });
        output.on('end', () => this.close());
        output.on('error', () => this.close());
    }

    request(method: string, params?: unknown): { id: number; response: Promise<Record<string, unknown>> } {
        const id = ++this.nextId;
        const result = deferred<Record<string, unknown>>();
        const timer = setTimeout(() => { this.pending.delete(id); result.reject(new Error(`MCP ${method} timed out.`)); }, 30_000);
        this.pending.set(id, { timer, result });
        this.input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
        return { id, response: result.promise };
    }

    notify(method: string, params?: unknown): void { this.input.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })}\n`); }

    async initialize(version = '2025-11-25'): Promise<Record<string, unknown>> {
        const response = await this.request('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'qbx-tests', version: '1' } }).response;
        assert.ok(isRecord(response.result));
        this.notify('notifications/initialized');
        return response.result;
    }

    close(): void { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.result.reject(new Error('MCP connection closed.')); } this.pending.clear(); }
}

function resultData(response: Record<string, unknown>): unknown {
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    assert.ok(isRecord(response.result));
    assert.equal(response.result.isError, false, JSON.stringify(response.result));
    const content = response.result.content; assert.ok(Array.isArray(content) && isRecord(content[0]) && typeof content[0].text === 'string');
    const result: unknown = JSON.parse(content[0].text); assert.ok(isRecord(result));
    return result.data;
}

const tests: Test[] = [
    ['Assistant tools reject unsupported methods and malformed or unbounded arguments', () => {
        assert.equal(ASSISTANT_TOOLS.length, 7);
        assert.equal(new Set(ASSISTANT_TOOLS.map((tool) => tool.name)).size, 7);
        assert.equal(assistantRequest('qbx_search_reference', { query: 'INPUT_PICKUP' }).method, 'qbx/referenceSearch');
        assert.equal(assistantRequest('qbx_symbol_references', { uri: 'file:///test.lua', line: 1, character: 4 }).params.includeDeclaration, true);
        for (const [name, input] of [
            ['qbx/reindex', {}], ['qbx_start_resource', {}], ['__proto__', {}],
            ['qbx_list_resources', { method: 'workspace/executeCommand' }], ['qbx_list_resources', null],
            ['qbx_list_resources', { query: 'a'.repeat(257) }], ['qbx_list_resources', { offset: -1 }], ['qbx_list_resources', { limit: 101 }],
            ['qbx_list_resources', { refresh: 'true' }], ['qbx_workspace_health', { refresh: true }],
            ['qbx_search_reference', { kind: ['native'] }], ['qbx_search_reference', { side: 'both' }],
            ['qbx_reference_detail', { id: 'native:GetEntityCoords\n' }], ['qbx_reference_detail', { id: 'control:038' }],
            ['qbx_symbol_references', { uri: 'file:///test.lua', line: 0.1, character: 0 }],
            ['qbx_symbol_references', { uri: 'file:///test.lua', line: 0, character: 0, includeDeclaration: 'true' }],
        ] as const) { assert.throws(() => assistantRequest(name, input), `reject ${name}: ${JSON.stringify(input)}`); }
        assert.throws(() => assistantWorkspaceArguments([]));
        assert.throws(() => assistantWorkspaceArguments(['--workspace', 'relative']));
        assert.throws(() => assistantWorkspaceArguments(['--server', process.execPath]));
    }],
    ['Assistant file scope rejects traversal, network URIs and symlink escapes', () => fixture(async (root, outside) => {
        const scope = await AssistantScope.create([root]);
        const valid = pathToFileURL(path.join(root, 'inside.lua')).href;
        assert.equal(await scope.uri(valid), valid);
        await assert.rejects(scope.uri(pathToFileURL(path.join(outside, 'private.lua')).href), /outside/);
        await assert.rejects(scope.uri(`${valid}?query=secret`), /file URI/);
        await assert.rejects(scope.uri('file://remote/share/script.lua'), /file URI/);
        await assert.rejects(scope.uri('https://example.test/file.lua'), /file URI/);
        await assert.rejects(scope.uri(pathToFileURL(path.join(root, 'missing.lua')).href), /no longer exists/);
        await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
        await assert.rejects(scope.uri(pathToFileURL(path.join(root, 'linked', 'private.lua')).href), /resolves outside/);
        await assert.rejects(AssistantScope.create([]), /workspace folders/);
    })],
    ['Assistant dispatcher enforces trust, scopes returned records, and bounds results', () => fixture(async (root, outside) => {
        let trusted = false;
        let calls = 0;
        const inside = pathToFileURL(path.join(root, 'inside.lua')).href;
        const privateUri = pathToFileURL(path.join(outside, 'private.lua')).href;
        let response: unknown = { items: [{ uri: inside, message: 'visible' }, { uri: privateUri, message: 'must disappear' }], total: 2 };
        const tools = new AssistantTools({ roots: () => [root], trusted: () => trusted, snapshot: 'live editor index', request: async () => { calls++; return response; } });
        try {
            await assert.rejects(tools.call('qbx_diagnostics', {}), /trusted/); assert.equal(calls, 0);
            trusted = true;
            await assert.rejects(tools.call('qbx_diagnostics', { uri: privateUri }), /outside/); assert.equal(calls, 0);
            const result = await tools.call('qbx_diagnostics', {});
            assert.ok(isRecord(result.data)); assert.deepEqual(result.data.items, [{ uri: inside, message: 'visible' }]); assert.equal(result.data.total, 2);
            assert.ok(result.notes.some((note) => note.includes('omitted')));
            response = { issues: [{ kind: 'missing', name: 'private-name', resource: { uri: privateUri } }], events: [{ name: 'private-event', location: { uri: privateUri } }] };
            const filtered = await tools.call('qbx_workspace_health', {}); assert.deepEqual(filtered.data, { issues: [], events: [] });
            response = { text: 'x'.repeat(ASSISTANT_MAX_RESULT_BYTES) }; await assert.rejects(tools.call('qbx_workspace_health', {}), /512 KiB/);
        } finally { tools.dispose(); }
        await assert.rejects(tools.call('qbx_workspace_health', {}), /disposed/);
    })],
    ['Assistant requests cancel promptly and discard replies after workspace changes', () => fixture(async (root, outside) => {
        const pending = deferred<unknown>(); const entered = deferred<AbortSignal>();
        let roots = [root];
        const tools = new AssistantTools({ roots: () => roots, trusted: () => true, snapshot: 'live editor index', request: async (_method, _params, signal) => { entered.resolve(signal); return pending.promise; } });
        try {
            const controller = new AbortController();
            const request = tools.call('qbx_workspace_health', {}, controller.signal);
            const signal = await entered.promise; controller.abort();
            await assert.rejects(request, /cancelled/); assert.equal(signal.aborted, true);
            pending.resolve({});
        } finally { tools.dispose(); }
        const entered2 = deferred<void>(); const response2 = deferred<unknown>();
        const tools2 = new AssistantTools({ roots: () => roots, trusted: () => true, snapshot: 'live editor index', request: async () => { entered2.resolve(); return response2.promise; } });
        try {
            const request = tools2.call('qbx_workspace_health', {}); await entered2.promise; roots = [outside]; response2.resolve({});
            await assert.rejects(request, /changed/);
        } finally { tools2.dispose(); }
    })],
    ['Assistant explicit refresh runs before listing and rechecks cancellation, trust and roots', () => fixture(async (root, outside) => {
        const calls: { method: string; params: unknown }[] = [];
        const tools = new AssistantTools({ roots: () => [root], trusted: () => true, snapshot: 'live editor index', request: async (method, params) => { calls.push({ method, params }); return { items: [] }; } });
        try {
            await tools.call('qbx_list_resources', {}); assert.deepEqual(calls.map((call) => call.method), ['qbx/resources']); calls.length = 0;
            await tools.call('qbx_list_resources', { refresh: true });
            assert.deepEqual(calls.map((call) => call.method), ['qbx/reindex', 'qbx/resources']); assert.deepEqual(calls[0].params, {});
            assert.ok(isRecord(calls[1].params)); assert.equal(calls[1].params.refresh, undefined);
        } finally { tools.dispose(); }
        for (const change of ['cancel', 'trust', 'roots']) {
            const entered = deferred<void>(); const gate = deferred<unknown>(); const methods: string[] = [];
            let trusted = true; let roots = [root]; const controller = new AbortController();
            const guarded = new AssistantTools({ roots: () => roots, trusted: () => trusted, snapshot: 'live editor index', request: async (method) => { methods.push(method); entered.resolve(); return gate.promise; } });
            try {
                const request = guarded.call('qbx_list_resources', { refresh: true }, controller.signal); await entered.promise;
                if (change === 'cancel') { controller.abort(); } else if (change === 'trust') { trusted = false; } else { roots = [outside]; }
                gate.resolve({}); await assert.rejects(request, /cancelled|changed/); assert.deepEqual(methods, ['qbx/reindex']);
            } finally { gate.resolve({}); guarded.dispose(); }
        }
    })],
    ['MCP handshake, discovery, bounded errors and cancellation obey the stdio protocol', async () => {
        const input = new PassThrough(); const output = new PassThrough(); const invoked = deferred<AbortSignal>(); let disposed = 0;
        const server = new AssistantMcpServer(input, output, { call: async (_name, _args, signal) => {
            invoked.resolve(signal); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
        }, dispose: () => { disposed++; } });
        const peer = new Peer(input, output);
        try {
            assert.ok(isRecord((await peer.request('tools/list').response).error));
            const init = await peer.initialize(); assert.equal(init.protocolVersion, '2025-11-25'); assert.deepEqual(init.capabilities, { tools: {} });
            const listed = await peer.request('tools/list').response; assert.ok(isRecord(listed.result) && Array.isArray(listed.result.tools)); assert.equal(listed.result.tools.length, 7);
            assert.ok(listed.result.tools.every((tool: unknown) => isRecord(tool) && isRecord(tool.annotations) && tool.annotations.readOnlyHint === true));
            assert.ok(isRecord((await peer.request('workspace/executeCommand', {}).response).error));
            assert.ok(isRecord((await peer.request('tools/call', { name: 'qbx/reindex', arguments: {} }).response).error));
            input.write('{invalid json}\n');
            assert.ok(peer.messages.some((message) => message.id === null && isRecord(message.error) && message.error.code === -32700));
            const call = peer.request('tools/call', { name: 'qbx_workspace_health', arguments: {} }); const signal = await invoked.promise;
            peer.notify('notifications/cancelled', { requestId: call.id });
            const cancelled = await call.response; assert.equal(signal.aborted, true); assert.ok(isRecord(cancelled.result) && cancelled.result.isError === true);
            const ended = new Promise<void>((resolve) => input.once('end', resolve)); input.end(); await ended; assert.equal(disposed, 1);
        } finally { server.dispose(); peer.close(); }
        assert.equal(disposed, 1);
    }],
    ['MCP preserves older clients, chunked UTF-8 and fatal message limits', async () => {
        const input = new PassThrough(); const output = new PassThrough(); let disposed = 0;
        const server = new AssistantMcpServer(input, output, { call: async () => ({ data: { name: 'é' }, notes: [] }), dispose: () => { disposed++; } });
        const peer = new Peer(input, output);
        try {
            assert.equal((await peer.initialize('2024-11-05')).protocolVersion, '2024-11-05');
            const response = await peer.request('tools/call', { name: 'qbx_workspace_health', arguments: {} }).response;
            assert.deepEqual(resultData(response), { name: 'é' }); assert.ok(isRecord(response.result)); assert.equal(response.result.structuredContent, undefined);
            const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'ping', params: { value: 'é' } }) + '\n');
            const split = bytes.indexOf(Buffer.from('é')) + 1;
            input.write(bytes.subarray(0, split)); input.write(bytes.subarray(split));
            assert.ok(peer.messages.some((message) => message.id === 100 && isRecord(message.result)));
            input.write('x'.repeat(64 * 1024 + 1)); assert.equal(disposed, 1);
        } finally { server.dispose(); peer.close(); }
    }],
];

async function packagedProcess(): Promise<void> {
    await fixture(async (root) => {
        const resource = path.join(root, 'demo'); await fs.mkdir(resource);
        await fs.writeFile(path.join(resource, 'fxmanifest.lua'), "fx_version 'cerulean'\ngame 'gta5'\nclient_script 'client.lua'\n");
        const file = path.join(resource, 'client.lua');
        await fs.writeFile(file, "function AssistantProbe(value)\n    return value\nend\nlocal result = AssistantProbe(1)\nRegisterNetEvent('demo:ready', function() print(result) end)\n");
        const directory = path.resolve(__dirname, '..', '..', '..');
        const bridge = path.join(directory, 'dist', 'assistantMcp.js');
        const child = spawn(process.execPath, [bridge, '--workspace', root], { windowsHide: true, stdio: 'pipe', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
        let stderr = ''; child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-8192); });
        const exited = deferred<number | null>(); child.once('exit', (code) => exited.resolve(code)); child.once('error', (error) => exited.reject(error));
        const peer = new Peer(child.stdin, child.stdout);
        try {
            await peer.initialize();
            const call = async (name: string, arguments_: unknown = {}): Promise<unknown> => resultData(await peer.request('tools/call', { name, arguments: arguments_ }).response);
            const resources = await call('qbx_list_resources'); assert.ok(isRecord(resources) && Array.isArray(resources.items));
            assert.equal(resources.total, 1); assert.ok(isRecord(resources.items[0])); assert.equal(resources.items[0].name, 'demo');
            const details = await call('qbx_resource_details', { uri: resources.items[0].uri }); assert.ok(isRecord(details) && Array.isArray(details.events)); assert.ok(details.events.some((event: unknown) => isRecord(event) && event.name === 'demo:ready'));
            const diagnostics = await call('qbx_diagnostics', { uri: pathToFileURL(file).href }); assert.ok(isRecord(diagnostics) && Array.isArray(diagnostics.items));
            const refs = await call('qbx_symbol_references', { uri: pathToFileURL(file).href, line: 0, character: 12 }); assert.ok(isRecord(refs) && Array.isArray(refs.items)); assert.ok(refs.total === 2, JSON.stringify(refs));
            const search = await call('qbx_search_reference', { query: 'GetEntityCoords', kind: 'native', limit: 1 }); assert.ok(isRecord(search) && Array.isArray(search.items)); assert.ok(isRecord(search.items[0])); assert.equal(search.items[0].id, 'native:GetEntityCoords');
            const native = await call('qbx_reference_detail', { id: 'control:38' }); assert.ok(isRecord(native)); assert.equal(native.name, 'INPUT_PICKUP');
            const health = await call('qbx_workspace_health'); assert.ok(isRecord(health) && Array.isArray(health.issues));
            await fs.appendFile(file, "RegisterNetEvent('demo:addedAfterIndex', function() end)\n");
            const before = await call('qbx_resource_details', { uri: resources.items[0].uri }); assert.ok(isRecord(before) && Array.isArray(before.events));
            assert.ok(!before.events.some((event: unknown) => isRecord(event) && event.name === 'demo:addedAfterIndex'));
            await call('qbx_list_resources', { refresh: true });
            const after = await call('qbx_resource_details', { uri: resources.items[0].uri }); assert.ok(isRecord(after) && Array.isArray(after.events));
            assert.ok(after.events.some((event: unknown) => isRecord(event) && event.name === 'demo:addedAfterIndex'));
            child.stdin.end();
            let timer: ReturnType<typeof setTimeout> | undefined;
            try { const code = await Promise.race([exited.promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`MCP child did not close on EOF. ${stderr}`)), 5000); })]); assert.equal(code, 0, stderr); }
            finally { if (timer) { clearTimeout(timer); } }
        } finally { peer.close(); child.kill(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); }
    });
}

async function editorApi(): Promise<void> {
    const vscode = await import('vscode');
    const extension = vscode.extensions.getExtension<AssistantApi>('qbox.qbx-lua'); assert.ok(extension);
    const api = await extension.activate(); assert.equal(api.version, 1); assert.equal(api.tools.length, 7);
    const definitions = extension.packageJSON.contributes.languageModelTools as { name: string; inputSchema: unknown }[];
    for (const tool of ASSISTANT_TOOLS) { const contributed = definitions.find((item) => item.name === tool.name); assert.ok(contributed, tool.name); assert.deepEqual(contributed.inputSchema, tool.inputSchema); }
    const resources = await api.call('qbx_list_resources', { limit: 1 }); assert.ok(isRecord(resources) && isRecord(resources.data) && Array.isArray(resources.data.items));
    await assert.rejects(api.call('qbx_start_resource', { name: 'demo' }), /Unknown/);
    const cancelled = new vscode.CancellationTokenSource(); cancelled.cancel();
    try { await assert.rejects(api.call('qbx_workspace_health', {}, cancelled.token), /cancelled/); } finally { cancelled.dispose(); }
    if (typeof vscode.lm?.registerTool === 'function') { assert.ok(ASSISTANT_TOOLS.every((tool) => vscode.lm.tools.some((registered) => registered.name === tool.name))); }
}

export async function runAssistantToolsTests(options: { packaged?: boolean; editor?: boolean } = {}): Promise<void> {
    const failures: string[] = [];
    const selected = [...tests, ...(options.packaged === false ? [] : [['Packaged MCP process queries the real Lua index and closes its child on EOF', packagedProcess] as Test]), ...(options.editor === false ? [] : [['Extension exports the versioned assistant API and registers supported LM tools', editorApi] as Test])];
    for (const [name, run] of selected) {
        try { await run(); console.log(`  ok   ${name}`); }
        catch (error) { failures.push(name); console.error(`  FAIL ${name}\n${error instanceof Error ? error.stack : String(error)}`); }
    }
    if (failures.length) { throw new Error(`${failures.length} assistant tools tests failed: ${failures.join(', ')}`); }
}
