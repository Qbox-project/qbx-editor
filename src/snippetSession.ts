import type { RecipeSnippet, SnippetCatalog, SnippetHostMessage, SnippetWebviewMessage } from './snippetTypes';

type ManageAction = Extract<SnippetWebviewMessage, { type: 'manage' }>['action'];

export interface SnippetActions<TTarget> {
    captureInsertionTarget(): TTarget | undefined;
    insert(item: RecipeSnippet, target: TTarget | undefined, isCurrent: () => boolean): Promise<void>;
    copy(text: string): Promise<void>;
    edit(item: RecipeSnippet, isCurrent: () => boolean): Promise<void>;
    duplicate(item: RecipeSnippet, target: TTarget | undefined, isCurrent: () => boolean): Promise<boolean>;
    manage(action: ManageAction, target: TTarget | undefined, isCurrent: () => boolean): Promise<boolean>;
}

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Only catalog entries held by the host can be used for file, clipboard or editor actions. */
export class SnippetSession<TTarget = unknown> {
    private disposed = false;
    private loadGeneration = 0;
    private actionGeneration = 0;
    private busy = false;
    private items = new Map<string, RecipeSnippet>();

    constructor(
        private readonly load: () => Promise<SnippetCatalog>,
        private readonly post: (message: SnippetHostMessage) => void,
        private readonly actions: SnippetActions<TTarget>,
    ) {}

    async handle(message: unknown): Promise<void> {
        if (this.disposed || !record(message) || !Number.isSafeInteger(message.requestId)
            || typeof message.requestId !== 'number' || message.requestId < 0) { return; }
        const requestId = message.requestId;
        if (message.type === 'load') {
            const generation = ++this.loadGeneration;
            this.items.clear();
            try {
                const catalog = await this.load();
                if (this.disposed || generation !== this.loadGeneration) { return; }
                this.items = new Map(catalog.items.map((item) => [item.id, item]));
                this.post({ type: 'catalog', requestId, catalog });
            } catch (error) {
                if (!this.disposed && generation === this.loadGeneration) { this.error(requestId, error); }
            }
            return;
        }
        const action = message.action;
        if (typeof action !== 'string') { return; }
        const item = typeof message.id === 'string' ? this.items.get(message.id) : undefined;
        const recognizedItemAction = message.type === 'action' && typeof message.id === 'string' && ['copy', 'insert', 'edit', 'duplicate'].includes(action);
        if (recognizedItemAction && !item) {
            this.error(requestId, new Error('This snippet is no longer available. Refresh the browser and try again.'));
            return;
        }
        const isItemAction = recognizedItemAction && item;
        const isManageAction = message.type === 'manage' && ['new', 'personal', 'workspace', 'saveSelection'].includes(action);
        if (!isItemAction && !isManageAction) { return; }
        if (this.busy) {
            this.error(requestId, new Error('Finish the current snippet action first.'));
            return;
        }
        if (isItemAction && action === 'edit' && item.source === 'builtin') { return; }
        this.busy = true;
        const generation = ++this.actionGeneration;
        const current = () => !this.disposed && generation === this.actionGeneration;
        const target = this.actions.captureInsertionTarget();
        try {
            let result = 'Done.';
            if (isItemAction) {
                switch (action) {
                    case 'copy': await this.actions.copy(item.body); result = 'Snippet syntax copied.'; break;
                    case 'insert': await this.actions.insert(item, target, current); result = 'Snippet inserted into Lua file.'; break;
                    case 'edit': await this.actions.edit(item, current); result = 'Snippet JSON opened.'; break;
                    case 'duplicate': result = await this.actions.duplicate(item, target, current) ? 'Snippet saved.' : 'Cancelled.'; break;
                }
            } else {
                result = await this.actions.manage(action as ManageAction, target, current) ? 'Done.' : 'Cancelled.';
            }
            if (current()) { this.post({ type: 'actionComplete', requestId, message: result }); }
        } catch (error) {
            if (current()) { this.error(requestId, error); }
        } finally {
            this.busy = false;
        }
    }

    invalidate(): void {
        if (this.disposed) { return; }
        ++this.loadGeneration;
        this.items.clear();
        this.post({ type: 'invalidate' });
    }

    dispose(): void {
        this.disposed = true;
        ++this.actionGeneration;
        ++this.loadGeneration;
        this.items.clear();
    }

    private error(requestId: number, error: unknown): void {
        this.post({ type: 'error', requestId, message: error instanceof Error ? error.message : 'Could not load or update snippets. Try again.' });
    }
}
