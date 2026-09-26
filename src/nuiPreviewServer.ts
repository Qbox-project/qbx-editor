import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';

export interface NuiPreviewServerOptions { root: string; uiPage: string; resourceName: string; bridgeScript: string }
export interface NuiPreviewServer { url: string; origin: string; token: string; dispose(): void }

const TEXT_LIMIT = 8 * 1024 * 1024;
const HTML_LIMIT = 2 * 1024 * 1024;
const MEDIA_LIMIT = 64 * 1024 * 1024;
const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.avif': 'image/avif', '.bmp': 'image/bmp',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject',
    '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.opus': 'audio/ogg',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg',
};

function contained(root: string, value: string): boolean {
    const relative = path.relative(root, value);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function localPath(value: string): string[] | undefined {
    if (!value || value.length > 4096 || /[\x00-\x1f\x7f\\:#?]/.test(value) || value.startsWith('/')) { return undefined; }
    const parts = value.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.') || /[ .]$/.test(part))) { return undefined; }
    return parts;
}

function limit(extension: string): number {
    if (extension === '.html' || extension === '.htm') { return HTML_LIMIT; }
    return /^\.(?:js|mjs|css|json|svg)$/.test(extension) ? TEXT_LIMIT : MEDIA_LIMIT;
}

function escaped(value: string): string { return value.replace(/[&"<>]/g, (character) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[character]!); }
function scriptData(value: unknown): string { return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }

interface HtmlTag { start: number; end: number; name: string; closing: boolean; text: string }

/** Tokenize tags without editing raw script/style content or comments. */
function htmlTags(html: string): HtmlTag[] {
    const result: HtmlTag[] = [];
    const lower = html.toLowerCase();
    let cursor = 0;
    while (cursor < html.length) {
        const start = html.indexOf('<', cursor);
        if (start < 0) { break; }
        if (html.startsWith('<!--', start)) {
            const end = html.indexOf('-->', start + 4);
            cursor = end < 0 ? html.length : end + 3;
            continue;
        }
        const match = /^<\s*(\/?)\s*(!doctype|[a-z][a-z0-9:-]*)\b/i.exec(html.slice(start, start + 128));
        if (!match) { cursor = start + 1; continue; }
        let quote = '';
        let end = start + match[0].length;
        for (; end < html.length; end++) {
            const char = html[end];
            if (quote) { if (char === quote) { quote = ''; } }
            else if (char === '"' || char === "'") { quote = char; }
            else if (char === '>') { end++; break; }
        }
        const name = match[2].toLowerCase();
        const tag = { start, end, name, closing: match[1] === '/', text: html.slice(start, end) };
        result.push(tag);
        cursor = end;
        if (!tag.closing && ['script', 'style', 'textarea', 'title'].includes(name)) {
            let close = lower.indexOf(`</${name}`, cursor);
            while (close >= 0 && !/[\s/>]/.test(lower[close + name.length + 2] ?? '')) { close = lower.indexOf(`</${name}`, close + name.length + 2); }
            cursor = close < 0 ? html.length : close;
        }
    }
    return result;
}

function rewriteAttributes(tag: string, prefix: string): string {
    const chunks: string[] = [];
    let copied = 0;
    let cursor = /^<\s*[a-z][a-z0-9:-]*/i.exec(tag)?.[0].length ?? tag.length;
    while (cursor < tag.length) {
        while (/\s/.test(tag[cursor] ?? '')) { cursor++; }
        if (cursor >= tag.length || tag[cursor] === '>' || tag[cursor] === '/') { break; }
        const nameStart = cursor;
        while (cursor < tag.length && !/[\s=<>/]/.test(tag[cursor])) { cursor++; }
        const name = tag.slice(nameStart, cursor).toLowerCase();
        if (cursor === nameStart) { cursor++; continue; }
        while (/\s/.test(tag[cursor] ?? '')) { cursor++; }
        if (tag[cursor] !== '=') { continue; }
        cursor++;
        while (/\s/.test(tag[cursor] ?? '')) { cursor++; }
        const valueStart = cursor;
        const quote = tag[cursor] === '"' || tag[cursor] === "'" ? tag[cursor++] : '';
        const contentStart = cursor;
        while (cursor < tag.length && (quote ? tag[cursor] !== quote : !/[\s>]/.test(tag[cursor]))) { cursor++; }
        const value = tag.slice(contentStart, cursor);
        if (quote && tag[cursor] === quote) { cursor++; }
        if ((name === 'src' || name === 'href') && value.startsWith('/') && !value.startsWith('//')) {
            chunks.push(tag.slice(copied, valueStart), `"${escaped(prefix + value.slice(1))}"`);
            copied = cursor;
        }
    }
    chunks.push(tag.slice(copied));
    return chunks.join('');
}

function injectHtml(html: string, assetBase: string, bridgeUrl: string, prefix: string): string {
    const tags = htmlTags(html);
    const head = tags.find((tag) => tag.name === 'head' && !tag.closing);
    const firstScript = tags.find((tag) => tag.name === 'script' && !tag.closing);
    const doctype = tags.find((tag) => tag.name === '!doctype');
    const position = head && (!firstScript || head.start < firstScript.start) ? head.end
        : doctype && (!firstScript || doctype.start < firstScript.start) ? doctype.end : 0;
    const injection = `<base href="${escaped(assetBase)}"><script src="${escaped(bridgeUrl)}"></script>`;
    const edits = tags.filter((tag) => !tag.closing && tag.name !== '!doctype').map((tag) => ({
        start: tag.start, end: tag.end, text: tag.name === 'base' ? '' : rewriteAttributes(tag.text, prefix),
    }));
    edits.push({ start: position, end: position, text: injection });
    edits.sort((a, b) => a.start - b.start || a.end - b.end);
    const result: string[] = [];
    let copied = 0;
    for (const edit of edits) { result.push(html.slice(copied, edit.start), edit.text); copied = edit.end; }
    result.push(html.slice(copied));
    return result.join('');
}

/** Prefix literal CSS root URLs, leaving comments, strings and external URLs unchanged. */
function rewriteCss(css: string, prefix: string): string {
    const edits: number[] = [];
    const skipString = (start: number): number => {
        const quote = css[start];
        let cursor = start + 1;
        while (cursor < css.length) {
            if (css[cursor] === '\\') { cursor += 2; }
            else if (css[cursor++] === quote) { break; }
        }
        return cursor;
    };
    const root = (position: number): void => {
        if (css[position] === '/' && css[position + 1] !== '/') { edits.push(position); }
    };
    for (let cursor = 0; cursor < css.length;) {
        if (css.startsWith('/*', cursor)) {
            const end = css.indexOf('*/', cursor + 2);
            cursor = end < 0 ? css.length : end + 2;
        } else if (css[cursor] === '"' || css[cursor] === "'") { cursor = skipString(cursor); }
        else {
            const word = css.slice(cursor, cursor + 8).toLowerCase();
            if (word.startsWith('@import') && /\s/.test(css[cursor + 7] ?? '')) {
                cursor += 7;
                while (/\s/.test(css[cursor] ?? '')) { cursor++; }
                if (css[cursor] === '"' || css[cursor] === "'") { root(cursor + 1); cursor = skipString(cursor); }
            } else if (word.startsWith('url(') && (cursor === 0 || !/[\w-]/.test(css[cursor - 1]))) {
                cursor += 4;
                while (/\s/.test(css[cursor] ?? '')) { cursor++; }
                if (css[cursor] === '"' || css[cursor] === "'") { root(cursor + 1); cursor = skipString(cursor); }
                else {
                    root(cursor);
                    while (cursor < css.length && css[cursor] !== ')') { cursor += css[cursor] === '\\' ? 2 : 1; }
                }
            } else { cursor++; }
        }
    }
    const result: string[] = [];
    let copied = 0;
    for (const position of edits) { result.push(css.slice(copied, position), prefix); copied = position + 1; }
    result.push(css.slice(copied));
    return result.join('');
}

/** A token-scoped, read-only static server for one explicitly selected local NUI directory. */
export async function createNuiPreviewServer(options: NuiPreviewServerOptions): Promise<NuiPreviewServer> {
    if (!path.isAbsolute(options.root)) { throw new Error('Choose an absolute local resource folder.'); }
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(options.resourceName)) { throw new Error('The resource name cannot be represented as a NUI callback host.'); }
    if (Buffer.byteLength(options.bridgeScript) > 512 * 1024) { throw new Error('The preview bridge is too large.'); }
    let decoded: string;
    try { decoded = decodeURIComponent(options.uiPage); }
    catch { throw new Error('The ui_page path contains invalid percent encoding.'); }
    const parts = localPath(decoded);
    if (!parts || !['.html', '.htm'].includes(path.extname(decoded).toLowerCase())) { throw new Error('Preview requires a local relative HTML ui_page without a query, fragment or parent traversal.'); }
    const resourceRoot = await fs.realpath(options.root);
    if (!(await fs.stat(resourceRoot)).isDirectory()) { throw new Error('The selected resource is not a directory.'); }
    const logicalEntry = path.join(resourceRoot, ...parts);
    const directory = await fs.realpath(path.dirname(logicalEntry));
    const entry = await fs.realpath(logicalEntry);
    if (!contained(resourceRoot, directory) || !contained(directory, entry)) { throw new Error('The ui_page or its directory escapes the selected resource through a symlink.'); }
    const entryStat = await fs.stat(entry);
    if (!entryStat.isFile() || entryStat.size > HTML_LIMIT) { throw new Error('The ui_page must be a regular HTML file no larger than 2 MiB.'); }

    const token = randomBytes(24).toString('hex');
    const prefix = `/${token}/`;
    const bridgeRoute = `${prefix}__qbx_preview_bridge.js`;
    let origin = '';
    let disposed = false;
    const activeHandles = new Set<fs.FileHandle>();
    const sockets = new Set<import('node:net').Socket>();

    const csp = (): string => `sandbox allow-scripts allow-same-origin; default-src 'none'; script-src ${origin} 'unsafe-inline'; style-src ${origin} 'unsafe-inline'; img-src ${origin} data:; font-src ${origin} data:; media-src ${origin} data:; connect-src ${origin}; base-uri ${origin}; form-action 'none'; frame-src 'none'; object-src 'none'; worker-src 'none'; manifest-src 'none'`;
    const server = http.createServer((request, response) => { void serve(request, response); });
    server.requestTimeout = 10000;
    server.headersTimeout = 10000;
    server.keepAliveTimeout = 1000;
    server.maxHeadersCount = 50;
    server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });

    async function serve(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
        let handle: fs.FileHandle | undefined;
        const finish = (status: number, message: string): void => {
            if (response.destroyed || response.writableEnded) { return; }
            response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(message) });
            response.end(request.method === 'HEAD' ? undefined : message);
        };
        try {
            response.setHeader('Content-Security-Policy', csp());
            response.setHeader('X-Content-Type-Options', 'nosniff');
            response.setHeader('Referrer-Policy', 'no-referrer');
            response.setHeader('Cache-Control', 'no-store');
            response.setHeader('Access-Control-Allow-Origin', '*');
            response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
            if (disposed) { finish(503, 'Preview closed.'); return; }
            const address = server.address();
            const port = typeof address === 'object' && address ? address.port : 0;
            if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(request.headers.host?.toLowerCase() ?? '')
                || !['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) { finish(403, 'Local preview only.'); return; }
            if (request.method !== 'GET' && request.method !== 'HEAD') { response.setHeader('Allow', 'GET, HEAD'); finish(405, 'Read-only preview.'); return; }
            const rawPath = (request.url ?? '').split('?')[0];
            if (!rawPath.startsWith(prefix)) { finish(404, 'Not found.'); return; }
            if (rawPath === bridgeRoute) {
                const script = `globalThis.__qbxNuiPreviewConfig=${scriptData({ token, resourceName: options.resourceName, origin, prefix })};\n${options.bridgeScript}`;
                response.writeHead(200, { 'Content-Type': MIME['.js'], 'Content-Length': Buffer.byteLength(script) });
                response.end(request.method === 'HEAD' ? undefined : script);
                return;
            }
            let asset: string;
            try { asset = decodeURIComponent(rawPath.slice(prefix.length)); }
            catch { finish(400, 'Invalid asset path.'); return; }
            const segments = localPath(asset);
            if (!segments) { finish(403, 'Asset path is outside the preview directory.'); return; }
            const extension = path.extname(asset).toLowerCase();
            const mime = MIME[extension];
            if (!mime) { finish(403, 'This file type is not served by NUI preview.'); return; }
            const target = await fs.realpath(path.join(directory, ...segments));
            if (disposed || response.destroyed) { return; }
            if (!contained(directory, target)) { finish(403, 'Asset symlink escapes the preview directory.'); return; }
            handle = await fs.open(target, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
            activeHandles.add(handle);
            const stat = await handle.stat();
            const current = await fs.realpath(path.join(directory, ...segments));
            const currentStat = await fs.stat(current);
            if (disposed || response.destroyed) { return; }
            if (!contained(directory, current) || current !== target || currentStat.dev !== stat.dev || currentStat.ino !== stat.ino
                || !stat.isFile()) { finish(403, 'The asset changed or is not a regular file.'); return; }
            if (stat.size > limit(extension)) { finish(413, 'The preview asset exceeds its size limit.'); return; }
            if (extension === '.html' || extension === '.htm' || extension === '.css') {
                const buffer = Buffer.alloc(stat.size + 1);
                let bytesRead = 0;
                while (bytesRead < buffer.length) {
                    const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
                    if (!read.bytesRead) { break; }
                    bytesRead += read.bytesRead;
                    if (disposed || response.destroyed) { return; }
                }
                if (bytesRead > stat.size) { finish(413, 'The text file grew beyond its validated size.'); return; }
                if (disposed || response.destroyed) { return; }
                const base = `${origin}${prefix}${segments.slice(0, -1).map(encodeURIComponent).join('/')}${segments.length > 1 ? '/' : ''}`;
                const content = buffer.subarray(0, bytesRead).toString('utf8');
                const body = extension === '.css' ? rewriteCss(content, prefix) : injectHtml(content, base, origin + bridgeRoute, prefix);
                response.writeHead(200, { 'Content-Type': mime, 'Content-Length': Buffer.byteLength(body) });
                response.end(request.method === 'HEAD' ? undefined : body);
                return;
            }
            let start = 0;
            let end = stat.size - 1;
            if (request.headers.range) {
                const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
                if (!range || (!range[1] && !range[2]) || stat.size === 0
                    || range.slice(1).some((value) => value && !Number.isSafeInteger(Number(value)))) { response.setHeader('Content-Range', `bytes */${stat.size}`); finish(416, 'Unsupported byte range.'); return; }
                if (!range[1]) { start = Math.max(0, stat.size - Number(range[2])); }
                else { start = Number(range[1]); if (range[2]) { end = Math.min(end, Number(range[2])); } }
                if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start < 0 || start >= stat.size) { response.setHeader('Content-Range', `bytes */${stat.size}`); finish(416, 'Unsatisfiable byte range.'); return; }
                response.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
            }
            response.writeHead(request.headers.range ? 206 : 200, { 'Content-Type': mime, 'Content-Length': Math.max(0, end - start + 1), 'Accept-Ranges': 'bytes' });
            if (request.method === 'HEAD' || stat.size === 0) { response.end(); return; }
            await pipeline(handle.createReadStream({ start, end, autoClose: false }), response);
        } catch (error) {
            if (!disposed && !response.destroyed && !response.headersSent) {
                const code = (error as NodeJS.ErrnoException).code;
                finish(code === 'ENOENT' || code === 'ENOTDIR' ? 404 : 403, 'Asset unavailable.');
            } else if (!response.destroyed && !response.writableEnded) { response.destroy(); }
        } finally {
            if (handle) { activeHandles.delete(handle); await handle.close().catch(() => undefined); }
        }
    }

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') { server.close(); throw new Error('Could not open the local preview server.'); }
    origin = `http://127.0.0.1:${address.port}`;
    const filename = path.basename(logicalEntry);
    return {
        url: `${origin}${prefix}${encodeURIComponent(filename)}`, origin, token,
        dispose: () => {
            if (disposed) { return; }
            disposed = true;
            server.close();
            for (const socket of sockets) { socket.destroy(); }
            for (const handle of activeHandles) { void handle.close().catch(() => undefined); }
        },
    };
}
