/** `native`, `control` and `pedFlag` come from the language server; the others from the catalogs the extension bundles. */
export type ReferenceKind = 'native' | 'control' | 'pedFlag' | 'blip' | 'blipColor' | 'marker' | 'ped' | 'vehicle' | 'weapon';
export const REFERENCE_KINDS: readonly ReferenceKind[] = ['native', 'control', 'pedFlag', 'blip', 'blipColor', 'marker', 'ped', 'vehicle', 'weapon'];
export const REFERENCE_KIND_LABELS: Readonly<Record<ReferenceKind, string>> = {
    native: 'Native', control: 'Control', pedFlag: 'Ped config flag', blip: 'Blip', blipColor: 'Blip colour', marker: 'Marker',
    ped: 'Ped model', vehicle: 'Vehicle model', weapon: 'Weapon',
};
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
    /** The name people know a catalog entry by, such as `Adder` for the model `adder`. */
    label?: string;
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
