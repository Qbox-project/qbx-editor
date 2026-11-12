import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { assetHash } from './assetInventory';

export const MAX_SCOPE_FILES = 5000;
const MAX_SCOPE_ENTRIES = 20_000, MAX_SCOPE_DEPTH = 12, MAX_ANCESTORS = 12;
const MANIFESTS = ['fxmanifest.lua', '__resource.lua'];
const EXCLUDED = new Set(['node_modules', 'vendor']);
const EXTENSIONS = ['.ymap.xml', '.ytyp.xml', '.ydr', '.ydd', '.yft', '.ybn', '.ytd', '.ymap', '.ytyp', '.ycd', '.ypt', '.ymt', '.awc'];

export interface ScopeFile { path: string; relative: string; stem: string; extension: string }
export interface AssetScope { root: string; resource: boolean; files: ScopeFile[]; incomplete: boolean }

/** The resource folder that contains `file`, or the file's own folder when no manifest is found above it. */
export async function findScopeRoot(file: string): Promise<{ root: string; resource: boolean }> {
    let directory = path.dirname(file);
    for (let level = 0; level < MAX_ANCESTORS; level++) {
        const found = await Promise.all(MANIFESTS.map((manifest) => fs.stat(path.join(directory, manifest)).then((stat) => stat.isFile(), () => false)));
        if (found.includes(true)) { return { root: directory, resource: true }; }
        const parent = path.dirname(directory);
        if (parent === directory) { break; }
        directory = parent;
    }
    return { root: path.dirname(file), resource: false };
}

export async function scanAssetScope(file: string, isCurrent: () => boolean = () => true): Promise<AssetScope> {
    const scope: AssetScope = { ...await findScopeRoot(file), files: [], incomplete: false };
    const queue = [{ directory: scope.root, relative: '', depth: 0 }];
    let visited = 0;
    while (queue.length && isCurrent()) {
        const current = queue.shift()!;
        let children: import('node:fs').Dirent[];
        try { children = await fs.readdir(current.directory, { withFileTypes: true }); } catch { scope.incomplete = true; continue; }
        children.sort((a, b) => a.name.localeCompare(b.name));
        for (const child of children) {
            if (++visited > MAX_SCOPE_ENTRIES || scope.files.length >= MAX_SCOPE_FILES) { scope.incomplete = true; return scope; }
            const relative = current.relative ? `${current.relative}/${child.name}` : child.name;
            if (child.isDirectory()) {
                if (child.name.startsWith('.') || EXCLUDED.has(child.name.toLowerCase())) { continue; }
                if (current.depth >= MAX_SCOPE_DEPTH) { scope.incomplete = true; continue; }
                queue.push({ directory: path.join(current.directory, child.name), relative, depth: current.depth + 1 });
            } else if (child.isFile()) {
                const lower = child.name.toLowerCase(), extension = EXTENSIONS.find((candidate) => lower.endsWith(candidate));
                if (extension) { scope.files.push({ path: path.join(current.directory, child.name), relative, stem: child.name.slice(0, -extension.length), extension }); }
            }
        }
    }
    return scope;
}

/** Asset names recovered from file names, keyed by the hash that binary game files store instead of the name. */
export function scopeNames(scope: AssetScope): Map<number, string> {
    const names = new Map<number, string>();
    for (const file of scope.files) {
        if (/^[\x21-\x7e]+$/.test(file.stem)) { names.set(assetHash(file.stem), file.stem.toLowerCase()); }
    }
    return names;
}
