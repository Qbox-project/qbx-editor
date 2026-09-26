import type { RecipeSnippet, SnippetKind } from './snippetTypes';

export interface SnippetViewState {
    query: string;
    source: 'all' | SnippetKind;
    offset: number;
    selectedId: string;
    showBody: boolean;
}

export function normalizeSnippetViewState(value: unknown): SnippetViewState {
    const state = typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown> : {};
    return {
        query: typeof state.query === 'string' ? state.query.slice(0, 256) : '',
        source: typeof state.source === 'string' && ['all', 'builtin', 'personal', 'workspace'].includes(state.source)
            ? state.source as SnippetViewState['source'] : 'all',
        offset: typeof state.offset === 'number' && Number.isSafeInteger(state.offset) && state.offset >= 0
            ? Math.floor(state.offset / 50) * 50 : 0,
        selectedId: typeof state.selectedId === 'string' ? state.selectedId : '',
        showBody: state.showBody === true,
    };
}

/** Local AND-token search; exact names and prefixes precede other matching text. */
export function filterSnippetCatalog(items: readonly RecipeSnippet[], state: Pick<SnippetViewState, 'query' | 'source'>): RecipeSnippet[] {
    const query = state.query.trim().toLowerCase();
    const tokens = query.split(/\s+/).filter(Boolean);
    function rank(item: RecipeSnippet): number {
        const names = [item.label, ...item.prefix].map((name) => name.toLowerCase());
        return names.includes(query) ? 0 : names.some((name) => name.startsWith(query)) ? 1 : 2;
    }
    return items.filter((item) => {
        if (state.source !== 'all' && item.source !== state.source) { return false; }
        const searchable = [item.label, item.description, ...item.prefix, item.body].join('\n').toLowerCase();
        return tokens.every((token) => searchable.includes(token));
    }).sort((a, b) => (query ? rank(a) - rank(b) : 0) || a.label.localeCompare(b.label) || a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
}

export function snippetPage(items: readonly RecipeSnippet[], offset: number, limit = 50): { items: RecipeSnippet[]; total: number; offset: number } {
    const pageSize = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 50) : 50;
    const requested = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
    const start = Math.min(Math.floor(requested / pageSize), Math.max(0, Math.ceil(items.length / pageSize) - 1)) * pageSize;
    return { items: items.slice(start, start + pageSize), total: items.length, offset: start };
}
