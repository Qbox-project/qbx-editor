import type {
    ResourceDetails, ResourceDetailsMessage, ResourceDetailsRequest, ResourceDetailsView,
    ResourceIdentity, ResourceLocation, ResourceRelation, ResourceRelationView, ResourceSymbol, ResourceSymbolView,
} from './resourceDetailsTypes';

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string { return typeof value === 'string' && value.length <= 32768; }
function count(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function list<T>(value: unknown, limit: number, valid: (item: unknown) => item is T): value is T[] {
    return Array.isArray(value) && value.length <= limit && value.every(valid);
}
export function validResourceFileUri(value: unknown): value is string {
    if (!text(value) || value.length > 16384) { return false; }
    try {
        const uri = new URL(value);
        return uri.protocol === 'file:' && !uri.search && !uri.hash && !uri.username && !uri.password;
    } catch { return false; }
}
export function validResourceLocation(value: unknown): value is ResourceLocation {
    if (!record(value) || !validResourceFileUri(value.uri) || !record(value.range)) { return false; }
    const { start, end } = value.range;
    return record(start) && record(end)
        && count(start.line) && count(start.character) && count(end.line) && count(end.character)
        && start.line <= 0x7fffffff && start.character <= 0x7fffffff && end.line <= 0x7fffffff && end.character <= 0x7fffffff
        && (end.line > start.line || (end.line === start.line && end.character >= start.character));
}
function identity(value: unknown): value is ResourceIdentity {
    return record(value) && text(value.name) && validResourceFileUri(value.uri) && validResourceFileUri(value.manifestUri);
}
function symbol(value: unknown): value is ResourceSymbol {
    return record(value) && text(value.name) && text(value.kind) && text(value.side)
        && validResourceLocation(value.location) && (value.signature === undefined || text(value.signature));
}
function relation(value: unknown): value is ResourceRelation {
    return record(value) && text(value.name) && list(value.kinds, 8, text)
        && ['resolved', 'missing', 'ambiguous'].includes(value.status as string)
        && list(value.targets, 20, identity) && count(value.targetCount) && value.targetCount >= value.targets.length;
}
export function validResourceDetails(value: unknown): value is ResourceDetails {
    return record(value) && identity(value.resource) && record(value.files) && record(value.counts) && record(value.truncated)
        && ['total', 'client', 'server', 'shared', 'module'].every((key) => count((value.files as Record<string, unknown>)[key]))
        && ['events', 'exports'].every((key) => count((value.counts as Record<string, unknown>)[key]))
        && ['events', 'exports', 'dependencies', 'dependents'].every((key) => count((value.truncated as Record<string, unknown>)[key]))
        && list(value.events, 500, symbol) && list(value.exports, 500, symbol)
        && list(value.dependencies, 200, relation) && list(value.dependents, 200, relation)
        && list(value.constraints, 200, text) && list(value.notes, 50, text);
}

function displayPath(uri: string): string {
    const parsed = new URL(uri);
    try { return decodeURIComponent(parsed.pathname); } catch { return parsed.pathname; }
}

export interface ResourceDetailsActions {
    openSource(location: ResourceLocation, isCurrent: () => boolean): Promise<void>;
    chooseResource(): Promise<string | undefined>;
}

/** Each load replaces the action allowlist; old requests cannot reopen stale resources or files. */
export class ResourceDetailsSession {
    private generation = 0;
    private disposed = false;
    private actionPending = false;
    private uri: string | undefined;
    private current: ResourceDetailsMessage | undefined;
    private readonly sources = new Map<string, ResourceLocation>();
    private readonly resources = new Map<string, string>();

    constructor(
        private readonly request: ResourceDetailsRequest,
        private readonly post: (message: ResourceDetailsMessage) => void,
        private readonly actions: ResourceDetailsActions,
    ) {}

    async show(uri: string): Promise<void> {
        if (this.disposed) { return; }
        const generation = ++this.generation;
        this.clearActions();
        this.uri = undefined;
        if (!validResourceFileUri(uri)) { this.fail('Choose a local resource folder.'); return; }
        this.uri = uri;
        this.emit({ type: 'loading', name: displayPath(uri).split('/').pop() || 'Resource' });
        try {
            const data = await this.request('qbx/resourceDetails', { uri });
            if (!this.isCurrent(generation)) { return; }
            if (!validResourceDetails(data)) { throw new Error('The language server returned invalid resource details.'); }
            const manifestId = `${generation}:manifest`;
            this.sources.set(manifestId, { uri: data.resource.manifestUri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } });
            const symbols = (items: ResourceSymbol[], kind: string): ResourceSymbolView[] => items.map((item, index) => {
                const id = `${generation}:${kind}:${index}`;
                this.sources.set(id, item.location);
                const sourcePath = displayPath(item.location.uri);
                const root = displayPath(data.resource.uri).replace(/\/$/, '') + '/';
                return { id, name: item.name, kind: item.kind, side: item.side, signature: item.signature,
                    source: `${sourcePath.startsWith(root) ? sourcePath.slice(root.length) : sourcePath}:${item.location.range.start.line + 1}` };
            });
            const relations = (items: ResourceRelation[], kind: string): ResourceRelationView[] => items.map((item, index) => ({
                name: item.name, kinds: item.kinds, status: item.status, targetCount: item.targetCount,
                targets: item.targets.map((target, targetIndex) => {
                    const id = `${generation}:${kind}:${index}:${targetIndex}`;
                    this.resources.set(id, target.uri);
                    return { id, name: target.name, path: displayPath(target.uri) };
                }),
            }));
            const view: ResourceDetailsView = {
                resource: { name: data.resource.name, path: displayPath(data.resource.uri), manifestId },
                files: data.files, counts: data.counts, truncated: data.truncated, constraints: data.constraints, notes: data.notes,
                events: symbols(data.events, 'event'), exports: symbols(data.exports, 'export'),
                dependencies: relations(data.dependencies, 'dependency'), dependents: relations(data.dependents, 'dependent'),
            };
            this.emit({ type: 'details', data: view });
        } catch (error) {
            if (this.isCurrent(generation)) { this.fail(error instanceof Error ? error.message : String(error)); }
        }
    }

    async handle(message: unknown): Promise<void> {
        if (this.disposed || !record(message)) { return; }
        if (message.type === 'ready') {
            if (this.current) { this.post(this.current); }
            return;
        }
        if (message.type === 'refresh') {
            if (this.uri && this.current?.type !== 'loading') { await this.show(this.uri); }
            return;
        }
        if (this.actionPending) { return; }
        const generation = this.generation;
        this.actionPending = true;
        try {
            if (message.type === 'choose') {
                const uri = await this.actions.chooseResource();
                if (uri && this.isCurrent(generation)) { await this.show(uri); }
            } else if (message.type === 'openSource' && typeof message.id === 'string') {
                const location = this.sources.get(message.id);
                if (location) { await this.actions.openSource(location, () => this.isCurrent(generation)); }
            } else if (message.type === 'openResource' && typeof message.id === 'string') {
                const uri = this.resources.get(message.id);
                if (uri) { await this.show(uri); }
            }
        } catch (error) {
            if (this.isCurrent(generation)) { this.fail(error instanceof Error ? error.message : String(error)); }
        } finally { this.actionPending = false; }
    }

    dispose(): void { this.disposed = true; ++this.generation; this.clearActions(); this.current = undefined; }
    private isCurrent(generation: number): boolean { return !this.disposed && generation === this.generation; }
    private clearActions(): void { this.sources.clear(); this.resources.clear(); }
    private emit(message: ResourceDetailsMessage): void { this.current = message; this.post(message); }
    private fail(message: string): void { this.clearActions(); this.emit({ type: 'error', message }); }
}
