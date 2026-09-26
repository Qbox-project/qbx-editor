import { MAX_JSON_BYTES, MAX_LUA_BYTES, textBytes } from './luaUtilitiesCore';

export interface UtilitySelection<T> { target: T | undefined; name: string | undefined; selection: string }
export interface UtilityActions<T> {
    capture(): UtilitySelection<T>;
    copy(text: string): Promise<void>;
    insert(text: string, target: T | undefined, current: () => boolean): Promise<void>;
}
export type UtilityMessage = { type: 'selection'; text: string; target: string | undefined }
    | { type: 'target'; name: string | undefined }
    | { type: 'complete' | 'error'; requestId: number; message: string };

export class LuaUtilitiesSession<T> {
    private snapshot: UtilitySelection<T> = { target: undefined, name: undefined, selection: '' };
    private generation = 0;
    private disposed = false;
    private busy = false;
    constructor(private readonly post: (message: UtilityMessage) => void, private readonly actions: UtilityActions<T>) { this.capture(); }

    capture(): void {
        if (this.disposed) { return; }
        this.generation++;
        this.snapshot = this.actions.capture();
        this.post({ type: 'target', name: this.snapshot.target === undefined ? undefined : this.snapshot.name });
    }

    async handle(value: unknown): Promise<void> {
        if (this.disposed || !value || typeof value !== 'object' || Array.isArray(value)) { return; }
        const message = value as Record<string, unknown>;
        if (message.type === 'ready') { this.post({ type: 'target', name: this.snapshot.name }); return; }
        const requestId = message.requestId;
        if (!Number.isSafeInteger(requestId) || (requestId as number) < 0) { return; }
        const id = requestId as number;
        if (typeof message.type !== 'string' || !['selection', 'target', 'copy', 'insert'].includes(message.type)) { return; }
        if (this.busy) { this.post({ type: 'error', requestId: id, message: 'Wait for the current action to finish.' }); return; }
        const failure = (reason: unknown): void => { if (!this.disposed) { this.post({ type: 'error', requestId: id, message: reason instanceof Error ? reason.message : String(reason) }); } };
        try {
            if (message.type === 'target' || message.type === 'selection') {
                this.capture();
                if (message.type === 'selection') {
                    if (!this.snapshot.selection) { throw new Error('Select JSON in an editor, then choose Use selection again.'); }
                    if (textBytes(this.snapshot.selection) > MAX_JSON_BYTES) { throw new Error('Select at most 128 KiB of JSON.'); }
                    this.post({ type: 'selection', text: this.snapshot.selection, target: this.snapshot.name });
                }
                this.post({ type: 'complete', requestId: id, message: message.type === 'selection' ? 'Selection loaded.' : 'Insertion target captured.' });
                return;
            }
            if (typeof message.text !== 'string' || !message.text || message.text.length > MAX_LUA_BYTES || textBytes(message.text) > MAX_LUA_BYTES) { throw new Error('Output must contain between 1 byte and 512 KiB of text.'); }
            this.busy = true;
            const generation = this.generation;
            const current = (): boolean => !this.disposed && generation === this.generation;
            if (message.type === 'copy') { await this.actions.copy(message.text); }
            else {
                await this.actions.insert(message.text, this.snapshot.target, current);
                if (current()) { this.snapshot.target = undefined; this.snapshot.name = undefined; this.post({ type: 'target', name: undefined }); }
            }
            if (current()) { this.post({ type: 'complete', requestId: id, message: message.type === 'copy' ? 'Copied.' : 'Inserted. Capture the Lua target again for another insertion.' }); }
        } catch (reason) { failure(reason); }
        finally { this.busy = false; }
    }

    dispose(): void { this.disposed = true; this.generation++; this.snapshot = { target: undefined, name: undefined, selection: '' }; }
}
