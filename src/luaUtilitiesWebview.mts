/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { hexColor, joaatHash, jsonToLua, MAX_JSON_BYTES, MAX_LUA_BYTES, rgbColor, textBytes, type LuaColor, type NullMode } from './luaUtilitiesCore.js';

declare function acquireVsCodeApi(): { postMessage(value: unknown): void; getState(): unknown; setState(value: unknown): void };
const vscode = acquireVsCodeApi();
function element<T extends HTMLElement = HTMLElement>(id: string): T { const found = document.getElementById(id); if (!found) { throw new Error(`Missing utility element: ${id}`); } return found as T; }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function bounded(value: unknown, bytes: number, fallback = ''): string { return typeof value === 'string' && value.length <= bytes && textBytes(value) <= bytes ? value : fallback; }
const saved = vscode.getState();
const state = record(saved) ? saved : {};
let tab = typeof state.tab === 'string' && ['hash', 'color', 'json'].includes(state.tab) ? state.tab : 'hash';
let sequence = Number.isSafeInteger(state.sequence) && (state.sequence as number) >= 0 ? state.sequence as number : 0;
let pending: number | undefined;
let target: string | undefined;
let jsonDirty = state.jsonDirty === true;
const hashInput = element<HTMLInputElement>('hash-input');
const hexInput = element<HTMLInputElement>('color-hex');
const picker = element<HTMLInputElement>('color-picker');
const jsonInput = element<HTMLTextAreaElement>('json-input');
const luaOutput = element<HTMLTextAreaElement>('lua-output');
const nullMode = element<HTMLSelectElement>('null-mode');
const channels = ['red', 'green', 'blue', 'alpha'].map((name) => element<HTMLInputElement>(`color-${name}`));
hashInput.value = bounded(state.hash, 4096, 'adder');
jsonInput.value = bounded(state.json, MAX_JSON_BYTES);
luaOutput.value = bounded(state.lua, MAX_LUA_BYTES);
nullMode.value = state.nullMode === 'nil' ? 'nil' : 'json.null';
element('json-warnings').textContent = bounded(state.warnings, 4096);
element('json-warnings').hidden = !element('json-warnings').textContent;
if (luaOutput.value) { element('json-note').textContent = 'Restored editable preview. Copy and Insert use exactly this draft.'; }

function persist(): void {
    vscode.setState({ tab, sequence, hash: bounded(hashInput.value, 4096), hex: hexInput.value, json: bounded(jsonInput.value, MAX_JSON_BYTES),
        lua: bounded(luaOutput.value, MAX_LUA_BYTES), nullMode: nullMode.value, jsonDirty,
        warnings: bounded(element('json-warnings').textContent, 4096) });
}
function notice(message: string, isError = false): void { const status = element('status'); status.textContent = message; status.hidden = !message; status.classList.toggle('error', isError); }
function showError(id: string, message?: string): void { const output = element(id); output.textContent = message ?? ''; output.hidden = !message; }
function action(type: 'copy' | 'insert' | 'selection' | 'target', text?: string): void {
    if (pending !== undefined) { return; }
    if ((type === 'copy' || type === 'insert') && (!text || textBytes(text) > MAX_LUA_BYTES)) { notice('Output must contain between 1 byte and 512 KiB of text.', true); return; }
    pending = ++sequence;
    persist();
    vscode.postMessage({ type, requestId: pending, ...(text === undefined ? {} : { text }) });
    updateButtons();
}
function updateButtons(): void {
    for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-action]')) {
        button.disabled = pending !== undefined || (button.dataset.action === 'insert' && !target);
    }
    const usable = !!luaOutput.value && textBytes(luaOutput.value) <= MAX_LUA_BYTES;
    element<HTMLButtonElement>('copy-lua').disabled = pending !== undefined || !usable;
    element<HTMLButtonElement>('insert-lua').disabled = pending !== undefined || !usable || !target;
    element<HTMLButtonElement>('use-selection').disabled = pending !== undefined;
    element<HTMLButtonElement>('capture-target').disabled = pending !== undefined;
}
function outputs(id: string, rows: [string, string, boolean][]): void {
    const container = element(id);
    container.replaceChildren();
    for (const [label, value, insertable] of rows) {
        const row = document.createElement('div'); row.className = 'output';
        const title = document.createElement('span'); title.className = 'output-label'; title.textContent = label;
        const code = document.createElement('code'); code.textContent = value;
        const buttons = document.createElement('div'); buttons.className = 'actions';
        const copy = document.createElement('button'); copy.textContent = 'Copy'; copy.dataset.action = 'copy'; copy.setAttribute('aria-label', `Copy ${label}`);
        copy.addEventListener('click', () => action('copy', value)); buttons.append(copy);
        if (insertable) {
            const insert = document.createElement('button'); insert.textContent = 'Insert'; insert.dataset.action = 'insert'; insert.setAttribute('aria-label', `Insert ${label}`);
            insert.addEventListener('click', () => action('insert', value)); buttons.append(insert);
        }
        row.append(title, code, buttons); container.append(row);
    }
    updateButtons();
}
function hash(): void {
    try {
        const result = joaatHash(hashInput.value);
        showError('hash-error');
        outputs('hash-results', [['Hex', result.hex, true], ['Signed', result.signed, true], ['Unsigned', result.unsigned, true]]);
    } catch (reason) { showError('hash-error', reason instanceof Error ? reason.message : String(reason)); element('hash-results').replaceChildren(); }
    persist();
}
function color(value: LuaColor, preserveHex = false): void {
    picker.value = value.hex;
    if (!preserveHex) { hexInput.value = value.alpha === 255 ? value.hex : value.hexAlpha; }
    [value.red, value.green, value.blue, value.alpha].forEach((channel, index) => { channels[index].value = String(channel); });
    showError('color-error');
    outputs('color-results', [['Hex', value.hexAlpha, false], ['RGB arguments', value.rgb, true], ['RGBA arguments', value.rgba, true], ['Lua table', value.table, true], ['Lua vector', value.vector, true]]);
    persist();
}
function colorAttempt(parse: () => LuaColor, preserveHex = false): void {
    try { color(parse(), preserveHex); }
    catch (reason) { showError('color-error', reason instanceof Error ? reason.message : String(reason)); element('color-results').replaceChildren(); }
}
function select(next: string): void {
    tab = next;
    for (const name of ['hash', 'color', 'json']) { element(`${name}-panel`).hidden = name !== tab; element(`tab-${name}`).setAttribute('aria-selected', String(name === tab)); }
    persist();
}
function convert(): void {
    try {
        const result = jsonToLua(jsonInput.value, nullMode.value as NullMode);
        luaOutput.value = result.text;
        jsonDirty = false;
        showError('json-error');
        element('json-warnings').textContent = result.warnings.join('\n'); element('json-warnings').hidden = result.warnings.length === 0;
        element('json-note').textContent = 'Converted. Review or edit the preview before copying or inserting it.';
    } catch (reason) {
        showError('json-error', reason instanceof Error ? reason.message : String(reason));
        // Retain the user's editable draft but clearly identify that it is not a new conversion.
        element('json-note').textContent = luaOutput.value ? 'Conversion failed. The preview still contains your previous draft.' : 'Correct the JSON, then convert again.';
    }
    persist(); updateButtons();
}

for (const name of ['hash', 'color', 'json']) { element(`tab-${name}`).addEventListener('click', () => select(name)); }
hashInput.addEventListener('input', hash);
hexInput.addEventListener('input', () => colorAttempt(() => hexColor(hexInput.value), true));
picker.addEventListener('input', () => colorAttempt(() => { const rgb = hexColor(picker.value); return rgbColor(rgb.red, rgb.green, rgb.blue, Number(channels[3].value)); }));
for (const channel of channels) { channel.addEventListener('input', () => colorAttempt(() => {
    if (channels.some((input) => !input.value.trim())) { throw new Error('Enter all four color channels.'); }
    return rgbColor(Number(channels[0].value), Number(channels[1].value), Number(channels[2].value), Number(channels[3].value));
})); }
element('convert').addEventListener('click', convert);
element('copy-lua').addEventListener('click', () => action('copy', luaOutput.value));
element('insert-lua').addEventListener('click', () => action('insert', luaOutput.value));
element('use-selection').addEventListener('click', () => action('selection'));
element('capture-target').addEventListener('click', () => action('target'));
const sourceChanged = (): void => {
    jsonDirty = true;
    element('json-note').textContent = 'JSON or null handling changed. Convert again to update the preview.';
    persist();
};
jsonInput.addEventListener('input', sourceChanged); nullMode.addEventListener('change', sourceChanged);
luaOutput.addEventListener('input', () => {
    element('json-note').textContent = jsonDirty ? 'Preview edited; JSON input also changed. Copy and Insert use exactly this preview.' : 'Preview edited. Copy and Insert use exactly this preview.';
    if (textBytes(luaOutput.value) > MAX_LUA_BYTES) { showError('json-error', 'The edited Lua preview exceeds 512 KiB.'); }
    else { showError('json-error'); }
    persist(); updateButtons();
});
window.addEventListener('message', (event: MessageEvent<unknown>) => {
    // VS Code forwards host messages from its same-origin wrapper, then rewrites window.parent.
    // It is therefore not enough to compare the sender with window or window.parent.
    if (event.source !== null && event.source !== window && event.origin !== window.location.origin) { return; }
    const message = event.data;
    if (!record(message)) { return; }
    if (message.type === 'target') {
        target = typeof message.name === 'string' ? message.name : undefined;
        element('target').textContent = target ?? 'Open a Lua editor and choose Use current Lua selection.';
        updateButtons();
        if (Number.isSafeInteger(message.revision) && (message.revision as number) >= 0) {
            vscode.postMessage({ type: 'targetApplied', revision: message.revision, name: target,
                canInsert: [...document.querySelectorAll<HTMLButtonElement>('button[data-action="insert"]')].some((button) => !button.disabled) });
        }
    } else if (message.type === 'selection' && typeof message.text === 'string' && textBytes(message.text) <= MAX_JSON_BYTES) {
        jsonInput.value = message.text; select('json'); convert();
    } else if ((message.type === 'complete' || message.type === 'error') && message.requestId === pending && typeof message.message === 'string') {
        pending = undefined;
        notice(message.message, message.type === 'error'); updateButtons();
    }
});
// Restore drafts locally; never persist or fabricate editor/selection identities in the webview.
try { color(hexColor(bounded(state.hex, 9, '#0088FF'))); } catch { color(hexColor('#0088FF')); }
select(tab); hash(); updateButtons();
vscode.postMessage({ type: 'ready' });
