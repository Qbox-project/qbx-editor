import { createHash } from 'node:crypto';
import type * as vscode from 'vscode';
import type { NuiPreset } from './nuiTypes';

export const MAX_NUI_JSON_BYTES = 64 * 1024;
const MAX_PRESETS = 30;
const MAX_STORE_BYTES = 512 * 1024;
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

export function parseNuiJson(text: string, mocks = false): unknown {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_NUI_JSON_BYTES) { throw new Error('Each JSON field is limited to 64 KiB.'); }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new Error('Enter valid JSON for the message and mock responses.'); }
    if (mocks && (!record(parsed) || Object.keys(parsed).length > 100
        || Object.keys(parsed).some((key) => !key.length || key.length > 256 || /[\x00-\x1f\x7f]/.test(key)))) {
        throw new Error('Mock responses must be an object with at most 100 callback names, each 1–256 printable characters.');
    }
    const pending: { value: unknown; depth: number }[] = [{ value: parsed, depth: 0 }];
    let nodes = 0;
    while (pending.length) {
        const { value, depth } = pending.pop()!;
        if (++nodes > 10000 || depth > 64) { throw new Error('JSON is too deeply nested or has too many values.'); }
        if (value !== null && typeof value === 'object') {
            for (const child of Object.values(value)) { pending.push({ value: child, depth: depth + 1 }); }
        }
    }
    return parsed;
}

export function validateNuiPreset(value: unknown): NuiPreset {
    if (!record(value) || typeof value.name !== 'string' || typeof value.message !== 'string' || typeof value.mocks !== 'string') {
        throw new Error('A preset needs a name, message JSON and mock response JSON.');
    }
    const name = value.name.trim();
    if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) { throw new Error('Preset names must contain 1–80 printable characters.'); }
    parseNuiJson(value.message); parseNuiJson(value.mocks, true);
    return { name, message: value.message, mocks: value.mocks };
}

/** Explicitly saved presets, scoped to the workspace and exact resource URI. */
export class NuiPresetStore {
    private writing = false;
    constructor(private readonly state: vscode.Memento) {}
    private key(uri: string): string { return `qbxLua.nuiPresets.v1.${createHash('sha256').update(uri).digest('hex')}`; }

    load(uri: string): NuiPreset[] {
        const value: unknown = this.state.get(this.key(uri));
        if (value === undefined) { return []; }
        if (!record(value) || value.version !== 1 || !Array.isArray(value.presets) || value.presets.length > MAX_PRESETS) {
            throw new Error('Stored NUI presets are invalid; they have been left unchanged.');
        }
        const presets = value.presets.map(validateNuiPreset);
        if (new Set(presets.map((preset) => preset.name)).size !== presets.length
            || Buffer.byteLength(JSON.stringify(presets)) > MAX_STORE_BYTES) { throw new Error('Stored NUI presets exceed their limits; they have been left unchanged.'); }
        return presets;
    }

    async save(uri: string, value: unknown): Promise<NuiPreset[]> {
        const preset = validateNuiPreset(value);
        return this.write(uri, (presets) => [...presets.filter((item) => item.name !== preset.name), preset].sort((a, b) => a.name.localeCompare(b.name)));
    }

    async remove(uri: string, name: string): Promise<NuiPreset[]> {
        if (!name || name.length > 80) { throw new Error('Choose a saved preset to delete.'); }
        return this.write(uri, (presets) => presets.filter((item) => item.name !== name));
    }

    private async write(uri: string, edit: (presets: NuiPreset[]) => NuiPreset[]): Promise<NuiPreset[]> {
        if (this.writing) { throw new Error('A preset is being saved. Try again when it finishes.'); }
        this.writing = true;
        try {
            const presets = edit(this.load(uri));
            if (presets.length > MAX_PRESETS || Buffer.byteLength(JSON.stringify(presets)) > MAX_STORE_BYTES) {
                throw new Error('A resource can store up to 30 presets and 512 KiB of preset data.');
            }
            await this.state.update(this.key(uri), { version: 1, presets });
            return presets;
        } finally { this.writing = false; }
    }
}
