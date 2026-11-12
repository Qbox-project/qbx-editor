import { loadResourcePages, type ResourcePages } from './assetResource';

export const MetaType = {
    Boolean: 0x01, Structure: 0x05, StructurePointer: 0x07, SignedByte: 0x10, UnsignedByte: 0x11, SignedShort: 0x12, UnsignedShort: 0x13,
    SignedInt: 0x14, UnsignedInt: 0x15, Float: 0x21, Vector3: 0x33, Vector4: 0x34, ArrayOfChars: 0x40, CharPointer: 0x44, Hash: 0x4a,
    ArrayOfBytes: 0x50, Array: 0x52, DataBlockPointer: 0x59, ByteEnum: 0x60, IntEnum: 0x62, IntFlags1: 0x63, ShortFlags: 0x64, IntFlags2: 0x65,
} as const;
export const ARRAY_INFO = 0x100, POINTER_BLOCK = 0x07, STRING_BLOCK = 0x10;
const MAX_STRUCTURES = 2048, MAX_ENTRIES = 512, MAX_ENUM_VALUES = 4096, MAX_BLOCKS = 32767;
export const MAX_META_ITEMS = 2_000_000;

export interface MetaEntry { name: number; offset: number; type: number; referenceIndex: number; referenceKey: number }
export interface MetaStructure { name: number; size: number; entries: MetaEntry[] }
export interface MetaEnum { name: number; values: Map<number, number> }
export interface MetaBlock { type: number; offset: number; length: number }
export type MetaVector = [number, number, number] | [number, number, number, number];

const hashes = new Map<string, number>();
/** Structure and field names are hashed case-sensitively, unlike asset names. */
export function metaHash(name: string): number {
    let hash = hashes.get(name);
    if (hash === undefined) {
        hash = 0;
        for (let index = 0; index < name.length; index++) {
            hash = (hash + (name.charCodeAt(index) & 0xff)) >>> 0; hash = (hash + (hash << 10)) >>> 0; hash ^= hash >>> 6;
        }
        hash = (hash + (hash << 3)) >>> 0; hash ^= hash >>> 11; hash = (hash + (hash << 15)) >>> 0;
        hashes.set(name, hash);
    }
    return hash;
}

export class MetaFile {
    readonly structures = new Map<number, MetaStructure>();
    readonly enums = new Map<number, MetaEnum>();
    readonly blocks: MetaBlock[] = [];
    name = '';
    rootBlock = 0;
    private remaining = MAX_META_ITEMS;
    constructor(readonly pages: ResourcePages) {}
    block(id: number): MetaBlock | undefined { return id >= 1 ? this.blocks[id - 1] : undefined; }
    resetBudget(): void { this.remaining = MAX_META_ITEMS; }
    spend(items = 1): void {
        this.remaining -= items;
        if (this.remaining < 0) { throw new Error('This file exceeds the two-million-value inspection budget.'); }
    }
    root(): MetaRecord {
        const block = this.block(this.rootBlock);
        const structure = block && this.structures.get(block.type);
        if (!block || !structure) { throw new Error('The root data block or its structure definition is missing.'); }
        return new MetaRecord(this, structure, block, 0);
    }
    /** Byte offsets of `count` items that start at a block pointer and continue into following blocks of the same type. */
    *items(pointer: number, count: number, size: number, type?: number): Generator<{ block: MetaBlock; offset: number }> {
        let id = pointer & 0xfff, offset = (pointer >>> 12) & 0xfffff, block = this.block(id);
        if (size < 1) { return; }
        for (let index = 0; index < count; index++) {
            if (!block || (type !== undefined && block.type !== type)) { return; }
            if (offset + size > block.length) {
                if (offset < block.length) { return; }
                block = this.block(++id); offset = 0; index--; continue;
            }
            this.spend();
            yield { block, offset };
            offset += size;
        }
    }
}

export class MetaRecord {
    constructor(readonly file: MetaFile, readonly structure: MetaStructure, readonly block: MetaBlock, readonly offset: number) {
        if (offset < 0 || offset + structure.size > block.length) { throw new Error('A structure extends past the end of its data block.'); }
    }
    get type(): number { return this.structure.name; }
    entry(name: string | number): MetaEntry | undefined {
        const hash = typeof name === 'number' ? name : metaHash(name);
        return this.structure.entries.find((entry) => entry.name === hash);
    }
    itemEntry(entry: MetaEntry): MetaEntry | undefined {
        const entries = this.structure.entries, referenced = entries[entry.referenceIndex];
        if (referenced?.name === ARRAY_INFO) { return referenced; }
        for (let index = entries.indexOf(entry) - 1; index >= 0; index--) { if (entries[index].name === ARRAY_INFO) { return entries[index]; } }
        return undefined;
    }
    at(entry: MetaEntry, length: number): number {
        if (entry.offset < 0 || this.offset + entry.offset + length > this.block.length) { throw new Error('A field extends past the end of its data block.'); }
        return this.block.offset + this.offset + entry.offset;
    }
    number(name: string | number): number | undefined {
        const entry = this.entry(name), pages = this.file.pages;
        if (!entry) { return undefined; }
        switch (entry.type) {
            case MetaType.Boolean: case MetaType.UnsignedByte: case MetaType.ByteEnum: return pages.u8(this.at(entry, 1));
            case MetaType.SignedByte: return pages.bytes.readInt8(this.at(entry, 1));
            case MetaType.SignedShort: return pages.i16(this.at(entry, 2));
            case MetaType.UnsignedShort: case MetaType.ShortFlags: return pages.u16(this.at(entry, 2));
            case MetaType.SignedInt: case MetaType.IntEnum: return pages.i32(this.at(entry, 4));
            case MetaType.UnsignedInt: case MetaType.Hash: case MetaType.IntFlags1: case MetaType.IntFlags2: return pages.u32(this.at(entry, 4));
            case MetaType.Float: return pages.f32(this.at(entry, 4));
            default: return undefined;
        }
    }
    vector(name: string | number): MetaVector | undefined {
        const entry = this.entry(name), pages = this.file.pages;
        if (!entry || (entry.type !== MetaType.Vector3 && entry.type !== MetaType.Vector4)) { return undefined; }
        const at = this.at(entry, entry.type === MetaType.Vector3 ? 12 : 16);
        return entry.type === MetaType.Vector3 ? [pages.f32(at), pages.f32(at + 4), pages.f32(at + 8)] : [pages.f32(at), pages.f32(at + 4), pages.f32(at + 8), pages.f32(at + 12)];
    }
    text(name: string | number): string | undefined {
        const entry = this.entry(name), pages = this.file.pages;
        if (!entry) { return undefined; }
        if (entry.type === MetaType.ArrayOfChars) {
            const at = this.at(entry, entry.referenceKey), end = pages.bytes.subarray(at, at + entry.referenceKey).indexOf(0);
            return pages.bytes.toString('latin1', at, end < 0 ? at + entry.referenceKey : at + end);
        }
        if (entry.type !== MetaType.CharPointer) { return undefined; }
        const at = this.at(entry, 16), pointer = pages.u32(at), length = pages.u16(at + 8), block = this.file.block(pointer & 0xfff), offset = (pointer >>> 12) & 0xfffff;
        if (!block || block.type !== STRING_BLOCK || offset + length > block.length) { return undefined; }
        return pages.bytes.toString('latin1', block.offset + offset, block.offset + offset + length);
    }
    record(name: string | number): MetaRecord | undefined {
        const entry = this.entry(name), structure = entry?.type === MetaType.Structure ? this.file.structures.get(entry.referenceKey) : undefined;
        return entry && structure ? new MetaRecord(this.file, structure, this.block, this.offset + entry.offset) : undefined;
    }
    private array(name: string | number): { item: MetaEntry; pointer: number; count: number } | undefined {
        const entry = this.entry(name), item = entry?.type === MetaType.Array ? this.itemEntry(entry) : undefined;
        if (!entry || !item) { return undefined; }
        const at = this.at(entry, 16);
        return { item, pointer: this.file.pages.u32(at), count: this.file.pages.u16(at + 8) };
    }
    count(name: string | number): number { return this.array(name)?.count ?? 0; }
    records(name: string | number): MetaRecord[] {
        const array = this.array(name), file = this.file, result: MetaRecord[] = [];
        if (!array) { return result; }
        if (array.item.type === MetaType.Structure) {
            const structure = file.structures.get(array.item.referenceKey);
            if (!structure) { return result; }
            for (const item of file.items(array.pointer, array.count, structure.size)) { result.push(new MetaRecord(file, structure, item.block, item.offset)); }
        } else if (array.item.type === MetaType.StructurePointer) {
            for (const item of file.items(array.pointer, array.count, 8, POINTER_BLOCK)) {
                const pointer = file.pages.u32(item.block.offset + item.offset), block = file.block(pointer & 0xfff), structure = block && file.structures.get(block.type);
                if (block && structure) { result.push(new MetaRecord(file, structure, block, (pointer >>> 12) & 0xfffff)); }
            }
        }
        return result;
    }
    numbers(name: string | number): number[] {
        const array = this.array(name), pages = this.file.pages, result: number[] = [];
        if (!array) { return result; }
        const type = array.item.type;
        const size = type === MetaType.UnsignedByte || type === MetaType.SignedByte ? 1 : type === MetaType.UnsignedShort || type === MetaType.SignedShort ? 2
            : type === MetaType.UnsignedInt || type === MetaType.SignedInt || type === MetaType.Hash || type === MetaType.Float ? 4 : 0;
        for (const item of this.file.items(array.pointer, array.count, size, type)) {
            const at = item.block.offset + item.offset;
            result.push(type === MetaType.Float ? pages.f32(at) : type === MetaType.SignedInt ? pages.i32(at) : type === MetaType.SignedShort ? pages.i16(at)
                : type === MetaType.SignedByte ? pages.bytes.readInt8(at) : size === 4 ? pages.u32(at) : size === 2 ? pages.u16(at) : pages.u8(at));
        }
        return result;
    }
    vectors(name: string | number): MetaVector[] {
        const array = this.array(name), pages = this.file.pages, result: MetaVector[] = [];
        if (!array || array.item.type !== MetaType.Vector3) { return result; }
        for (const item of this.file.items(array.pointer, array.count, 16, MetaType.Vector3)) {
            const at = item.block.offset + item.offset;
            result.push([pages.f32(at), pages.f32(at + 4), pages.f32(at + 8)]);
        }
        return result;
    }
}

export async function parseMeta(data: Buffer): Promise<MetaFile> {
    const pages = await loadResourcePages(data, 'Meta', [2]);
    const file = new MetaFile(pages);
    pages.need(0, 0x70);
    file.rootBlock = pages.i32(0x1c);
    const structureCount = pages.i16(0x48), enumCount = pages.i16(0x4a), blockCount = pages.i16(0x4c);
    if (structureCount < 0 || structureCount > MAX_STRUCTURES || enumCount < 0 || enumCount > MAX_STRUCTURES || blockCount < 1 || blockCount > MAX_BLOCKS) {
        throw new Error('This RSC7 resource does not contain a valid Meta header.');
    }
    const structures = structureCount ? pages.pointer(0x20, structureCount * 32) : 0;
    for (let index = 0; index < structureCount; index++) {
        const at = structures + index * 32, count = pages.i16(at + 0x1e), size = pages.i32(at + 0x18);
        if (count < 0 || count > MAX_ENTRIES || size < 0 || size > 0x100000) { throw new Error('A Meta structure definition is invalid.'); }
        const entries = count ? pages.pointer(at + 0x10, count * 16) : 0;
        const structure: MetaStructure = { name: pages.u32(at), size, entries: [] };
        for (let entry = 0; entry < count; entry++) {
            const from = entries + entry * 16;
            structure.entries.push({ name: pages.u32(from), offset: pages.i32(from + 4), type: pages.u8(from + 8), referenceIndex: pages.i16(from + 10), referenceKey: pages.u32(from + 12) });
        }
        file.structures.set(structure.name, structure);
    }
    const enums = enumCount ? pages.pointer(0x28, enumCount * 24) : 0;
    for (let index = 0; index < enumCount; index++) {
        const at = enums + index * 24, count = pages.i32(at + 0x10);
        if (count < 0 || count > MAX_ENUM_VALUES) { throw new Error('A Meta enum definition is invalid.'); }
        const entries = count ? pages.pointer(at + 8, count * 8) : 0, values = new Map<number, number>();
        for (let entry = 0; entry < count; entry++) { values.set(pages.i32(entries + entry * 8 + 4), pages.u32(entries + entry * 8)); }
        file.enums.set(pages.u32(at), { name: pages.u32(at), values });
    }
    const blocks = pages.pointer(0x30, blockCount * 16);
    for (let index = 0; index < blockCount; index++) {
        const at = blocks + index * 16, length = pages.i32(at + 4);
        if (length < 0) { throw new Error('A Meta data block has an invalid length.'); }
        file.blocks.push({ type: pages.u32(at), length, offset: length ? pages.pointer(at + 8, length) : 0 });
    }
    const name = pages.optionalPointer(0x38, 1);
    if (name !== undefined) { file.name = pages.text(name); }
    return file;
}
