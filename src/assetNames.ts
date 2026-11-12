import * as fs from 'node:fs/promises';
import { assetHash } from './assetInventory';

export const MAX_NAME_LIST_BYTES = 16 * 1024 * 1024, MAX_LISTED_NAMES = 500_000;
interface CachedList { stamp: string; names: Map<number, string> }
const cache = new Map<string, CachedList>();

/** Every identifier-like token of a text, JSON or INI name list, keyed by the hash that game files store. */
export function parseNameList(text: string): Map<number, string> {
    const names = new Map<number, string>();
    for (const match of text.matchAll(/[A-Za-z0-9_@.+-]{2,96}/g)) {
        if (names.size >= MAX_LISTED_NAMES) { break; }
        const name = match[0].toLowerCase();
        if (/[a-z]/.test(name)) { names.set(assetHash(name), name); }
    }
    return names;
}

export async function loadNameLists(paths: readonly string[]): Promise<{ names: Map<number, string>; notes: string[] }> {
    const names = new Map<number, string>(), notes: string[] = [];
    for (const file of paths.slice(0, 16)) {
        try {
            const stat = await fs.stat(file), stamp = `${stat.size}:${stat.mtimeMs}`;
            if (!stat.isFile() || stat.size > MAX_NAME_LIST_BYTES) { throw new Error('it is not a file of at most 16 MiB'); }
            let list = cache.get(file);
            if (list?.stamp !== stamp) { list = { stamp, names: parseNameList(await fs.readFile(file, 'utf8')) }; cache.set(file, list); }
            for (const [hash, name] of list.names) { names.set(hash, name); }
        } catch (error) { notes.push(`Name list ${file} was not used: ${error instanceof Error ? error.message : String(error)}.`); }
    }
    return { names, notes };
}
