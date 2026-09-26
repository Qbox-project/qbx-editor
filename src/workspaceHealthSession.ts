import { validResourceFileUri } from './resourceDetailsSession';
import type { ResourceIdentity, ResourceLocation } from './resourceDetailsTypes';
import type { HealthResource, WorkspaceHealthMessage, WorkspaceHealthView } from './runtimeToolsTypes';

interface HealthIssue {
    kind: 'duplicate' | 'missing' | 'ambiguous'; name: string; resource?: ResourceIdentity;
    targets: ResourceIdentity[]; targetCount: number; kinds: string[];
}
export type WorkspaceHealthRequest = (method: 'qbx/workspaceHealth', params: Record<string, never>) => Promise<unknown>;
export interface WorkspaceHealth {
    files: number; resources: number;
    counts: { duplicates: number; missing: number; ambiguous: number };
    issues: HealthIssue[]; truncated: number; notes: string[];
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function count(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function text(value: unknown): value is string { return typeof value === 'string' && value.length <= 32768; }
function identity(value: unknown): value is ResourceIdentity {
    return record(value) && text(value.name) && validResourceFileUri(value.uri) && validResourceFileUri(value.manifestUri);
}
export function validWorkspaceHealth(value: unknown): value is WorkspaceHealth {
    return record(value) && count(value.files) && count(value.resources) && record(value.counts)
        && count(value.counts.duplicates) && count(value.counts.missing) && count(value.counts.ambiguous)
        && count(value.truncated) && Array.isArray(value.notes) && value.notes.length <= 50 && value.notes.every(text)
        && Array.isArray(value.issues) && value.issues.length <= 500 && value.issues.every((issue: unknown) =>
            record(issue) && ['duplicate', 'missing', 'ambiguous'].includes(issue.kind as string) && text(issue.name)
            && (issue.resource === undefined || identity(issue.resource))
            && Array.isArray(issue.targets) && issue.targets.length <= 20 && issue.targets.every(identity)
            && count(issue.targetCount) && issue.targetCount >= issue.targets.length
            && Array.isArray(issue.kinds) && issue.kinds.length <= 8 && issue.kinds.every(text));
}

export class WorkspaceHealthSession {
    private generation = 0;
    private disposed = false;
    private loading = false;
    private opening = false;
    private current: WorkspaceHealthMessage | undefined;
    private readonly sources = new Map<string, ResourceLocation>();

    constructor(private readonly request: WorkspaceHealthRequest, private readonly post: (message: WorkspaceHealthMessage) => void,
        private readonly openSource: (location: ResourceLocation, isCurrent: () => boolean) => Promise<void>,
        private readonly showOutput: () => void) {}

    async refresh(): Promise<void> {
        if (this.disposed) { return; }
        const generation = ++this.generation;
        this.loading = true;
        this.sources.clear();
        this.emit({ type: 'loading' });
        try {
            const result = await this.request('qbx/workspaceHealth', {});
            if (!this.isCurrent(generation)) { return; }
            if (!validWorkspaceHealth(result)) { throw new Error('The language server returned an invalid health report.'); }
            const resource = (value: ResourceIdentity): HealthResource => {
                const id = `${generation}:${this.sources.size}`;
                this.sources.set(id, { uri: value.manifestUri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } });
                const parsed = new URL(value.uri);
                let display = `${parsed.host ? `//${parsed.host}` : ''}${parsed.pathname}`;
                try { display = decodeURIComponent(display); } catch { /* Keep encoded display text. */ }
                return { name: value.name, path: display, id };
            };
            this.emit({ type: 'health', data: {
                server: { ok: true, message: 'Language server responding · current index snapshot' },
                files: result.files, resources: result.resources, counts: result.counts, truncated: result.truncated, notes: result.notes,
                issues: result.issues.map((issue) => ({ ...issue, resource: issue.resource && resource(issue.resource), targets: issue.targets.map(resource) })),
            } });
        } catch (error) {
            if (this.isCurrent(generation)) {
                this.sources.clear();
                const data: WorkspaceHealthView = { server: { ok: false, message: `Health report unavailable: ${error instanceof Error ? error.message : String(error)}` },
                    files: 0, resources: 0, counts: { duplicates: 0, missing: 0, ambiguous: 0 }, issues: [], truncated: 0,
                    notes: ['Use Qbox Lua: Restart Language Server or Show Language Server Output to investigate, then refresh.'] };
                this.emit({ type: 'health', data });
            }
        } finally { if (this.isCurrent(generation)) { this.loading = false; } }
    }

    async handle(message: unknown): Promise<void> {
        if (this.disposed || !record(message)) { return; }
        if (message.type === 'ready') { if (this.current) { this.post(this.current); } return; }
        if (message.type === 'refresh') { if (!this.loading) { await this.refresh(); } return; }
        if (message.type === 'output') { this.showOutput(); return; }
        if (message.type !== 'openSource' || typeof message.id !== 'string' || this.opening) { return; }
        const location = this.sources.get(message.id);
        const generation = this.generation;
        if (!location) { return; }
        this.opening = true;
        try { await this.openSource(location, () => this.isCurrent(generation)); }
        finally { this.opening = false; }
    }
    dispose(): void { this.disposed = true; ++this.generation; this.sources.clear(); this.current = undefined; }
    private isCurrent(generation: number): boolean { return !this.disposed && generation === this.generation; }
    private emit(message: WorkspaceHealthMessage): void { this.current = message; this.post(message); }
}
