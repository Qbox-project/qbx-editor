import { deflateRaw } from 'node:zlib';
import { promisify } from 'node:util';
import { MAX_RESOURCE_BYTES, textureLevelSize, type TextureFile } from './assetFormats';
import { ResourcePages } from './assetResource';
import type { TextureEncoding } from './assetTypes';
import { metaHash } from './metaFormat';
import type { EncodedTexture } from './textureEncode';

const deflate = promisify(deflateRaw);
const SYSTEM = 0x50000000n, GRAPHICS = 0x60000000n, RESERVED_PAGES = 128, BASE_PAGE = 0x2000;
export const MAX_TEXTURES = 2048;
export const MAX_TEXTURE_NAME = 96;
const LEGACY_CODE: Record<TextureEncoding, number> = { BC1: 0x31545844, BC2: 0x33545844, BC3: 0x35545844, BC4: 0x31495441, BC5: 0x32495441, BC7: 0x20374342, BGRA8: 21, BGRX8: 22, RGBA8: 32, A8: 28, R8: 50 };
const GEN9_CODE: Record<TextureEncoding, number> = { BC1: 0x47, BC2: 0x4a, BC3: 0x4d, BC4: 0x50, BC5: 0x53, BC7: 0x62, BGRA8: 0x57, BGRX8: 0x58, RGBA8: 0x1c, A8: 0x41, R8: 0x3d };

export interface StoredTexture {
    name: string; hash: number; width: number; height: number; mipCount: number; encoding?: TextureEncoding;
    /** Every stored mip level, largest first. */
    data: Buffer;
    /** The texture's record as stored, so that fields this editor does not model survive a rewrite. */
    record: Buffer;
}
export interface StoredDictionary { gen9: boolean; root?: Buffer; textures: StoredTexture[]; locked?: string }

export function textureHash(name: string): number { return metaHash(name.toLowerCase()); }
function recordSize(gen9: boolean): number { return gen9 ? 0x80 : 0x90; }
function defaultResourceView(record: Buffer): void { record.writeBigUInt64LE(0x1406b77d8n, 0x58); record.writeUInt16LE(0x41, 0x68); record.writeUInt16LE(0xffff, 0x6a); record.writeUInt32LE(0xffffffff, 0x6c); }
function blockBytes(encoding: TextureEncoding): number { return textureLevelSize(1, 1, encoding); }
function levelBytes(width: number, height: number, mipCount: number, encoding: TextureEncoding): number {
    let size = 0;
    for (let mip = 0; mip < mipCount; mip++) { size += textureLevelSize(Math.max(1, width >> mip), Math.max(1, height >> mip), encoding); }
    return size;
}

/** Splits a parsed dictionary into textures that can be rearranged and written back. */
export function readDictionary(file: TextureFile): StoredDictionary {
    const gen9 = file.header.version === 5, system = file.header.systemBytes!, total = system + file.header.graphicsBytes!, size = recordSize(gen9);
    const pages = new ResourcePages(file.header, file.bytes, system, file.header.graphicsBytes!, 'YTD'), count = pages.u16(0x38);
    const dictionary: StoredDictionary = { gen9, root: Buffer.from(file.bytes.subarray(0, 0x40)), textures: [] };
    const hashes = count && pages.u16(0x28) === count ? pages.pointer(0x20, count * 4) : undefined, list = count ? pages.pointer(0x30, count * 8) : 0;
    for (let index = 0; index < count; index++) {
        const at = pages.pointer(list + index * 8, size), record = Buffer.from(file.bytes.subarray(at, at + size)), view = file.textures[index];
        const name = pages.text(pages.pointer(at + 0x28, 1)), offset = pages.pointer(at + (gen9 ? 0x38 : 0x70), 1);
        const computed = view.encoding ? levelBytes(view.width, view.height, view.mipCount, view.encoding) : 0;
        let length = computed;
        if (gen9) {
            length = Math.max(computed, record.readUInt32LE(0x08) * record.readUInt32LE(0x0c));
            // Enhanced records carry their resource view inside themselves; one stored elsewhere is moved in.
            const resourceView = pages.optionalPointer(at + 0x30, 32);
            if (resourceView === undefined) { defaultResourceView(record); }
            else if (resourceView !== at + 0x58) { file.bytes.copy(record, 0x58, resourceView, resourceView + 32); }
        } else if (!length) {
            const row = record.readUInt16LE(0x56) * view.height;
            for (let mip = 0; mip < view.mipCount; mip++) { length += Math.floor(row / 4 ** mip); }
        }
        const layered = record.readUInt16LE(gen9 ? 0x1c : 0x54) > 1 || (gen9 && record[0x1e] !== 1);
        if ((layered || !length) && !dictionary.locked) { dictionary.locked = `the layout of texture "${name}" is one this editor cannot rewrite`; }
        const available = Math.max(0, Math.min(length, (offset < system ? system : total) - offset));
        // Files that leave out their smallest levels get those levels back as zeros, so no level reads past its block.
        const data = available === length ? file.bytes.subarray(offset, offset + length) : Buffer.concat([file.bytes.subarray(offset, offset + available), Buffer.alloc(length - available)]);
        dictionary.textures.push({ name, hash: hashes === undefined ? textureHash(name) : file.bytes.readUInt32LE(hashes + index * 4), width: view.width, height: view.height, mipCount: view.mipCount, encoding: view.encoding, data, record });
    }
    return dictionary;
}

/** A stored texture for encoded pixels; `replaced` passes its record on, which keeps usage flags the game reads. */
export function storeTexture(name: string, encoded: EncodedTexture, gen9: boolean, replaced?: StoredTexture): StoredTexture {
    const record = Buffer.alloc(recordSize(gen9)), encoding = encoded.encoding, sameEncoding = replaced?.encoding === encoding;
    if (replaced) { replaced.record.copy(record); } else { record.writeUInt32LE(1, 0x04); }
    if (gen9) {
        if (!replaced) {
            record.writeUInt32LE(/^script_rt_/i.test(name) ? 0x00260228 : 0x00260208, 0x10); record[0x23] = 0x28; record.writeUInt16LE(1, 0x26); record.writeUInt32LE(2, 0x44);
            defaultResourceView(record);
        }
        record.writeUInt32LE(encoded.data.length / blockBytes(encoding), 0x08); record.writeUInt32LE(blockBytes(encoding), 0x0c);
        record.writeUInt16LE(encoded.width, 0x18); record.writeUInt16LE(encoded.height, 0x1a); record.writeUInt16LE(1, 0x1c); record[0x1e] = 1;
        if (!sameEncoding) { record[0x1f] = GEN9_CODE[encoding]; }
        if (record[0x20] !== 8) { record[0x20] = 255; }
        record[0x22] = encoded.mipCount;
    } else {
        if (!replaced) { record.writeUInt16LE(1, 0x30); }
        record.writeUInt16LE(encoded.width, 0x50); record.writeUInt16LE(encoded.height, 0x52); record.writeUInt16LE(1, 0x54);
        record.writeUInt16LE(textureLevelSize(encoded.width, 1, encoding), 0x56);
        if (!sameEncoding) { record.writeUInt32LE(LEGACY_CODE[encoding], 0x58); }
        record[0x5d] = encoded.mipCount;
    }
    return { name, hash: replaced && replaced.name === name ? replaced.hash : textureHash(name), width: encoded.width, height: encoded.height, mipCount: encoded.mipCount, encoding, data: encoded.data, record };
}
export function renameTexture(texture: StoredTexture, name: string): StoredTexture { return { ...texture, name, hash: textureHash(name) }; }
/** A texture name made from a file name: what the game hashes is ASCII without spaces. */
export function textureNameFromFile(stem: string): string { return stem.trim().replace(/[^A-Za-z0-9_.+@#-]+/g, '_').slice(0, MAX_TEXTURE_NAME) || 'texture'; }
export function textureNameProblem(name: string, others: readonly StoredTexture[]): string | undefined {
    if (!/^[\x21-\x7e]+$/.test(name)) { return 'Use letters, digits and punctuation without spaces.'; }
    if (name.length > MAX_TEXTURE_NAME) { return `Use at most ${MAX_TEXTURE_NAME} characters.`; }
    const hash = textureHash(name), clash = others.find((texture) => texture.hash === hash);
    return clash ? `The dictionary already holds "${clash.name}". Names differ by more than letter case.` : undefined;
}

interface Block { length: number; position: number }
/**
 * Places blocks in resource pages and returns the page flags. Pages come in five sizes, each double the last,
 * largest first, and a block never crosses a page; the root block, when there is one, lands at offset zero.
 */
function assign(blocks: Block[], rooted: boolean, maxPages: number): { flags: number; size: number; pages: number } {
    if (!blocks.length) { return { flags: 0, size: 0, pages: 0 }; }
    const largest = Math.max(...blocks.map((block) => block.length)), smallest = Math.min(...blocks.map((block) => block.length));
    const descending = (a: Block, b: Block): number => b.length - a.length;
    const order = rooted ? [blocks[0], ...blocks.slice(1).sort(descending)] : [...blocks].sort(descending);
    let shift = 0;
    while ((BASE_PAGE * 2 ** shift < smallest || BASE_PAGE * 2 ** shift * 16 < largest) && shift < 15) { shift++; }
    for (; shift <= 15; shift++) {
        const base = BASE_PAGE * 2 ** shift;
        if (base * 16 < largest) { break; }
        let top = 0;
        while (base * 2 ** top < largest) { top++; }
        const filled: number[][] = [[], [], [], [], []], placed: [index: number, page: number, offset: number][] = [];
        for (const [position, block] of order.entries()) {
            let fit = position ? 0 : top, home: [number, number, number] | undefined;
            while (block.length > base * 2 ** fit && fit < top) { fit++; }
            for (let index = fit; index <= top && !home && position; index++) {
                for (let page = 0; page < filled[index].length && !home; page++) {
                    const offset = Math.ceil(filled[index][page] / 16) * 16;
                    if (offset + block.length <= base * 2 ** index) { filled[index][page] = offset + block.length; home = [index, page, offset]; }
                }
            }
            if (!home) { filled[fit].push(block.length); home = [fit, filled[fit].length - 1, 0]; }
            placed.push(home);
        }
        const counts = filled.map((pages) => pages.length), pages = counts.reduce((sum, value) => sum + value, 0);
        if (pages > maxPages || counts[0] > 0x7f || counts[1] > 0x3f || counts[2] > 0xf || counts[3] > 3 || counts[4] > 1) { continue; }
        const starts: number[] = [];
        let size = 0;
        for (let index = 4; index >= 0; index--) { starts[index] = size; size += counts[index] * base * 2 ** index; }
        for (const [position, block] of order.entries()) { const [index, page, offset] = placed[position]; block.position = starts[index] + page * base * 2 ** index + offset; }
        return { flags: (shift | (counts[4] << 4) | (counts[3] << 5) | (counts[2] << 7) | (counts[1] << 11) | (counts[0] << 17)) >>> 0, size, pages };
    }
    throw new Error('These textures do not fit in one texture dictionary; split them across several.');
}

/** Bytes of graphics pages these textures occupy once loaded: their data, rounded up to whole pages. */
export function textureMemory(textures: readonly StoredTexture[]): number {
    try { return assign(textures.map((texture) => ({ length: texture.data.length, position: 0 })), false, RESERVED_PAGES).size; }
    catch { return textures.reduce((sum, texture) => sum + texture.data.length, 0); }
}

/** Writes the dictionary as an RSC7 file of the generation it was read as. */
export async function buildDictionary(dictionary: StoredDictionary): Promise<Buffer> {
    const { gen9 } = dictionary, textures = [...dictionary.textures].sort((a, b) => a.hash - b.hash), size = recordSize(gen9), count = textures.length;
    if (dictionary.locked) { throw new Error(`This dictionary cannot be rewritten: ${dictionary.locked}.`); }
    if (count > MAX_TEXTURES) { throw new Error(`A texture dictionary holds at most ${MAX_TEXTURES.toLocaleString('en-US')} textures.`); }
    const clash = textures.find((texture, index) => index > 0 && textures[index - 1].hash === texture.hash);
    if (clash) { throw new Error(`Two textures share the name "${clash.name}".`); }
    const block = (length: number): Block => ({ length, position: 0 });
    const root = block(0x40), info = block(16 + 8 * RESERVED_PAGES), hashes = block(count * 4), list = block(count * 8);
    const records = textures.map(() => block(size)), names = textures.map((texture) => block(texture.name.length + 1)), data = textures.map((texture) => block(texture.data.length));
    const system = assign([root, info, ...(count ? [hashes, list] : []), ...records, ...names], true, RESERVED_PAGES);
    const graphics = assign(data, false, RESERVED_PAGES - system.pages);
    if (system.size + graphics.size > MAX_RESOURCE_BYTES) { throw new Error('These textures exceed the 128 MiB a texture dictionary may expand to; split them across several.'); }
    const pages = Buffer.alloc(system.size + graphics.size), version = gen9 ? 5 : 13;
    if (dictionary.root) { dictionary.root.copy(pages, 0, 0, 0x40); } else { pages.writeUInt32LE(1, 0x04); pages.writeUInt32LE(1, 0x18); }
    pages.writeBigUInt64LE(SYSTEM + BigInt(info.position), 0x08);
    for (const [at, target] of [[0x20, hashes], [0x30, list]] as const) {
        pages.writeBigUInt64LE(count ? SYSTEM + BigInt(target.position) : 0n, at); pages.writeUInt16LE(count, at + 8); pages.writeUInt16LE(count, at + 10); pages.writeUInt32LE(0, at + 12);
    }
    pages[info.position + 8] = system.pages; pages[info.position + 9] = graphics.pages;
    for (const [index, texture] of textures.entries()) {
        const at = records[index].position;
        pages.writeUInt32LE(texture.hash, hashes.position + index * 4); pages.writeBigUInt64LE(SYSTEM + BigInt(at), list.position + index * 8);
        texture.record.copy(pages, at, 0, size);
        pages.writeBigUInt64LE(SYSTEM + BigInt(names[index].position), at + 0x28);
        if (gen9) { pages.writeBigUInt64LE(SYSTEM + BigInt(at + 0x58), at + 0x30); }
        pages.writeBigUInt64LE(GRAPHICS + BigInt(data[index].position), at + (gen9 ? 0x38 : 0x70));
        pages.write(texture.name, names[index].position, 'latin1');
        texture.data.copy(pages, system.size + data[index].position);
    }
    const header = Buffer.alloc(16);
    header.write('RSC7', 'latin1'); header.writeUInt32LE(version, 4);
    // The version is stored a second time, split over the top four bits of both flag words.
    header.writeUInt32LE((system.flags | ((version >> 4) << 28)) >>> 0, 8); header.writeUInt32LE((graphics.flags | ((version & 15) << 28)) >>> 0, 12);
    return Buffer.concat([header, await deflate(pages)]);
}
