import { parseTree, printParseErrorCode, type Node, type ParseError } from 'jsonc-parser';

export const MAX_JSON_BYTES = 128 * 1024;
export const MAX_LUA_BYTES = 512 * 1024;
const encoder = new TextEncoder();
export function textBytes(text: string): number { return encoder.encode(text).length; }

export interface HashResult { hex: string; signed: string; unsigned: string }
/** Cfx luaO_HashString: https://github.com/citizenfx/lua/blob/luaglm-dev/cfx/lglm.cpp
 * ASCII only: the upstream char/tolower implementation does not define portable Unicode casing.
 */
export function joaatHash(input: string): HashResult {
    if (input.length > 4096) { throw new Error('Hash input is limited to 4,096 characters.'); }
    if (/[^\x20-\x7e]/.test(input)) { throw new Error('Use printable ASCII asset names. Non-ASCII casing and embedded controls are not portable across Cfx runtimes.'); }
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
        const code = input.charCodeAt(i);
        hash = (hash + (code >= 65 && code <= 90 ? code + 32 : code)) >>> 0;
        hash = (hash + (hash << 10)) >>> 0;
        hash = (hash ^ (hash >>> 6)) >>> 0;
    }
    hash = (hash + (hash << 3)) >>> 0;
    hash = (hash ^ (hash >>> 11)) >>> 0;
    hash = (hash + (hash << 15)) >>> 0;
    return { hex: `0x${hash.toString(16).toUpperCase().padStart(8, '0')}`, signed: String(hash | 0), unsigned: String(hash) };
}

export interface LuaColor { red: number; green: number; blue: number; alpha: number; hex: string; hexAlpha: string; rgb: string; rgba: string; table: string; vector: string }
export function rgbColor(red: number, green: number, blue: number, alpha = 255): LuaColor {
    const channels = [red, green, blue, alpha];
    if (channels.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) { throw new Error('Color channels must be whole numbers between 0 and 255.'); }
    const hex = '#' + channels.slice(0, 3).map((value) => value.toString(16).padStart(2, '0')).join('').toUpperCase();
    return { red, green, blue, alpha, hex, hexAlpha: hex + alpha.toString(16).padStart(2, '0').toUpperCase(),
        rgb: `${red}, ${green}, ${blue}`, rgba: `${red}, ${green}, ${blue}, ${alpha}`,
        table: `{ r = ${red}, g = ${green}, b = ${blue}, a = ${alpha} }`, vector: `vec3(${red}, ${green}, ${blue})` };
}
export function hexColor(input: string): LuaColor {
    let value = input.trim().replace(/^#/, '');
    if (!/^(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) { throw new Error('Enter #RGB, #RGBA, #RRGGBB or #RRGGBBAA.'); }
    if (value.length <= 4) { value = [...value].map((character) => character + character).join(''); }
    const channels = value.match(/../g)!.map((channel) => parseInt(channel, 16));
    return rgbColor(channels[0], channels[1], channels[2], channels[3] ?? 255);
}

const reserved = new Set('and break do else elseif end false for function goto if in local nil not or repeat return then true until while'.split(' '));
export function luaString(value: string): string {
    // Reject unpaired UTF-16 surrogates rather than replacing them during UTF-8 editor writes.
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(++i);
            if (!(next >= 0xdc00 && next <= 0xdfff)) { throw new Error('JSON strings contain an unpaired Unicode surrogate.'); }
        } else if (code >= 0xdc00 && code <= 0xdfff) { throw new Error('JSON strings contain an unpaired Unicode surrogate.'); }
    }
    let result = '"';
    for (const character of value) {
        const code = character.codePointAt(0)!;
        if (character === '"' || character === '\\') { result += '\\' + character; }
        else if (character === '\n') { result += '\\n'; }
        else if (character === '\r') { result += '\\r'; }
        else if (character === '\t') { result += '\\t'; }
        else if (code < 32 || (code >= 127 && code <= 159) || (code >= 0x2028 && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) { result += `\\u{${code.toString(16)}}`; }
        else { result += character; }
    }
    return result + '"';
}

export interface LuaConversion { text: string; warnings: string[] }
export type NullMode = 'json.null' | 'nil';
/** Preserve number tokens directly; never round source data through JavaScript JSON.parse. */
export function jsonToLua(input: string, nullMode: NullMode = 'json.null'): LuaConversion {
    if (nullMode !== 'json.null' && nullMode !== 'nil') { throw new Error('Choose json.null or nil for JSON null values.'); }
    if (input.length > MAX_JSON_BYTES || textBytes(input) > MAX_JSON_BYTES) { throw new Error('JSON input is limited to 128 KiB.'); }
    let nesting = 0;
    let quoted = false;
    for (let i = 0; i < input.length; i++) {
        const character = input[i];
        if (quoted) { if (character === '\\') { i++; } else if (character === '"') { quoted = false; } }
        else if (character === '"') { quoted = true; }
        else if (character === '[' || character === '{') { if (++nesting > 64) { throw new Error('JSON is limited to 64 nesting levels.'); } }
        else if (character === ']' || character === '}') { nesting--; }
    }
    const errors: ParseError[] = [];
    const tree = parseTree(input, errors, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false });
    if (!tree || errors.length) {
        const first = errors[0];
        throw new Error(first ? `Invalid JSON at character ${first.offset + 1}: ${printParseErrorCode(first.error)}.` : 'Enter JSON to convert.');
    }
    const warnings = new Set<string>();
    let nodes = 0;
    let outputLength = 0;
    const add = (text: string): string => {
        outputLength += text.length;
        if (outputLength > MAX_LUA_BYTES) { throw new Error('The Lua result exceeds 512 KiB.'); }
        return text;
    };
    const render = (node: Node, depth: number): string => {
        if (++nodes > 10000 || depth > 64) { throw new Error('JSON is limited to 10,000 values and 64 nesting levels.'); }
        switch (node.type) {
            case 'string': return add(luaString(node.value as string));
            case 'boolean': return add(node.value ? 'true' : 'false');
            case 'null':
                warnings.add(nullMode === 'nil' ? 'nil removes object keys and creates holes in arrays; Lua length and ipairs stop behaving like JSON arrays.' : 'JSON null uses the FiveM json.null sentinel; keep the json global available.');
                return add(nullMode);
            case 'number': {
                const raw = input.slice(node.offset, node.offset + node.length);
                if (/^-?\d+$/.test(raw)) {
                    if (raw.replace(/^-/, '').length > 19) { throw new Error('An integer is outside Lua’s signed 64-bit range. Encode it as a JSON string.'); }
                    const integer = BigInt(raw);
                    if (integer < -9223372036854775808n || integer > 9223372036854775807n) { throw new Error(`Integer ${raw.slice(0, 64)} is outside Lua’s signed 64-bit range. Encode it as a JSON string.`); }
                    // -9223372036854775808 is lexed as an overflowing positive literal before unary minus.
                    return add(integer === -9223372036854775808n ? '(-9223372036854775807 - 1)' : raw === '-0' ? '-0.0' : raw);
                }
                const number = Number(raw);
                if (!Number.isFinite(number) || (number === 0 && /[1-9]/.test(raw.split(/[eE]/)[0]))) { throw new Error('A JSON number overflows or underflows Lua floating-point range. Encode it as a JSON string.'); }
                if (Number.isInteger(number) && !Number.isSafeInteger(number)) { throw new Error('A decimal/exponent number exceeds exact floating-point integer precision. Use a plain 64-bit integer or a JSON string.'); }
                warnings.add('Decimal and exponent tokens are preserved verbatim; Lua uses binary floating-point precision for these values.');
                return add(raw);
            }
            case 'array': case 'object': {
                const children = node.children ?? [];
                if (!children.length) { return add('{}'); }
                const seen = new Set<string>();
                const indent = '    '.repeat(depth + 1);
                const fields = children.map((child, index) => {
                    let key: string;
                    let value = child;
                    if (node.type === 'object') {
                        const [property, entry] = child.children!;
                        const name = property.value as string;
                        if (seen.has(name)) { throw new Error(`Duplicate JSON key ${luaString(name).slice(0, 80)}. Resolve it before converting.`); }
                        seen.add(name);
                        key = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !reserved.has(name) ? name : `[${luaString(name)}]`;
                        value = entry;
                    } else { key = `[${index + 1}]`; }
                    return add(`${indent}${key} = `) + render(value, depth + 1) + add(',');
                });
                return add('{\n') + fields.join('\n') + add(`\n${'    '.repeat(depth)}}`);
            }
            default: throw new Error('Unsupported JSON value.');
        }
    };
    const text = render(tree, 0);
    if (textBytes(text) > MAX_LUA_BYTES) { throw new Error('The Lua result exceeds 512 KiB.'); }
    return { text, warnings: [...warnings] };
}
