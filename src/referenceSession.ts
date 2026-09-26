import type {
    ReferenceAction, ReferenceDetail, ReferenceHostMessage, ReferenceRequest, ReferenceSearchParams, ReferenceSearchResult,
} from './referenceTypes';

export interface ReferenceActions<TTarget> {
    captureInsertionTarget(): TTarget | undefined;
    insert(detail: ReferenceDetail, target: TTarget | undefined, isCurrent: () => boolean): Promise<void>;
    copy(text: string): Promise<void>;
    openExternal(url: string): Promise<void>;
}

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integer(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function validReferenceId(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > 160 || /\s/.test(value)) {
        return false;
    }
    if (/^native:[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
        return true;
    }
    const numeric = /^(?:control|pedFlag):(0|[1-9][0-9]{0,9})$/.exec(value);
    return !!numeric && Number(numeric[1]) <= 0xffffffff;
}

/** Sanitize UI state while enforcing the backend's query limits and fixed page size. */
export function normalizeReferenceSearch(value: unknown): ReferenceSearchParams | undefined {
    if (!record(value)) {
        return undefined;
    }
    const { query = '', kind = 'all', side = 'all', namespace = '', offset = 0 } = value;
    if (typeof query !== 'string' || [...query].length > 256
        || typeof kind !== 'string' || !['all', 'native', 'control', 'pedFlag'].includes(kind)
        || typeof side !== 'string' || !['all', 'client', 'server', 'shared'].includes(side)
        || typeof namespace !== 'string' || namespace.length > 64 || !integer(offset)) {
        return undefined;
    }
    return {
        query, kind: kind as ReferenceSearchParams['kind'],
        side: kind === 'control' || kind === 'pedFlag' ? 'all' : side as ReferenceSearchParams['side'],
        namespace: kind === 'native' ? namespace : '', offset, limit: 50,
    };
}

/** Cfx docs use native hash fragments; all other links must be explicit HTTPS URLs. */
export function normalizeReferenceLink(value: string): string | undefined {
    const nativeHash = /^#\\?_0x([0-9A-Fa-f]{1,16})$/.exec(value);
    if (nativeHash && !/\s/.test(value)) {
        return `https://docs.fivem.net/natives/?_0x${nativeHash[1]}`;
    }
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
    } catch {
        return undefined;
    }
}

/** Only links present in trusted backend documentation can be opened by a webview link index. */
export function referenceLinks(documentation: string, sourceUrl: string): string[] {
    const candidates = [sourceUrl, ...(documentation.match(/https:\/\/[^\s<>"'`\]\[()]+|#\\?_0x[0-9A-Fa-f]{1,16}(?![0-9A-Za-z_])/g) ?? [])];
    return [...new Set(candidates.map((value) => normalizeReferenceLink(value.replace(/[.,;]+$/, ''))).filter((value): value is string => !!value))];
}

/** Message orchestration shared by the VS Code panel and isolated bridge tests. */
export class ReferenceSession<TTarget = unknown> {
    private disposed = false;
    private searchGeneration = 0;
    private detailGeneration = 0;
    private actionGeneration = 0;
    private allowedIds = new Set<string>();
    private selected: ReferenceDetail | undefined;
    private links: string[] = [];

    constructor(
        private readonly request: ReferenceRequest,
        private readonly post: (message: ReferenceHostMessage) => void,
        private readonly actions: ReferenceActions<TTarget>,
    ) {}

    async handle(message: unknown): Promise<void> {
        if (this.disposed || !record(message) || !integer(message.requestId)) {
            return;
        }
        const requestId = message.requestId;
        if (message.type === 'search') {
            const params = normalizeReferenceSearch(message.params);
            if (!params) {
                this.error(requestId, 'search', 'Search is invalid. Use at most 256 characters.');
                return;
            }
            await this.search(requestId, params);
        } else if (message.type === 'detail' && validReferenceId(message.id)) {
            await this.detail(requestId, message.id);
        } else if ((message.type === 'action' || message.type === 'link') && validReferenceId(message.id)) {
            if (!this.selected || message.id !== this.selected.id) {
                return;
            }
            if (message.type === 'link' && integer(message.index) && message.index < this.links.length) {
                await this.action(requestId, 'source', this.links[message.index]);
            } else if (message.type === 'action' && typeof message.action === 'string' && ['copy', 'copyHash', 'insert', 'source'].includes(message.action)) {
                await this.action(requestId, message.action as ReferenceAction);
            }
        }
    }

    dispose(): void {
        this.disposed = true;
        this.allowedIds.clear();
        this.selected = undefined;
        this.links = [];
    }

    private async search(requestId: number, params: ReferenceSearchParams): Promise<void> {
        const generation = ++this.searchGeneration;
        ++this.detailGeneration;
        ++this.actionGeneration;
        this.allowedIds.clear();
        this.selected = undefined;
        this.links = [];
        try {
            const result = await this.request<ReferenceSearchResult>('qbx/referenceSearch', params);
            if (this.disposed || generation !== this.searchGeneration) {
                return;
            }
            if (!result || !Array.isArray(result.items) || !result.items.every((item) => validReferenceId(item.id))
                || !integer(result.total) || !integer(result.offset) || !integer(result.limit) || result.limit < 1
                || !Array.isArray(result.namespaces)) {
                throw new Error('The reference service returned invalid results. Restart Qbox Lua and retry.');
            }
            this.allowedIds = new Set(result.items.map((item) => item.id));
            this.post({ type: 'results', requestId, result });
        } catch (error) {
            if (!this.disposed && generation === this.searchGeneration) {
                this.error(requestId, 'search', this.errorText(error));
            }
        }
    }

    private async detail(requestId: number, id: string): Promise<void> {
        if (!this.allowedIds.has(id)) {
            return;
        }
        const generation = ++this.detailGeneration;
        ++this.actionGeneration;
        this.selected = undefined;
        this.links = [];
        try {
            const detail = await this.request<ReferenceDetail | null>('qbx/referenceDetail', { id });
            if (this.disposed || generation !== this.detailGeneration) {
                return;
            }
            if (!detail || detail.id !== id || typeof detail.documentation !== 'string'
                || typeof detail.sourceUrl !== 'string' || typeof detail.copyText !== 'string' || typeof detail.insertText !== 'string') {
                throw new Error('This reference is no longer available. Refresh the search.');
            }
            this.selected = detail;
            this.links = referenceLinks(detail.documentation, detail.sourceUrl);
            this.post({ type: 'detail', requestId, detail, links: this.links });
        } catch (error) {
            if (!this.disposed && generation === this.detailGeneration) {
                this.error(requestId, 'detail', this.errorText(error));
            }
        }
    }

    private async action(requestId: number, action: ReferenceAction, documentLink?: string): Promise<void> {
        const detail = this.selected;
        if (!detail) {
            return;
        }
        const generation = ++this.actionGeneration;
        const current = () => !this.disposed && generation === this.actionGeneration;
        const target = action === 'insert' ? this.actions.captureInsertionTarget() : undefined;
        try {
            let message: string;
            switch (action) {
                case 'copy':
                    await this.actions.copy(detail.copyText);
                    message = detail.kind === 'native' ? 'Native name copied.' : 'ID copied.';
                    break;
                case 'copyHash':
                    if (detail.kind !== 'native' || !detail.hash || !/^0x[0-9A-Fa-f]+$/.test(detail.hash)) {
                        return;
                    }
                    await this.actions.copy(detail.hash);
                    message = 'Native hash copied.';
                    break;
                case 'source': {
                    const url = documentLink ?? normalizeReferenceLink(detail.sourceUrl);
                    if (!url) {
                        throw new Error('This reference has no supported documentation link.');
                    }
                    await this.actions.openExternal(url);
                    message = 'Documentation opened.';
                    break;
                }
                case 'insert':
                    await this.actions.insert(detail, target, current);
                    message = 'Inserted into Lua file.';
                    break;
            }
            if (current()) {
                this.post({ type: 'actionComplete', requestId, message });
            }
        } catch (error) {
            if (current()) {
                this.error(requestId, 'action', this.errorText(error));
            }
        }
    }

    private error(requestId: number, scope: 'search' | 'detail' | 'action', message: string): void {
        this.post({ type: 'error', requestId, scope, message });
    }

    private errorText(error: unknown): string {
        return error instanceof Error ? error.message : 'The reference service is unavailable. Retry after Qbox Lua starts.';
    }
}
