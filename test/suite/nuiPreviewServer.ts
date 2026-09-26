import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { createNuiPreviewServer, type NuiPreviewServer } from '../../src/nuiPreviewServer';

type Test = [string, () => Promise<void>];
interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

function request(server: NuiPreviewServer, asset: string, options: { method?: string; headers?: Record<string, string>; raw?: boolean } = {}): Promise<Reply> {
    const url = new URL(server.origin);
    return new Promise((resolve, reject) => {
        const outgoing = http.request({ hostname: url.hostname, port: url.port, path: options.raw ? asset : `/${server.token}/${asset}`, method: options.method ?? 'GET', headers: options.headers, agent: false }, (incoming) => {
            const buffers: Buffer[] = [];
            let bytes = 0;
            incoming.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) { incoming.destroy(new Error('Unexpected oversized test response')); } else { buffers.push(chunk); } });
            incoming.on('error', reject);
            incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(buffers).toString('utf8') }));
        });
        outgoing.setTimeout(3000, () => outgoing.destroy(new Error('Preview test request timed out')));
        outgoing.on('error', reject);
        outgoing.end();
    });
}

async function fixture(body: (root: string, server: NuiPreviewServer) => Promise<void>, html = '<!doctype html><html><head></head><body>Preview</body></html>'): Promise<void> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qbx-nui-http-'));
    let server: NuiPreviewServer | undefined;
    try {
        await fs.mkdir(path.join(root, 'ui', 'assets'), { recursive: true });
        await fs.writeFile(path.join(root, 'ui', 'index.html'), html);
        server = await createNuiPreviewServer({ root, uiPage: 'ui/index.html', resourceName: 'Test_Resource', bridgeScript: '/* trusted bridge */' });
        await body(root, server);
    } finally {
        server?.dispose();
        assert.ok(path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
        assert.ok(path.basename(root).startsWith('qbx-nui-http-'));
        await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
}

const tests: Test[] = [
    ['NUI server injects the bridge first without modifying page script text or weakening existing CSP', async () => {
        const original = '<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="img-src data:"><base href="https://invalid.example/">'
            + '<script>const untouched = \'</scripture><img src="/inside.js">\';</script><link href=/assets/main.css>'
            + '<!-- <img src="/comment.png"> --></head><body><img title=\'literal href="/title"\' src="/assets/logo.png"><script src="//external.example/a.js"></script></body></html>';
        await fixture(async (root, server) => {
            const response = await request(server, 'index.html');
            assert.equal(response.status, 200);
            assert.ok(response.body.startsWith('<!DOCTYPE html>'));
            const bridge = response.body.indexOf('__qbx_preview_bridge.js');
            assert.ok(bridge > 0 && bridge < response.body.indexOf('const untouched'));
            assert.match(response.body, /http-equiv="Content-Security-Policy" content="img-src data:"/);
            assert.equal((response.body.match(/<base /g) ?? []).length, 1);
            assert.ok(response.body.includes(`<base href="${server.origin}/${server.token}/">`));
            assert.ok(response.body.includes(`href="/${server.token}/assets/main.css"`));
            assert.ok(response.body.includes(`src="/${server.token}/assets/logo.png"`));
            assert.ok(response.body.includes('const untouched = \'</scripture><img src="/inside.js">\''));
            assert.ok(response.body.includes('<!-- <img src="/comment.png"> -->'));
            assert.ok(response.body.includes('title=\'literal href="/title"\''));
            assert.ok(response.body.includes('src="//external.example/a.js"'));
            assert.equal(await fs.readFile(path.join(root, 'ui', 'index.html'), 'utf8'), original, 'preview never modifies the selected file');
            const config = await request(server, '__qbx_preview_bridge.js');
            assert.equal(config.status, 200);
            assert.ok(config.body.includes(JSON.stringify(server.token)));
            assert.ok(config.body.includes('"resourceName":"Test_Resource"'));
            assert.ok(config.body.endsWith('/* trusted bridge */'));
        }, original);
    }],
    ['NUI server requires its token and exact loopback host and permits only read requests', async () => {
        await fixture(async (_root, server) => {
            assert.equal((await request(server, '/index.html', { raw: true })).status, 404);
            assert.equal((await request(server, '/incorrect/index.html', { raw: true })).status, 404);
            assert.equal((await request(server, 'index.html', { headers: { Host: 'attacker.example' } })).status, 403);
            assert.equal((await request(server, 'index.html', { method: 'POST' })).status, 405);
            assert.equal((await request(server, 'index.html', { method: 'OPTIONS' })).status, 405);
            const response = await request(server, 'index.html');
            assert.equal(response.headers['access-control-allow-origin'], '*');
            assert.equal(response.headers['x-content-type-options'], 'nosniff');
            assert.equal(response.headers['cache-control'], 'no-store');
            const csp = String(response.headers['content-security-policy']);
            assert.ok(csp.includes(`connect-src ${server.origin};`));
            assert.ok(csp.includes("frame-src 'none'"));
            assert.ok(csp.includes("form-action 'none'"));
            assert.ok(csp.includes('sandbox allow-scripts allow-same-origin;'));
            assert.ok(!csp.includes('https:') && !csp.includes('*') && !csp.includes('unsafe-eval'));
            const head = await request(server, 'index.html', { method: 'HEAD' });
            assert.equal(head.status, 200);
            assert.equal(head.body, '');
            assert.equal(head.headers['content-length'], response.headers['content-length']);
        });
    }],
    ['NUI assets stay within the selected UI directory and unsupported files are never served', async () => {
        await fixture(async (root, server) => {
            await fs.writeFile(path.join(root, 'outside.json'), '{"secret":1}');
            for (const file of ['main.lua', 'server.cfg', '.env', '.hidden.json']) { await fs.writeFile(path.join(root, 'ui', file), 'private'); }
            await fs.writeFile(path.join(root, 'ui', 'assets', 'module.mjs'), 'export const ok = true;');
            for (const denied of ['../outside.json', '%2e%2e/outside.json', '..%2foutside.json', '..%5coutside.json', '%00.json', '/outside.json', 'main.lua', 'server.cfg', '.env', '.hidden.json']) {
                assert.equal((await request(server, denied)).status, 403, denied);
            }
            assert.equal((await request(server, '%ZZ.json')).status, 400);
            assert.equal((await request(server, 'outside.json')).status, 404);
            const module = await request(server, 'assets/module.mjs?v=42');
            assert.equal(module.status, 200);
            assert.equal(module.body, 'export const ok = true;');
            assert.match(String(module.headers['content-type']), /javascript/);
        });
    }],
    ['NUI CSS root URLs are prefixed without rewriting comments, unrelated strings or external URLs', async () => {
        await fixture(async (root, server) => {
            const css = '@import "/assets/theme.css"; @import url(\'/assets/more.css\'); .a{background:url(/assets/a.png);mask:url("/assets/a.svg")} '
                + '.b{content:"url(/literal.png)";background:url(https://external.example/a.png)} /* url(/comment.png) */';
            await fs.writeFile(path.join(root, 'ui', 'assets', 'main.css'), css);
            const response = await request(server, 'assets/main.css');
            assert.equal(response.status, 200);
            for (const asset of ['theme.css', 'more.css', 'a.png', 'a.svg']) { assert.ok(response.body.includes(`/${server.token}/assets/${asset}`), asset); }
            assert.ok(response.body.includes('content:"url(/literal.png)"'));
            assert.ok(response.body.includes('url(https://external.example/a.png)'));
            assert.ok(response.body.includes('/* url(/comment.png) */'));
            assert.equal(await fs.readFile(path.join(root, 'ui', 'assets', 'main.css'), 'utf8'), css);
        });
    }],
    ['NUI rejects remote, absolute, traversal and non-HTML ui_page values before opening a server', async () => {
        await fixture(async (root) => {
            for (const uiPage of ['https://example.test/index.html', '/ui/index.html', 'C:/ui/index.html', '../index.html', 'ui/../ui/index.html', 'ui/%2e%2e/index.html', 'ui/index.html?test=1', 'ui/index.html#test', 'ui/index%23.html', 'ui\\index.html', 'ui/test.lua', '%ZZ.html']) {
                await assert.rejects(createNuiPreviewServer({ root, uiPage, resourceName: 'test', bridgeScript: '' }), uiPage);
            }
            await assert.rejects(createNuiPreviewServer({ root: '.', uiPage: 'ui/index.html', resourceName: 'test', bridgeScript: '' }), /absolute/);
            await assert.rejects(createNuiPreviewServer({ root, uiPage: 'ui/index.html', resourceName: 'invalid/name', bridgeScript: '' }), /resource name/);
            await assert.rejects(createNuiPreviewServer({ root, uiPage: 'ui/index.html', resourceName: 'test', bridgeScript: 'x'.repeat(512 * 1024 + 1) }), /bridge is too large/);
        });
    }],
    ['NUI rejects directory symlinks escaping the resource or selected UI directory', async () => {
        await fixture(async (root, server) => {
            const other = path.join(root, 'private');
            await fs.mkdir(other);
            await fs.writeFile(path.join(other, 'secret.json'), '{"secret":true}');
            await fs.writeFile(path.join(other, 'index.html'), '<html>Other</html>');
            await fs.symlink(other, path.join(root, 'ui', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
            assert.equal((await request(server, 'escape/secret.json')).status, 403);
            const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'qbx-nui-outside-'));
            try {
                await fs.writeFile(path.join(outside, 'index.html'), '<html>Outside</html>');
                await fs.symlink(outside, path.join(root, 'escaped-ui'), process.platform === 'win32' ? 'junction' : 'dir');
                await assert.rejects(createNuiPreviewServer({ root, uiPage: 'escaped-ui/index.html', resourceName: 'test', bridgeScript: '' }), /escapes/);
            } finally {
                assert.ok(path.resolve(outside).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
                assert.ok(path.basename(outside).startsWith('qbx-nui-outside-'));
                await fs.rm(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
            }
        });
    }],
    ['NUI enforces per-type size limits and serves bounded media ranges and HEAD requests', async () => {
        await fixture(async (root, server) => {
            await fs.writeFile(path.join(root, 'ui', 'clip.mp4'), '0123456789');
            const first = await request(server, 'clip.mp4', { headers: { Range: 'bytes=2-4' } });
            assert.equal(first.status, 206); assert.equal(first.body, '234'); assert.equal(first.headers['content-range'], 'bytes 2-4/10');
            assert.equal((await request(server, 'clip.mp4', { headers: { Range: 'bytes=-3' } })).body, '789');
            assert.equal((await request(server, 'clip.mp4', { headers: { Range: 'bytes=7-' } })).body, '789');
            for (const range of ['bytes=20-', 'bytes=3-1', 'bytes=-0', 'bytes=0-1,3-4', 'bytes=-', 'bytes=9007199254740993-', 'bytes=-9007199254740993']) {
                assert.equal((await request(server, 'clip.mp4', { headers: { Range: range } })).status, 416, range);
            }
            const head = await request(server, 'clip.mp4', { method: 'HEAD', headers: { Range: 'bytes=2-4' } });
            assert.equal(head.status, 206); assert.equal(head.body, ''); assert.equal(head.headers['content-length'], '3');
            for (const [file, bytes] of [['large.js', 8 * 1024 * 1024 + 1], ['large.mp4', 64 * 1024 * 1024 + 1], ['large.html', 2 * 1024 * 1024 + 1]] as const) {
                const handle = await fs.open(path.join(root, 'ui', file), 'w');
                try { await handle.truncate(bytes); } finally { await handle.close(); }
                assert.equal((await request(server, file, { method: 'HEAD' })).status, 413, file);
            }
            await assert.rejects(createNuiPreviewServer({ root, uiPage: 'ui/large.html', resourceName: 'test', bridgeScript: '' }), /2 MiB/);
        });
    }],
    ['NUI instances use independent tokens and disposal closes the listener', async () => {
        await fixture(async (root, first) => {
            const second = await createNuiPreviewServer({ root, uiPage: 'ui/index.html', resourceName: 'test', bridgeScript: '' });
            try {
                assert.notEqual(first.token, second.token);
                assert.notEqual(first.origin, second.origin);
                assert.equal((await request(second, `/${first.token}/index.html`, { raw: true })).status, 404);
                second.dispose(); second.dispose();
                await assert.rejects(request(second, 'index.html'), (error: NodeJS.ErrnoException) => error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET');
                assert.equal((await request(first, 'index.html')).status, 200);
            } finally { second.dispose(); }
        });
    }],
];

export async function runNuiPreviewServerTests(): Promise<void> {
    let failed = 0;
    for (const [name, body] of tests) {
        try { await body(); console.log(`  ✓ ${name}`); }
        catch (error) { failed++; console.error(`  ✗ ${name}`, error); }
    }
    assert.equal(failed, 0, `${failed} NUI preview server tests failed`);
}
