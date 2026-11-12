import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { luaStringTable } from './manifestLite';

export interface LocaleEntry { value: string; line?: number }
export interface LocaleFile { language: string; file: string; entries: Map<string, LocaleEntry>; problem?: string }
export interface LocaleGap { key: string; languages: string[]; text: string; line?: number }

export interface LocaleMatrix {
    /** The language the others are compared with: `en` where there is one, else the one with the most keys. */
    base: LocaleFile | undefined;
    files: LocaleFile[];
    /** Keys of the base language that other languages lack. */
    missing: LocaleGap[];
    /** Keys whose `%s`, `%d` or `%{name}` placeholders differ from the base language. */
    placeholders: LocaleGap[];
    /** Per language, the keys the base language does not have. */
    extra: Map<string, string[]>;
}

const LOCALE_FOLDERS = ['locales', 'locale'];
const MAX_LOCALE_BYTES = 4 * 1024 * 1024;
const MAX_LOCALE_FILES = 200;
const PLACEHOLDER = /%(?:\{\w+\}|[-+ #0]*\d*(?:\.\d+)?[sdifgxXcq])/g;

function flattenJson(value: unknown, prefix: string, out: Map<string, LocaleEntry>, depth = 0): void {
    if (typeof value === 'string') {
        out.set(prefix.slice(0, -1), { value });
    } else if (value && typeof value === 'object' && !Array.isArray(value) && depth < 16) {
        for (const [key, inner] of Object.entries(value)) { flattenJson(inner, `${prefix}${key}.`, out, depth + 1); }
    }
}

/** The line of each JSON key, by the last part of its dotted name. Good enough to land next to it. */
function jsonLines(source: string, entries: Map<string, LocaleEntry>): void {
    const lines = source.split('\n');
    const seen = new Map<string, number>();
    lines.forEach((text, line) => {
        const key = /^\s*"((?:[^"\\]|\\.)*)"\s*:/.exec(text)?.[1];
        if (key !== undefined && !seen.has(key)) { seen.set(key, line); }
    });
    for (const [name, entry] of entries) {
        entry.line = seen.get(name) ?? seen.get(name.slice(name.lastIndexOf('.') + 1));
    }
}

/** Reads one locale file: flat or nested JSON, or a Lua file that assigns or returns a table of strings. */
export async function readLocaleFile(file: string): Promise<LocaleFile> {
    const locale: LocaleFile = { language: path.basename(file, path.extname(file)), file, entries: new Map() };
    try {
        if ((await fs.stat(file)).size > MAX_LOCALE_BYTES) { throw new Error('the file is larger than 4 MiB'); }
        const source = await fs.readFile(file, 'utf8');
        if (path.extname(file).toLowerCase() === '.json') {
            flattenJson(JSON.parse(source.charCodeAt(0) === 0xfeff ? source.slice(1) : source), '', locale.entries);
            jsonLines(source, locale.entries);
        } else {
            for (const [key, entry] of luaStringTable(source)) { locale.entries.set(key, entry); }
        }
    } catch (error) {
        locale.problem = error instanceof Error ? error.message : String(error);
    }
    return locale;
}

/** The locale files of the resource at `root`: `.json` and `.lua` files directly in `locales` or `locale`. */
export async function readLocales(root: string): Promise<LocaleFile[]> {
    const files: string[] = [];
    for (const folder of LOCALE_FOLDERS) {
        const entries = await fs.readdir(path.join(root, folder), { withFileTypes: true }).catch(() => []);
        files.push(...entries.filter((entry) => entry.isFile() && /\.(json|lua)$/i.test(entry.name)).map((entry) => path.join(root, folder, entry.name)));
    }
    return Promise.all(files.sort().slice(0, MAX_LOCALE_FILES).map(readLocaleFile));
}

function placeholders(text: string): string {
    return (text.match(PLACEHOLDER) ?? []).sort().join(' ');
}

/** Compares the locale files of one resource with their base language. */
export function localeMatrix(files: readonly LocaleFile[]): LocaleMatrix {
    const readable = files.filter((file) => !file.problem && file.entries.size > 0);
    const base = readable.find((file) => file.language.toLowerCase() === 'en') ?? [...readable].sort((a, b) => b.entries.size - a.entries.size)[0];
    const matrix: LocaleMatrix = { base, files: [...files], missing: [], placeholders: [], extra: new Map() };
    if (!base) { return matrix; }
    const others = readable.filter((file) => file !== base);
    for (const [key, entry] of base.entries) {
        const lacking = others.filter((file) => !file.entries.has(key)).map((file) => file.language);
        if (lacking.length > 0) { matrix.missing.push({ key, languages: lacking, text: entry.value, line: entry.line }); }
        const expected = placeholders(entry.value);
        const differing = others.filter((file) => file.entries.has(key) && placeholders(file.entries.get(key)!.value) !== expected).map((file) => file.language);
        if (differing.length > 0) { matrix.placeholders.push({ key, languages: differing, text: entry.value, line: entry.line }); }
    }
    for (const file of others) {
        const extra = [...file.entries.keys()].filter((key) => !base.entries.has(key));
        if (extra.length > 0) { matrix.extra.set(file.language, extra); }
    }
    return matrix;
}
