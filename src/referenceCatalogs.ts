import type { ReferenceDetail, ReferenceItem, ReferenceRequest, ReferenceSearchParams, ReferenceSearchResult } from './referenceTypes';

export const CATALOG_KINDS = ['blip', 'blipColor', 'marker', 'ped', 'vehicle', 'weapon'] as const;
export type CatalogKind = typeof CATALOG_KINDS[number];

/** `data/reference-catalogs.json`, which `scripts/update-reference-catalogs.mjs` writes. */
export interface CatalogData {
    source: { repository: string; revision: string; committedAt: string; pages: Record<string, string> };
    blip: [id: number, name: string][];
    blipColor: [id: number, name: string, color: string][];
    marker: [id: number, name: string][];
    ped: [name: string, group: string][];
    weapon: [name: string, label: string, group: string, model: string, dlc: string][];
    vehicle: [name: string, label: string, group: string][];
}

interface Entry { item: ReferenceItem; text: string; detail: () => ReferenceDetail }

export function isCatalogKind(value: unknown): value is CatalogKind {
    return typeof value === 'string' && (CATALOG_KINDS as readonly string[]).includes(value);
}

/** The Jenkins one-at-a-time hash the game identifies models and weapons by, as an unsigned number. */
function joaat(value: string): number {
    let hash = 0;
    for (const byte of Buffer.from(value.toLowerCase(), 'utf8')) {
        hash = (hash + byte) >>> 0;
        hash = (hash + (hash << 10)) >>> 0;
        hash ^= hash >>> 6;
    }
    hash = (hash + (hash << 3)) >>> 0;
    hash ^= hash >>> 11;
    return (hash + (hash << 15)) >>> 0;
}

function hex(value: number): string {
    return `0x${value.toString(16).toUpperCase().padStart(8, '0')}`;
}

/**
 * The catalogs the extension bundles beside the natives, controls and ped flags of the language
 * server: blip sprites and colours, marker types, and the names of ped, vehicle and weapon models.
 */
export class ReferenceCatalogs {
    private readonly entries: Entry[] = [];
    private readonly byId = new Map<string, Entry>();

    constructor(data: CatalogData) {
        const page = (kind: string) => data.source.pages[kind] ?? data.source.pages.blip ?? '';
        const add = (item: ReferenceItem, text: string, detail: Omit<ReferenceDetail, keyof ReferenceItem>): void => {
            const entry: Entry = { item, text: `${item.name} ${item.label ?? ''} ${item.numericId ?? ''} ${text}`.toLowerCase(), detail: () => ({ ...item, ...detail }) };
            this.entries.push(entry);
            this.byId.set(item.id, entry);
        };
        const numbered = (kind: 'blip' | 'blipColor' | 'marker', id: number, name: string, documentation: string): void => {
            add({ id: `${kind}:${id}`, kind, name, side: 'client', numericId: id }, '', { documentation, sourceUrl: page(kind === 'blipColor' ? 'blip' : kind), copyText: String(id), insertText: String(id) });
        };
        for (const [id, name] of data.blip) {
            numbered('blip', id, name, `Blip sprite **${id}**.\n\n\`\`\`lua\nSetBlipSprite(blip, ${id}) -- ${name}\n\`\`\``);
        }
        for (const [id, name, color] of data.blipColor) {
            numbered('blipColor', id, name || `Colour ${id}`, `Blip colour **${id}**, shown as \`${color}\`.\n\n\`\`\`lua\nSetBlipColour(blip, ${id})${name ? ` -- ${name}` : ''}\n\`\`\``);
        }
        for (const [id, name] of data.marker) {
            numbered('marker', id, name, `Marker type **${id}**, the first argument of \`DrawMarker\`.\n\n\`\`\`lua\nDrawMarker(${id}, x, y, z, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 255, 255, 255, 150, false, false, 2, false, nil, nil, false)\n\`\`\``);
        }
        const model = (kind: 'ped' | 'vehicle' | 'weapon', name: string, label: string | undefined, group: string, lines: string[]): void => {
            const hash = joaat(name);
            add({ id: `${kind}:${name}`, kind, name, side: 'shared', label, namespace: group }, group, {
                documentation: [...lines, `Hash \`${hex(hash)}\` (\`${hash}\`). In CfxLua, \`\` \`${name}\` \`\` is that hash.`].join('\n\n'),
                sourceUrl: page(kind), copyText: name, insertText: `\`${name}\``,
            });
        };
        for (const [name, group] of data.ped) { model('ped', name, undefined, group, [`Ped model in the group **${group}**.`]); }
        for (const [name, label, group] of data.vehicle) { model('vehicle', name, label, group, [`**${label}**, a vehicle model of the class **${group}**.`]); }
        for (const [name, label, group, weaponModel, dlc] of data.weapon) {
            model('weapon', name, label, group, [`**${label}**, a weapon of the **${group}**.`, `World model \`${weaponModel}\`, from the \`${dlc}\` content.`]);
        }
    }

    /** The entries of `kind`, or of every catalog, that hold each word of the query; exact names and IDs lead. */
    matches(query: string, kind: CatalogKind | 'all'): ReferenceItem[] {
        const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
        const whole = query.trim().toLowerCase();
        const rank = (entry: Entry): number => entry.item.name.toLowerCase() === whole || String(entry.item.numericId) === whole ? 0
            : entry.item.name.toLowerCase().startsWith(whole) || (entry.item.label ?? '').toLowerCase().startsWith(whole) ? 1 : 2;
        const found = this.entries.filter((entry) => (kind === 'all' || entry.item.kind === kind) && tokens.every((token) => entry.text.includes(token)));
        return (tokens.length === 0 ? found : found.map((entry, index) => ({ entry, index, rank: rank(entry) })).sort((a, b) => a.rank - b.rank || a.index - b.index).map(({ entry }) => entry))
            .map((entry) => entry.item);
    }

    detail(id: string): ReferenceDetail | undefined {
        return this.byId.get(id)?.detail();
    }
}

/**
 * `request` with the bundled catalogs added to the reference methods: a search of one catalog and
 * the details of its entries are answered here, and a search of everything lists the entries of
 * the catalogs after those of the language server.
 */
export function withCatalogs(request: ReferenceRequest, load: () => Promise<ReferenceCatalogs>): ReferenceRequest {
    return (async (method: string, params: unknown) => {
        if (method === 'qbx/referenceDetail') {
            const id = (params as { id?: unknown } | null)?.id;
            return typeof id === 'string' && isCatalogKind(id.slice(0, id.indexOf(':'))) ? (await load()).detail(id) ?? null : request(method, params);
        }
        if (method !== 'qbx/referenceSearch') { return request(method, params); }
        const search = params as ReferenceSearchParams;
        const offset = search.offset ?? 0, limit = search.limit ?? 50;
        if (isCatalogKind(search.kind)) {
            const items = (await load()).matches(search.query ?? '', search.kind);
            return { items: items.slice(offset, offset + limit), total: items.length, offset, limit, namespaces: [] } satisfies ReferenceSearchResult;
        }
        const result = await request<ReferenceSearchResult>(method, params);
        const everything = (search.kind ?? 'all') === 'all' && (search.side ?? 'all') === 'all' && !search.namespace;
        if (!everything || !result || !Array.isArray(result.items) || typeof result.total !== 'number') { return result; }
        const items = (await load()).matches(search.query ?? '', 'all');
        const room = Math.max(0, limit - result.items.length), start = Math.max(0, offset + result.items.length - result.total);
        return { ...result, items: [...result.items, ...(room > 0 ? items.slice(start, start + room) : [])], total: result.total + items.length };
    }) as ReferenceRequest;
}
