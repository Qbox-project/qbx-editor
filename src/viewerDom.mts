/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

export function element<T extends HTMLElement = HTMLElement>(id: string): T {
    const value = document.getElementById(id);
    if (!value) { throw new Error(`Missing viewer element ${id}`); }
    return value as T;
}
export function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
    const value = document.createElement(tag);
    if (text !== undefined) { value.textContent = text; }
    if (className) { value.className = className; }
    return value;
}
export function button(label: string, onClick: () => void, title?: string): HTMLButtonElement {
    const value = node('button', label);
    value.type = 'button';
    if (title) { value.title = title; }
    value.addEventListener('click', (event) => { event.stopPropagation(); onClick(); });
    return value;
}
export function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
export function tokens(value: string): string[] { return value.trim().toLowerCase().split(/\s+/).filter(Boolean); }
export function matches(text: string, query: readonly string[]): boolean { const lower = text.toLowerCase(); return query.every((token) => lower.includes(token)); }
export function themeColor(name: string, fallback: string): string { return getComputedStyle(document.body).getPropertyValue(name).trim() || fallback; }
export function facts(rows: readonly { name: string; value: string }[], className = 'facts'): HTMLDListElement {
    const list = node('dl', undefined, className);
    list.append(...rows.flatMap((row) => [node('dt', row.name), node('dd', row.value)]));
    return list;
}
/** Messages are accepted only from the extension host that owns this webview. */
export function fromHost(event: MessageEvent): boolean { return event.source === null || event.source === window || event.origin === window.location.origin; }

export interface Pager<T> { render(rows: readonly T[]): void; reset(): void }
export function pager<T>(ids: { body: string; previous: string; next: string; range: string }, size: number, noun: string,
    row: (item: T) => HTMLTableRowElement, selected: (item: T) => boolean, select: (item: T) => void): Pager<T> {
    let offset = 0, current: readonly T[] = [];
    const body = element(ids.body), previous = element<HTMLButtonElement>(ids.previous), next = element<HTMLButtonElement>(ids.next);
    function render(rows: readonly T[] = current): void {
        current = rows;
        offset = Math.min(offset, Math.max(0, Math.ceil(rows.length / size) - 1) * size);
        const page = rows.slice(offset, offset + size);
        body.replaceChildren(...page.map((item, index) => {
            const line = row(item);
            line.tabIndex = 0; line.setAttribute('aria-selected', String(selected(item)));
            line.addEventListener('click', () => select(item));
            line.addEventListener('keydown', (event) => {
                const target = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? page.length - 1 : -1;
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(item); }
                else if (target >= 0 && target < page.length) { event.preventDefault(); (body.children[target] as HTMLElement).focus(); }
            });
            return line;
        }));
        previous.disabled = offset === 0; next.disabled = offset + page.length >= rows.length;
        element(ids.range).textContent = rows.length ? `${(offset + 1).toLocaleString()}–${(offset + page.length).toLocaleString()} of ${rows.length.toLocaleString()} ${noun}` : `No matching ${noun}`;
    }
    previous.addEventListener('click', () => { offset = Math.max(0, offset - size); render(); });
    next.addEventListener('click', () => { offset += size; render(); });
    return { render, reset: () => { offset = 0; } };
}
