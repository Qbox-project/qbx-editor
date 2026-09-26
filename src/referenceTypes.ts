export type ReferenceKind = 'native' | 'control' | 'pedFlag';
export type ReferenceSide = 'client' | 'server' | 'shared';

export interface ReferenceSearchParams {
    query?: string;
    kind?: 'all' | ReferenceKind;
    side?: 'all' | ReferenceSide;
    namespace?: string;
    offset?: number;
    limit?: number;
}

export interface ReferenceItem {
    id: string;
    kind: ReferenceKind;
    name: string;
    side: ReferenceSide;
    namespace?: string;
    hash?: string;
    numericId?: number;
}

export interface ReferenceSearchResult {
    items: ReferenceItem[];
    total: number;
    offset: number;
    limit: number;
    namespaces: string[];
}

export interface ReferenceDetail extends ReferenceItem {
    signature?: string;
    parameters?: { name: string; type: string }[];
    returns?: string[];
    documentation: string;
    sourceUrl: string;
    copyText: string;
    insertText: string;
    insertSnippet?: string;
}

export type ReferenceRequest = <T>(method: string, params: unknown) => Promise<T>;

export type ReferenceHostMessage =
    | { type: 'results'; requestId: number; result: ReferenceSearchResult }
    | { type: 'detail'; requestId: number; detail: ReferenceDetail; links: string[] }
    | { type: 'error'; requestId: number; scope: 'search' | 'detail' | 'action'; message: string }
    | { type: 'actionComplete'; requestId: number; message: string }
    | { type: 'target'; name: string | undefined };

export type ReferenceAction = 'copy' | 'copyHash' | 'insert' | 'source';

export type ReferenceWebviewMessage =
    | { type: 'search'; requestId: number; params: ReferenceSearchParams }
    | { type: 'detail'; requestId: number; id: string }
    | { type: 'action'; requestId: number; id: string; action: ReferenceAction }
    | { type: 'link'; requestId: number; id: string; index: number };
