export interface ResourceIdentity {
    name: string;
    uri: string;
    manifestUri: string;
}

export interface ResourceLocation {
    uri: string;
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
}

export interface ResourceSymbol {
    name: string;
    kind: string;
    side: string;
    location: ResourceLocation;
    signature?: string;
}

export interface ResourceRelation {
    name: string;
    kinds: string[];
    status: 'resolved' | 'missing' | 'ambiguous';
    targets: ResourceIdentity[];
    targetCount: number;
}

/** Read-only language-server snapshot. Counts are exact for the index; arrays are bounded. */
export interface ResourceDetails {
    resource: ResourceIdentity;
    files: { total: number; client: number; server: number; shared: number; module: number };
    counts: { events: number; exports: number };
    events: ResourceSymbol[];
    exports: ResourceSymbol[];
    dependencies: ResourceRelation[];
    dependents: ResourceRelation[];
    constraints: string[];
    notes: string[];
    truncated: { events: number; exports: number; dependencies: number; dependents: number };
}

export type ResourceDetailsRequest = (method: 'qbx/resourceDetails', params: { uri: string }) => Promise<unknown>;

export interface ResourceSymbolView extends Omit<ResourceSymbol, 'location'> {
    id: string;
    source: string;
}

export interface ResourceTargetView { id: string; name: string; path: string }

export interface ResourceRelationView extends Omit<ResourceRelation, 'targets'> {
    targets: ResourceTargetView[];
}

/** Webviews receive opaque action IDs rather than filesystem URI authority. */
export interface ResourceDetailsView extends Omit<ResourceDetails, 'resource' | 'events' | 'exports' | 'dependencies' | 'dependents'> {
    resource: { name: string; path: string; manifestId: string };
    events: ResourceSymbolView[];
    exports: ResourceSymbolView[];
    dependencies: ResourceRelationView[];
    dependents: ResourceRelationView[];
}

export type ResourceDetailsMessage =
    | { type: 'loading'; name: string }
    | { type: 'details'; data: ResourceDetailsView }
    | { type: 'error'; message: string };
