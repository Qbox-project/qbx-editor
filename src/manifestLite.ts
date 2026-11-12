/**
 * A reader for the two kinds of Lua data the resource checks need without the language server: the
 * directives of a resource manifest and the string tables of locale files. It reads tokens and
 * evaluates nothing, so a manifest that computes its values is read only as far as its literals go.
 */

export interface LuaToken { kind: 'name' | 'string' | 'number' | 'symbol'; text: string; line: number }
export interface ManifestValue { text: string; line: number }
export interface ManifestEntry { name: string; line: number; values: ManifestValue[] }

const MAX_TOKENS = 200_000;
const KEYWORDS = new Set(['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while']);
const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', '\\': '\\', '"': '"', "'": "'", '\n': '\n' };

/** The level of the long bracket that opens at `at`, as in `[==[`, or nothing when none does. */
function longBracket(source: string, at: number): number | undefined {
    let end = at + 1;
    while (source[end] === '=') { end++; }
    return source[end] === '[' ? end - at - 1 : undefined;
}

/** The tokens of Lua source with comments dropped, strings unescaped and lines counted from zero. */
export function luaTokens(source: string): LuaToken[] {
    const tokens: LuaToken[] = [];
    let at = 0, line = 0;
    const skipLong = (level: number, from: number): string => {
        const close = `]${'='.repeat(level)}]`, start = from + level + 2, end = source.indexOf(close, start);
        const text = source.slice(start, end < 0 ? source.length : end);
        at = end < 0 ? source.length : end + close.length;
        return text;
    };
    while (at < source.length && tokens.length < MAX_TOKENS) {
        const char = source[at];
        if (char === '\n') { line++; at++; continue; }
        if (char === ' ' || char === '\t' || char === '\r' || char === '﻿') { at++; continue; }
        if (char === '-' && source[at + 1] === '-') {
            const level = source[at + 2] === '[' ? longBracket(source, at + 2) : undefined;
            if (level !== undefined) {
                line += skipLong(level, at + 2).split('\n').length - 1;
            } else {
                const end = source.indexOf('\n', at);
                at = end < 0 ? source.length : end;
            }
            continue;
        }
        if (char === '"' || char === "'") {
            const start = line;
            let text = '';
            at++;
            while (at < source.length && source[at] !== char && source[at] !== '\n') {
                if (source[at] === '\\' && at + 1 < source.length) {
                    const next = source[at + 1];
                    if (next === '\n') { line++; }
                    text += ESCAPES[next] ?? next;
                    at += 2;
                } else {
                    text += source[at++];
                }
            }
            at++;
            tokens.push({ kind: 'string', text, line: start });
            continue;
        }
        if (char === '[') {
            const level = longBracket(source, at);
            if (level !== undefined) {
                const start = line, text = skipLong(level, at);
                line += text.split('\n').length - 1;
                tokens.push({ kind: 'string', text: text.startsWith('\n') ? text.slice(1) : text, line: start });
                continue;
            }
        }
        const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(at, at + 256));
        if (name) {
            tokens.push({ kind: 'name', text: name[0], line });
            at += name[0].length;
            continue;
        }
        const number = /^(?:0[xX][0-9a-fA-F.]+(?:[pP][+-]?[0-9]+)?|[0-9]+\.?[0-9]*(?:[eE][+-]?[0-9]+)?|\.[0-9]+(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(at, at + 64));
        if (number) {
            tokens.push({ kind: 'number', text: number[0], line });
            at += number[0].length;
            continue;
        }
        const symbol = ['...', '..', '==', '~=', '<=', '>=', '::', '//'].find((candidate) => source.startsWith(candidate, at)) ?? char;
        tokens.push({ kind: 'symbol', text: symbol, line });
        at += symbol.length;
    }
    return tokens;
}

function symbol(token: LuaToken | undefined, text: string): boolean {
    return token?.kind === 'symbol' && token.text === text;
}

/**
 * The directives of a manifest in order: `name 'value'`, `name { 'a', 'b' }`, `name('value')` and
 * the curried `data_file 'TYPE' 'path'`. `values` holds the string literals of a directive in the
 * order they are written; the keys of `['key'] = value` entries are left out.
 */
export function parseManifest(source: string): ManifestEntry[] {
    const tokens = luaTokens(source), entries: ManifestEntry[] = [];
    let at = 0;
    const strings = (values: ManifestValue[]): boolean => {
        const token = tokens[at];
        if (token?.kind === 'string') {
            values.push({ text: token.text, line: token.line });
            at++;
            return true;
        }
        const close = symbol(token, '{') ? '}' : symbol(token, '(') ? ')' : undefined;
        if (!close) { return false; }
        let depth = 0;
        do {
            const current = tokens[at];
            if (current.kind === 'symbol' && (current.text === '{' || current.text === '(')) { depth++; }
            else if (current.kind === 'symbol' && (current.text === '}' || current.text === ')')) { depth--; }
            else if (current.kind === 'string' && !(symbol(tokens[at - 1], '[') && symbol(tokens[at + 1], ']'))) { values.push({ text: current.text, line: current.line }); }
            at++;
        } while (depth > 0 && at < tokens.length);
        return true;
    };
    while (at < tokens.length) {
        const token = tokens[at], before = tokens[at - 1], after = tokens[at + 1];
        const callable = token.kind === 'name' && !KEYWORDS.has(token.text)
            && !(before && (symbol(before, '.') || symbol(before, ':') || (before.kind === 'name' && (before.text === 'local' || before.text === 'function'))))
            && after && (after.kind === 'string' || symbol(after, '{') || symbol(after, '('));
        if (!callable) { at++; continue; }
        const entry: ManifestEntry = { name: token.text, line: token.line, values: [] };
        at++;
        while (strings(entry.values)) { /* Each further argument of a curried directive. */ }
        entries.push(entry);
    }
    return entries;
}

/** The values of every directive called one of `names`, such as `file` and `files`. */
export function manifestValues(entries: readonly ManifestEntry[], ...names: string[]): ManifestValue[] {
    return entries.filter((entry) => names.includes(entry.name)).flatMap((entry) => entry.values);
}

export interface LuaString { value: string; line: number }

/**
 * The strings of the tables a Lua file assigns or returns, by dotted key: `error = { missing =
 * 'x' }` yields `error.missing`. This is the shape of locale files (`Locales['en'] = { ... }`,
 * `local Translations = { ... }`, `return { ... }`). Values that are not string literals are left
 * out, and of a concatenation the first literal counts.
 */
export function luaStringTable(source: string): Map<string, LuaString> {
    const tokens = luaTokens(source), found = new Map<string, LuaString>();
    let at = 0;
    const table = (prefix: string, depth: number): void => {
        at++;
        while (at < tokens.length && !symbol(tokens[at], '}')) {
            let key: string | undefined;
            if (tokens[at].kind === 'name' && symbol(tokens[at + 1], '=')) {
                key = tokens[at].text;
                at += 2;
            } else if (symbol(tokens[at], '[') && (tokens[at + 1]?.kind === 'string' || tokens[at + 1]?.kind === 'number') && symbol(tokens[at + 2], ']') && symbol(tokens[at + 3], '=')) {
                key = tokens[at + 1].text;
                at += 4;
            }
            const value = tokens[at];
            if (symbol(value, '{')) {
                if (key !== undefined && depth < 16) { table(`${prefix}${key}.`, depth + 1); } else { skip(); }
            } else if (value?.kind === 'string' && key !== undefined) {
                found.set(prefix + key, { value: value.text, line: value.line });
                at++;
            }
            let nesting = 0;
            while (at < tokens.length && !(nesting === 0 && (symbol(tokens[at], ',') || symbol(tokens[at], ';') || symbol(tokens[at], '}')))) {
                if (symbol(tokens[at], '{') || symbol(tokens[at], '(')) { nesting++; }
                else if (symbol(tokens[at], '}') || symbol(tokens[at], ')')) { nesting--; }
                at++;
            }
            if (symbol(tokens[at], ',') || symbol(tokens[at], ';')) { at++; }
        }
        at++;
    };
    const skip = (): void => {
        let nesting = 0;
        do {
            if (symbol(tokens[at], '{')) { nesting++; } else if (symbol(tokens[at], '}')) { nesting--; }
            at++;
        } while (nesting > 0 && at < tokens.length);
    };
    while (at < tokens.length) {
        const opens = symbol(tokens[at], '{') && (symbol(tokens[at - 1], '=') || (tokens[at - 1]?.kind === 'name' && tokens[at - 1].text === 'return'));
        if (opens) { table('', 0); } else { at++; }
    }
    return found;
}
