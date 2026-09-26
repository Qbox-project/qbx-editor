import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { inspectResourceHeader } from './assetFormats';
import type { AssetCategory, AssetDeclaration, AssetEntry, AssetIssue, AssetReference } from './assetTypes';

export const MAX_INVENTORY_FILES = 5000;
const EXCLUDED = new Set(['.git', 'node_modules', 'vendor', '.vscode-test', '.svn']);
const TYPES: Record<string, AssetCategory> = {
    '.ytd': 'texture', '.dds': 'texture', '.ydr': 'model', '.ydd': 'model', '.yft': 'model', '.ybn': 'model',
    '.ymap': 'map', '.ytyp': 'map', '.ymt': 'map', '.ynv': 'map', '.ynd': 'map', '.ypt': 'map',
    '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.gif': 'image', '.bmp': 'image', '.svg': 'image',
    '.wav': 'audio', '.mp3': 'audio', '.ogg': 'audio', '.m4a': 'audio', '.awc': 'audio',
    '.webm': 'video', '.mp4': 'video', '.meta': 'metadata', '.xml': 'metadata', '.json': 'metadata', '.ycd': 'other', '.yld': 'other',
};
export function assetHash(value: string): number {
    if (/[^\x00-\x7f]/.test(value)) { throw new Error('Name hashes are available for ASCII asset names only.'); }
    let hash = 0;
    for (const byte of Buffer.from(value.toLowerCase(), 'utf8')) {
        hash = (hash + byte) >>> 0; hash = (hash + (hash << 10)) >>> 0; hash ^= hash >>> 6;
    }
    hash = (hash + (hash << 3)) >>> 0; hash ^= hash >>> 11; return (hash + (hash << 15)) >>> 0;
}
export function assetContained(root: string, filename: string): boolean {
    const relative = path.relative(root, filename);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
function relativePath(value: string): string {
    if (!value || value.includes('\0') || value.includes('\\') || value.startsWith('/') || /^[a-z]:/i.test(value)
        || value.split('/').some((part) => !part || part === '.' || part === '..')) { throw new Error('Choose a file inside the resource.'); }
    return value;
}
/** Read a bounded, stable regular file, resolving containment again after opening it. */
export async function readAssetBytes(root: string, relative: string, limit: number, headerOnly = false): Promise<Buffer> {
    const canonicalRoot = await fs.realpath(root);
    const logical = path.join(canonicalRoot, ...relativePath(relative).split('/'));
    const canonical = await fs.realpath(logical);
    if (!assetContained(canonicalRoot, canonical)) { throw new Error('The asset resolves outside the selected resource.'); }
    const handle = await fs.open(canonical, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    try {
        const stat = await handle.stat();
        const current = await fs.realpath(logical);
        const currentStat = await fs.stat(current);
        if (!stat.isFile() || current !== canonical || !assetContained(canonicalRoot, current)
            || stat.dev !== currentStat.dev || stat.ino !== currentStat.ino) { throw new Error('The asset changed or is not a regular file.'); }
        if (!headerOnly && stat.size > limit) { throw new Error(`This asset exceeds the ${Math.floor(limit / 1024 / 1024)} MiB inspection limit.`); }
        const bytes = Buffer.alloc(Math.min(stat.size, limit));
        let offset = 0;
        while (offset < bytes.length) {
            const read = await handle.read(bytes, offset, bytes.length - offset, offset);
            if (!read.bytesRead) { throw new Error('The asset was truncated while being read.'); }
            offset += read.bytesRead;
        }
        return bytes;
    } finally { await handle.close(); }
}
export interface AssetInventory { root: string; entries: AssetEntry[]; files: Set<string>; directories: Set<string>; issues: AssetIssue[]; notes: string[]; incomplete: boolean; skippedDirectories: string[]; matchingBudget: number }
export async function inventoryAssets(root: string, isCurrent = () => true): Promise<AssetInventory> {
    const canonical = await fs.realpath(root);
    if (!(await fs.stat(canonical)).isDirectory()) { throw new Error('Choose an existing resource directory.'); }
    const result: AssetInventory = { root: canonical, entries: [], files: new Set(), directories: new Set(['']), issues: [], notes: [], incomplete: false, skippedDirectories: [], matchingBudget: 32_000_000 };
    const queue = [{ relative: '', depth: 0 }];
    let visited = 0, links = 0;
    while (queue.length && isCurrent()) {
        const current = queue.shift()!;
        const directory = path.join(canonical, current.relative);
        let children: import('node:fs').Dirent[];
        try {
            const resolved = await fs.realpath(directory);
            if (!assetContained(canonical, resolved)) { result.incomplete = true; result.notes.push(`Skipped a directory outside the resource: ${current.relative}`); continue; }
            children = await fs.readdir(resolved, { withFileTypes: true });
            if (await fs.realpath(directory) !== resolved) { result.incomplete = true; result.notes.push(`Directory changed during the scan: ${current.relative}`); continue; }
        }
        catch { result.incomplete = true; result.notes.push(`Could not read directory: ${current.relative || '.'}`); continue; }
        children.sort((a, b) => a.name.localeCompare(b.name));
        for (const child of children) {
            if (!isCurrent()) { break; }
            if (++visited > 20_000 || result.files.size >= MAX_INVENTORY_FILES) { result.incomplete = true; break; }
            const relative = current.relative ? `${current.relative}/${child.name}` : child.name;
            if (child.isSymbolicLink()) { links++; continue; }
            if (child.isDirectory()) {
                if (EXCLUDED.has(child.name.toLowerCase()) || child.name.startsWith('.')) { result.skippedDirectories.push(relative); continue; }
                result.directories.add(relative);
                if (current.depth >= 20) { result.incomplete = true; continue; }
                queue.push({ relative, depth: current.depth + 1 });
            } else if (child.isFile()) {
                result.files.add(relative);
                const extension = path.extname(child.name).toLowerCase();
                const category = TYPES[extension];
                if (!category) { continue; }
                try {
                    const filename = await fs.realpath(path.join(canonical, relative));
                    if (!assetContained(canonical, filename)) { result.incomplete = true; continue; }
                    const stat = await fs.stat(filename);
                    if (!stat.isFile()) { result.incomplete = true; continue; }
                    const name = child.name.slice(0, -extension.length);
                    const entry: AssetEntry = { id: String(result.entries.length), path: relative, name,
                        category, extension, size: stat.size, hash: /^[\x00-\x7f]*$/.test(name) ? assetHash(name) : undefined, format: extension.slice(1).toUpperCase(), issues: [] };
                    if (!stat.size) { entry.issues.push('File is empty.'); }
                    if (extension.startsWith('.y') || extension === '.dds') {
                        const header = await readAssetBytes(canonical, relative, 160, true);
                        if (extension === '.dds') {
                            if (header.length < 128 || header.toString('latin1', 0, 4) !== 'DDS ' || header.readUInt32LE(4) !== 124 || header.readUInt32LE(76) !== 32) { entry.issues.push('Invalid or truncated DDS header.'); }
                        } else {
                            const info = inspectResourceHeader(header);
                            entry.format = info.container + (info.version !== undefined ? ` v${info.version}` : '');
                            if (info.container === 'Unrecognized') { entry.issues.push('Unknown container header; format validation is unavailable.'); }
                            if (info.container === 'RSC7' && (!info.systemBytes || (info.systemBytes + (info.graphicsBytes ?? 0)) > 128 * 1024 * 1024)) { entry.issues.push('Resource pages are empty or exceed the bounded inspection limit.'); }
                        }
                    }
                    result.entries.push(entry);
                } catch (error) {
                    result.issues.push({ severity: 'warning', message: `Could not inspect ${relative}: ${error instanceof Error ? error.message : String(error)}` });
                }
            }
        }
        if (result.incomplete && (visited > 20_000 || result.files.size >= MAX_INVENTORY_FILES)) { break; }
    }
    if (!isCurrent()) { throw new Error('Asset scan was superseded.'); }
    if (result.incomplete) { result.notes.push('Inventory is partial: at most 5,000 files, 20,000 entries and 20 directory levels are scanned. Unmatched declarations cannot be confirmed missing.'); }
    if (links) { result.notes.push(`${links} symbolic links were skipped; their contents are not checked.`); result.incomplete = true; }
    result.notes.push('Checks cover this resource only. Game archives and other resources are not searched. Binary header checks do not validate complete models or map payloads.');
    const streamed = new Map<string, AssetEntry[]>();
    for (const entry of result.entries) {
        for (const message of entry.issues) { result.issues.push({ severity: message.startsWith('Unknown') ? 'info' : 'warning', message: `${entry.path}: ${message}`, assetId: entry.id }); }
        if (entry.path.toLowerCase().startsWith('stream/')) {
            const key = entry.name.toLowerCase() + entry.extension;
            streamed.set(key, [...(streamed.get(key) ?? []), entry]);
        }
    }
    for (const entries of streamed.values()) {
        if (entries.length > 1) { for (const entry of entries) { result.issues.push({ severity: 'warning', assetId: entry.id, message: `Duplicate streamed asset name: ${entry.path} (${entries.length} files).` }); } }
    }
    return result;
}
// FiveM path globs: '*' and '?' stay within a folder; '**/' also matches zero folders. Brackets are literal.
export function assetGlobMatches(pattern: string, filename: string): boolean {
    if (pattern.length > 4096 || filename.length > 4096 || pattern.length * filename.length > 1_000_000) { return false; }
    let previous = new Uint8Array(filename.length + 1);
    previous[0] = 1;
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        let wildcard = c === '*' ? 'star' : c === '?' ? 'question' : 'literal';
        if (c === '*' && pattern[i + 1] === '*') {
            i++;
            if (pattern[i + 1] === '/') { i++; wildcard = 'directories'; } else { wildcard = 'globstar'; }
        }
        const next = new Uint8Array(filename.length + 1);
        if (wildcard === 'star' || wildcard === 'globstar' || wildcard === 'directories') { next[0] = previous[0]; }
        let prefix = previous[0];
        for (let j = 1; j <= filename.length; j++) {
            const char = filename[j - 1];
            if (wildcard === 'star' || wildcard === 'globstar') { next[j] = previous[j] || (next[j - 1] && (wildcard === 'globstar' || char !== '/') ? 1 : 0); }
            else if (wildcard === 'directories') { next[j] = previous[j] || (prefix && char === '/' ? 1 : 0); }
            else { next[j] = previous[j - 1] && (wildcard === 'question' ? char !== '/' : char === c) ? 1 : 0; }
            prefix ||= previous[j];
        }
        previous = next;
    }
    return previous[filename.length] === 1;
}
export function declarationTargets(declaration: AssetDeclaration, inventory: AssetInventory): { matches: string[]; note?: string; missing?: boolean; unverified?: boolean } {
    const value = declaration.value.replace(/\\/g, '/');
    if (value.startsWith('@')) { return { matches: [], note: 'Reference to another resource; not checked by this resource scan.' }; }
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) { return { matches: [], note: 'External URI; not checked by the local inventory.' }; }
    if (value.startsWith('/') || value.split('/').includes('..')) { return { matches: [], note: 'Path escapes the resource; not followed.', missing: true }; }
    const pattern = value.replace(/^\.\//, '');
    const candidates = declaration.dataType === 'AUDIO_WAVEPACK' ? inventory.directories : inventory.files;
    const comparison = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;
    const matchPattern = comparison(pattern);
    const fixedPrefix = matchPattern.split(/[?*]/)[0];
    let incomplete = inventory.incomplete || inventory.skippedDirectories.some((directory) => matchPattern === comparison(directory) || matchPattern.startsWith(comparison(directory) + '/')
        || (/[?*]/.test(pattern) && comparison(directory).startsWith(fixedPrefix)));
    const matches: string[] = [];
    if (!/[?*]/.test(pattern)) {
        if (candidates.has(pattern)) { matches.push(pattern); }
        else if (process.platform === 'win32') { const actual = [...candidates].find((candidate) => comparison(candidate) === matchPattern); if (actual) { matches.push(actual); } }
    }
    else {
        for (const filename of candidates) {
            const matchFilename = comparison(filename);
            if (!matchFilename.startsWith(fixedPrefix)) { continue; }
            const cost = pattern.length * filename.length;
            if (cost > 1_000_000 || cost > inventory.matchingBudget) { incomplete = true; break; }
            inventory.matchingBudget -= cost;
            if (assetGlobMatches(matchPattern, matchFilename)) { matches.push(filename); }
        }
    }
    return { matches, missing: !matches.length && !incomplete, unverified: !matches.length && incomplete,
        note: !matches.length && incomplete ? 'Not found within scan coverage or matching budget; existence is unverified.'
            : !/[?*]/.test(pattern) && matches.length && matches[0] !== pattern ? 'Filename casing differs; use the exact on-disk spelling for Linux servers.' : undefined };
}
export function referenceTargets(reference: AssetReference, entries: AssetEntry[]): AssetEntry[] {
    const extensions = reference.kind === 'model' ? ['.ydr', '.ydd', '.yft']
        : reference.kind === 'textureDictionary' || reference.kind === 'texture' ? ['.ytd']
            : reference.kind === 'particleAsset' ? ['.ypt'] : ['.awc'];
    const name = reference.kind === 'texture' ? reference.dictionary : reference.value;
    return entries.filter((entry) => extensions.includes(entry.extension) && ((name !== undefined && entry.name.toLowerCase() === name.toLowerCase())
        || (reference.kind !== 'texture' && reference.hash !== undefined && entry.hash === (reference.hash >>> 0))));
}
export type IndexedAssetReference = { id: string; declaration: AssetDeclaration } | { id: string; reference: AssetReference };
/** Resolve one selected asset against original source rows, without materializing all reverse edges. */
export function referenceIdsForAsset(entry: AssetEntry, rows: readonly IndexedAssetReference[]): { ids: string[]; incomplete: boolean } {
    const parts = entry.path.split('/');
    const directories = new Set(parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join('/')));
    const inventory: AssetInventory = { root: '', entries: [entry], files: new Set([entry.path]), directories, issues: [], notes: [],
        incomplete: false, skippedDirectories: [], matchingBudget: 32_000_000 };
    const ids: string[] = [];
    let incomplete = false;
    for (const row of rows) {
        if ('declaration' in row) {
            const result = declarationTargets(row.declaration, inventory);
            if (result.matches.length) { ids.push(row.id); }
            incomplete ||= result.unverified === true;
        } else if (referenceTargets(row.reference, [entry]).length) { ids.push(row.id); }
    }
    return { ids, incomplete };
}
