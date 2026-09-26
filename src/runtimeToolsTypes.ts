export interface LogSourceLink { start: number; end: number; id: string }
export interface RuntimeLogView {
    path: string;
    status: string;
    paused: boolean;
    hasFile: boolean;
    lines: { id: string; text: string; links: LogSourceLink[] }[];
}
export type RuntimeLogMessage = { type: 'state'; data: RuntimeLogView };

export interface HealthResource { name: string; path: string; id: string }
export interface WorkspaceHealthView {
    server: { ok: boolean; message: string };
    files: number;
    resources: number;
    counts: { duplicates: number; missing: number; ambiguous: number };
    issues: {
        kind: 'duplicate' | 'missing' | 'ambiguous';
        name: string;
        resource?: HealthResource;
        targets: HealthResource[];
        targetCount: number;
        kinds: string[];
    }[];
    truncated: number;
    notes: string[];
}
export type WorkspaceHealthMessage = { type: 'loading' } | { type: 'health'; data: WorkspaceHealthView };
