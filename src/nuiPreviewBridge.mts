/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

// Runs only inside the separate-origin sandboxed preview frame. No game/Lua code is executed.
interface PreviewConfig { token: string; resourceName: string; origin: string; prefix: string }
const globals = globalThis as typeof globalThis & { __qbxNuiPreviewConfig?: PreviewConfig; GetParentResourceName?: () => string };
const config = globals.__qbxNuiPreviewConfig;
delete globals.__qbxNuiPreviewConfig;
if (!config) { throw new Error('Missing NUI preview configuration.'); }
const { token, resourceName, origin, prefix } = config;
globals.GetParentResourceName = () => resourceName;
const MAX_TEXT = 8192;
const mocks = new Map<string, string>();
const nativeFetch = window.fetch.bind(window);
let dispatching = false;
let activityWindow = 0;
let activityCount = 0;
let configured = false;
let configuredResolve: () => void = () => undefined;
const configuration = new Promise<void>((resolve) => { configuredResolve = resolve; });
const configurationTimeout = setTimeout(() => { configured = true; configuredResolve(); }, 2000);

function text(value: unknown): string {
    try { return (typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)).slice(0, MAX_TEXT); }
    catch { return '[unserializable value]'; }
}

function post(message: Record<string, unknown>): void {
    const now = Date.now();
    if (now - activityWindow >= 1000) { activityWindow = now; activityCount = 0; }
    if (message.type !== 'ready' && activityCount++ >= 100) { return; }
    window.parent.postMessage({ channel: 'qbx-nui', token, ...message }, '*');
}

function error(message: unknown): void { post({ type: 'error', message: text(message) }); }

window.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (dispatching || event.source !== window.parent || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) { return; }
    const message = event.data as Record<string, unknown>;
    if (message.channel !== 'qbx-nui' || message.token !== token) { return; }
    if (message.type === 'configure' || message.type === 'message') { event.stopImmediatePropagation(); }
    if (message.type === 'configure' && message.mocks && typeof message.mocks === 'object' && !Array.isArray(message.mocks)) {
        const next = new Map<string, string>();
        let size = 0;
        for (const [name, value] of Object.entries(message.mocks).slice(0, 100)) {
            if (!name || name.length > 256 || /[\x00-\x1f\x7f]/.test(name)) { continue; }
            try {
                const json = JSON.stringify(value);
                if (json === undefined || json.length > 65536 || size + json.length > 65536) { continue; }
                next.set(name, json);
                size += json.length;
            } catch { /* Only serializable JSON mock values are accepted. */ }
        }
        mocks.clear();
        for (const [name, value] of next) { mocks.set(name, value); }
        configured = true;
        clearTimeout(configurationTimeout);
        configuredResolve();
    } else if (message.type === 'message') {
        dispatching = true;
        try { window.dispatchEvent(new MessageEvent('message', { data: message.data, source: window.parent })); }
        finally { dispatching = false; }
    }
});

function callbackName(url: URL): string | undefined {
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname.toLowerCase() !== resourceName.toLowerCase() || url.port || url.username || url.password) { return undefined; }
    try {
        const name = decodeURIComponent(url.pathname.slice(1));
        return name && name.length <= 256 && !/[\x00-\x1f\x7f]/.test(name) ? name : undefined;
    } catch { return undefined; }
}

function assetUrl(url: URL): URL {
    if (url.origin !== origin || url.username || url.password) { throw new TypeError('NUI preview blocks external network requests.'); }
    if (!url.pathname.startsWith(prefix)) { url.pathname = prefix + url.pathname.replace(/^\/+/, ''); }
    return url;
}

function responseFor(name: string, request: string): string {
    const matched = mocks.has(name);
    const response = mocks.get(name) ?? JSON.stringify({ error: 'No mock response configured' });
    post({ type: 'callback', name, request: request.slice(0, MAX_TEXT), response: response.slice(0, MAX_TEXT), matched });
    return response;
}

function bodyText(body: Document | XMLHttpRequestBodyInit | null | undefined): string {
    if (body == null) { return ''; }
    if (typeof body === 'string') { return body.slice(0, MAX_TEXT); }
    if (body instanceof URLSearchParams) { return body.toString().slice(0, MAX_TEXT); }
    if (body instanceof FormData) {
        const entries: Record<string, string> = Object.create(null) as Record<string, string>;
        let count = 0;
        for (const [name, value] of body) {
            if (++count > 20) { break; }
            entries[name.slice(0, 256)] = typeof value === 'string' ? value.slice(0, 512) : `[file: ${value.name.slice(0, 256)}]`;
        }
        return text(entries);
    }
    if (body instanceof ArrayBuffer) { return new TextDecoder().decode(new Uint8Array(body, 0, Math.min(body.byteLength, MAX_TEXT))); }
    if (ArrayBuffer.isView(body)) { return new TextDecoder().decode(new Uint8Array(body.buffer, body.byteOffset, Math.min(body.byteLength, MAX_TEXT))); }
    if (body instanceof Blob) { return `[Blob: ${body.size} bytes]`; }
    return '[Document]';
}

async function requestText(input: RequestInfo | URL, init?: RequestInit): Promise<string> {
    if (init?.body instanceof Blob) { return (await init.body.slice(0, MAX_TEXT).text()).slice(0, MAX_TEXT); }
    if (init?.body !== undefined && !(init.body instanceof ReadableStream)) { return bodyText(init.body); }
    if (!(input instanceof Request) || !input.body) { return ''; }
    const reader = input.clone().body?.getReader();
    if (!reader) { return ''; }
    const decoder = new TextDecoder();
    let result = '';
    let bytes = 0;
    try {
        while (bytes < MAX_TEXT) {
            const chunk = await reader.read();
            if (chunk.done) { break; }
            const view = chunk.value.subarray(0, MAX_TEXT - bytes);
            result += decoder.decode(view, { stream: true });
            bytes += view.length;
        }
        return (result + decoder.decode()).slice(0, MAX_TEXT);
    } finally { void reader.cancel().catch(() => undefined); }
}

window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input), document.baseURI);
    const name = callbackName(url);
    if (name !== undefined) {
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        if (signal?.aborted) { throw new DOMException('The request was aborted.', 'AbortError'); }
        const request = await requestText(input, init);
        if (!configured) { await configuration; }
        if (signal?.aborted) { throw new DOMException('The request was aborted.', 'AbortError'); }
        return new Response(responseFor(name, request), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }
    try {
        const asset = assetUrl(url).href;
        return await nativeFetch(input instanceof Request ? new Request(asset, input) : asset, init);
    } catch (reason) { error(reason instanceof Error ? reason.message : reason); throw reason; }
};

const NativeXHR = window.XMLHttpRequest;
class PreviewXHR extends NativeXHR {
    private mockName: string | undefined;
    private mockUrl = '';
    private mockState = 0;
    private mockStatus = 0;
    private mockBody = '';
    private mockType: XMLHttpRequestResponseType = '';
    private mockAsync = true;
    private mockSent = false;
    private generation = 0;

    override open(method: string, url: string | URL, async = true, username?: string | null, password?: string | null): void {
        const parsed = new URL(String(url), document.baseURI);
        const name = callbackName(parsed);
        this.generation++;
        if (this.mockName === undefined) { super.abort(); }
        this.mockName = name;
        if (name === undefined) { super.open(method, assetUrl(parsed).href, async, username, password); return; }
        this.mockUrl = parsed.href;
        this.mockState = 1;
        this.mockStatus = 0;
        this.mockBody = '';
        this.mockType = '';
        this.mockAsync = async;
        this.mockSent = false;
        this.dispatchEvent(new Event('readystatechange'));
    }

    override get readyState(): number { return this.mockName === undefined ? super.readyState : this.mockState; }
    override get status(): number { return this.mockName === undefined ? super.status : this.mockStatus; }
    override get statusText(): string { return this.mockName === undefined ? super.statusText : this.mockStatus === 200 ? 'OK' : ''; }
    override get responseURL(): string { return this.mockName === undefined ? super.responseURL : this.mockState >= 2 ? this.mockUrl : ''; }
    override get responseType(): XMLHttpRequestResponseType { return this.mockName === undefined ? super.responseType : this.mockType; }
    override set responseType(value: XMLHttpRequestResponseType) {
        if (this.mockName === undefined) { super.responseType = value; }
        else { if (this.mockSent) { throw new DOMException('The request was sent.', 'InvalidStateError'); } this.mockType = value; }
    }
    override get responseText(): string {
        if (this.mockName === undefined) { return super.responseText; }
        if (this.mockType && this.mockType !== 'text') { throw new DOMException('Response is not text.', 'InvalidStateError'); }
        return this.mockState >= 3 ? this.mockBody : '';
    }
    override get response(): unknown {
        if (this.mockName === undefined) { return super.response; }
        if (!this.mockType || this.mockType === 'text') { return this.mockState >= 3 ? this.mockBody : ''; }
        if (this.mockState !== 4 || this.mockStatus !== 200) { return null; }
        if (this.mockType === 'json') { return JSON.parse(this.mockBody) as unknown; }
        if (this.mockType === 'arraybuffer') { return new TextEncoder().encode(this.mockBody).buffer; }
        if (this.mockType === 'blob') { return new Blob([this.mockBody], { type: 'application/json' }); }
        return null;
    }
    override get responseXML(): Document | null { return this.mockName === undefined ? super.responseXML : null; }
    override setRequestHeader(name: string, value: string): void {
        if (this.mockName === undefined) { super.setRequestHeader(name, value); return; }
        if (this.mockState !== 1 || this.mockSent) { throw new DOMException('The request is not open.', 'InvalidStateError'); }
    }
    override getResponseHeader(name: string): string | null {
        return this.mockName === undefined ? super.getResponseHeader(name) : this.mockState >= 2 && name.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null;
    }
    override getAllResponseHeaders(): string {
        return this.mockName === undefined ? super.getAllResponseHeaders() : this.mockState >= 2 ? 'content-type: application/json; charset=utf-8\r\n' : '';
    }
    override overrideMimeType(mime: string): void { if (this.mockName === undefined) { super.overrideMimeType(mime); } }
    override send(body?: Document | XMLHttpRequestBodyInit | null): void {
        if (this.mockName === undefined) { super.send(body); return; }
        if (this.mockState !== 1 || this.mockSent) { throw new DOMException('The request is not open.', 'InvalidStateError'); }
        this.mockSent = true;
        const generation = this.generation;
        const name = this.mockName;
        const request = bodyText(body);
        this.dispatchEvent(new ProgressEvent('loadstart'));
        const finish = (): void => {
            if (generation !== this.generation || !this.mockSent) { return; }
            this.mockBody = responseFor(name, request);
            this.mockStatus = 200;
            for (const state of [2, 3, 4]) {
                if (generation !== this.generation) { return; }
                this.mockState = state;
                this.dispatchEvent(new Event('readystatechange'));
            }
            if (generation !== this.generation) { return; }
            this.mockSent = false;
            const progress = { lengthComputable: true, loaded: this.mockBody.length, total: this.mockBody.length };
            this.dispatchEvent(new ProgressEvent('progress', progress));
            if (generation !== this.generation) { return; }
            this.dispatchEvent(new ProgressEvent('load', progress));
            if (generation === this.generation) { this.dispatchEvent(new ProgressEvent('loadend', progress)); }
        };
        if (this.mockAsync) { if (configured) { queueMicrotask(finish); } else { void configuration.then(finish); } }
        else { finish(); }
    }
    override abort(): void {
        if (this.mockName === undefined) { super.abort(); return; }
        this.generation++;
        const sent = this.mockSent;
        this.mockSent = false;
        this.mockBody = '';
        this.mockStatus = 0;
        this.mockState = sent ? 4 : 0;
        if (sent) {
            this.dispatchEvent(new Event('readystatechange'));
            this.dispatchEvent(new ProgressEvent('abort'));
            this.dispatchEvent(new ProgressEvent('loadend'));
        }
        this.mockState = 0;
    }
}
window.XMLHttpRequest = PreviewXHR;
post({ type: 'configureRequest' });
window.addEventListener('error', (event) => error(event.message || 'A preview asset could not be loaded.'), true);
window.addEventListener('unhandledrejection', (event) => error(event.reason instanceof Error ? event.reason.message : event.reason));
const ready = (): void => post({ type: 'ready' });
if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', ready, { once: true }); }
else { queueMicrotask(ready); }
