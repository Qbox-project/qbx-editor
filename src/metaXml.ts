import { ARRAY_INFO, MetaType, POINTER_BLOCK, STRING_BLOCK, type MetaBlock, type MetaEntry, type MetaFile, type MetaStructure } from './metaFormat';
import { metaNames } from './metaNames';

export const MAX_META_XML_CHARACTERS = 32 * 1024 * 1024;
const ELEMENT_BYTES: Record<number, number> = { [MetaType.SignedByte]: 1, [MetaType.UnsignedByte]: 1, [MetaType.SignedShort]: 2, [MetaType.UnsignedShort]: 2,
    [MetaType.SignedInt]: 4, [MetaType.UnsignedInt]: 4, [MetaType.Float]: 4 };

/** The shortest decimal text that reads back as the same 32-bit float. */
export function floatText(value: number): string {
    if (!Number.isFinite(value)) { return Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity'; }
    for (let digits = 1; digits < 9; digits++) {
        const text = value.toPrecision(digits);
        if (Math.fround(Number(text)) === value) { return String(Number(text)); }
    }
    return String(Number(value.toPrecision(9)));
}
export function hashText(hash: number): string { return `hash_${hash.toString(16).toUpperCase().padStart(8, '0')}`; }
function escape(value: string): string { return value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!); }

/** Writes Meta data as the XML that CodeWalker exports and imports, resolving asset hashes through `assetName`. */
export function metaToXml(file: MetaFile, assetName: (hash: number) => string | undefined = () => undefined): string {
    const schema = metaNames(), pages = file.pages, out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>\n'];
    let length = 0;
    file.resetBudget();
    function write(indent: number, text: string): void {
        length += indent + text.length + 1;
        if (length > MAX_META_XML_CHARACTERS) { throw new Error('The XML form of this file exceeds the 32 MiB export limit.'); }
        out.push(' '.repeat(indent), text, '\n');
    }
    const schemaName = (hash: number): string => schema.get(hash) ?? hashText(hash);
    // A schema word stands in for a value only when re-hashing it as an asset name gives the same hash back.
    const schemaValue = (hash: number): string | undefined => { const name = schema.get(hash); return name !== undefined && name === name.toLowerCase() ? name : undefined; };
    const valueName = (hash: number): string => hash === 0 ? '' : escape(assetName(hash) ?? schemaValue(hash) ?? hashText(hash));
    const text = (indent: number, name: string, value: string): void => write(indent, value ? `<${name}>${value}</${name}>` : `<${name} />`);
    function itemEntry(structure: MetaStructure, index: number): MetaEntry | undefined {
        const referenced = structure.entries[structure.entries[index].referenceIndex];
        if (referenced?.name === ARRAY_INFO) { return referenced; }
        for (let at = index - 1; at >= 0; at--) { if (structure.entries[at].name === ARRAY_INFO) { return structure.entries[at]; } }
        return undefined;
    }
    function enumText(entry: MetaEntry, value: number): string {
        const values = file.enums.get(entry.referenceKey)?.values;
        if (!values) { return String(value); }
        if (entry.type === MetaType.IntFlags1 || entry.type === MetaType.IntFlags2) {
            return [...values].filter(([bit]) => bit >= 0 && bit < 32 && (value & (1 << bit)) !== 0).map(([, name]) => schemaName(name)).join(', ');
        }
        const name = values.get(value);
        return name === undefined ? String(value) : schemaName(name);
    }
    function rows(indent: number, name: string, values: string[], perRow: number): void {
        if (!values.length) { write(indent, `<${name} />`); }
        else if (values.length <= perRow) { write(indent, `<${name}>${values.join(' ')}</${name}>`); }
        else {
            write(indent, `<${name}>`);
            for (let at = 0; at < values.length; at += perRow) { write(indent + 1, values.slice(at, at + perRow).join(' ')); }
            write(indent, `</${name}>`);
        }
    }
    function scalar(type: number, at: number): string {
        switch (type) {
            case MetaType.SignedByte: return String(pages.bytes.readInt8(at));
            case MetaType.UnsignedByte: return String(pages.u8(at));
            case MetaType.SignedShort: return String(pages.i16(at));
            case MetaType.UnsignedShort: return String(pages.u16(at));
            case MetaType.SignedInt: return String(pages.i32(at));
            case MetaType.Float: return floatText(pages.f32(at));
            default: return String(pages.u32(at));
        }
    }
    function array(indent: number, name: string, item: MetaEntry | undefined, at: number, depth: number): void {
        const pointer = pages.u32(at), count = pages.u16(at + 8);
        if (!item) { write(indent, `<!-- ${name}: array without an item type -->`); return; }
        if (item.type === MetaType.Structure) {
            const structure = file.structures.get(item.referenceKey), tag = `${name} itemType="${schemaName(item.referenceKey)}"`;
            if (!structure || !count) { write(indent, `<${tag} />`); return; }
            write(indent, `<${tag}>`);
            for (const entry of file.items(pointer, count, structure.size)) {
                write(indent + 1, '<Item>'); struct(indent + 2, structure, entry.block, entry.offset, depth + 1); write(indent + 1, '</Item>');
            }
            write(indent, `</${name}>`);
        } else if (item.type === MetaType.StructurePointer) {
            if (!count) { write(indent, `<${name} />`); return; }
            write(indent, `<${name}>`);
            for (const entry of file.items(pointer, count, 8, POINTER_BLOCK)) {
                const target = pages.u32(entry.block.offset + entry.offset), block = file.block(target & 0xfff), structure = block && file.structures.get(block.type);
                if (!block || !structure) { write(indent + 1, '<!-- item points to a missing block -->'); continue; }
                write(indent + 1, `<Item type="${schemaName(structure.name)}">`); struct(indent + 2, structure, block, (target >>> 12) & 0xfffff, depth + 1); write(indent + 1, '</Item>');
            }
            write(indent, `</${name}>`);
        } else if (item.type === MetaType.Hash || item.type === MetaType.Vector3) {
            const vector = item.type === MetaType.Vector3, values: string[] = [];
            for (const entry of file.items(pointer, count, vector ? 16 : 4, item.type)) {
                const from = entry.block.offset + entry.offset;
                values.push(vector ? [0, 4, 8, 12].map((offset) => floatText(pages.f32(from + offset))).join(', ') : valueName(pages.u32(from)));
            }
            if (!values.length) { write(indent, `<${name} />`); return; }
            write(indent, `<${name}>`);
            for (const value of values) { write(indent + 1, `<Item>${value}</Item>`); }
            write(indent, `</${name}>`);
        } else if (ELEMENT_BYTES[item.type]) {
            const values: string[] = [];
            for (const entry of file.items(pointer, count, ELEMENT_BYTES[item.type], item.type)) { values.push(scalar(item.type, entry.block.offset + entry.offset)); }
            rows(indent, name, values, 10);
        } else { write(indent, `<!-- ${name}: unsupported array item type 0x${item.type.toString(16)} -->`); }
    }
    function struct(indent: number, structure: MetaStructure, block: MetaBlock, offset: number, depth: number): void {
        if (depth > 32) { throw new Error('Meta structures are nested deeper than 32 levels.'); }
        if (offset < 0 || offset + structure.size > block.length) { write(indent, '<!-- structure extends past its data block -->'); return; }
        file.spend(structure.entries.length);
        structure.entries.forEach((entry, index) => {
            if (entry.name === ARRAY_INFO) { return; }
            const name = schemaName(entry.name), base = block.offset + offset + entry.offset;
            const fits = (bytes: number): boolean => entry.offset >= 0 && offset + entry.offset + bytes <= block.length;
            const value = (bytes: number, read: () => string): void => write(indent, fits(bytes) ? `<${name} value="${read()}" />` : `<!-- ${name}: outside its data block -->`);
            switch (entry.type) {
                case MetaType.Boolean: value(1, () => pages.u8(base) ? 'true' : 'false'); break;
                case MetaType.SignedByte: case MetaType.UnsignedByte: case MetaType.ByteEnum: value(1, () => scalar(entry.type === MetaType.SignedByte ? entry.type : MetaType.UnsignedByte, base)); break;
                case MetaType.SignedShort: case MetaType.UnsignedShort: value(2, () => scalar(entry.type, base)); break;
                case MetaType.SignedInt: case MetaType.Float: value(4, () => scalar(entry.type, base)); break;
                case MetaType.UnsignedInt: value(4, () => schema.get(entry.name) === 'color' ? `0x${pages.u32(base).toString(16).toUpperCase().padStart(8, '0')}` : String(pages.u32(base))); break;
                case MetaType.Vector3: if (fits(12)) { write(indent, `<${name} x="${floatText(pages.f32(base))}" y="${floatText(pages.f32(base + 4))}" z="${floatText(pages.f32(base + 8))}" />`); } break;
                case MetaType.Vector4: if (fits(16)) { write(indent, `<${name} x="${floatText(pages.f32(base))}" y="${floatText(pages.f32(base + 4))}" z="${floatText(pages.f32(base + 8))}" w="${floatText(pages.f32(base + 12))}" />`); } break;
                case MetaType.Hash: if (fits(4)) { text(indent, name, valueName(pages.u32(base))); } break;
                case MetaType.IntEnum: case MetaType.IntFlags1: case MetaType.IntFlags2: if (fits(4)) { text(indent, name, enumText(entry, pages.i32(base))); } break;
                case MetaType.ShortFlags: if (fits(2)) { text(indent, name, enumText(entry, pages.i16(base))); } break;
                case MetaType.ArrayOfChars: if (fits(entry.referenceKey)) {
                    const end = pages.bytes.subarray(base, base + entry.referenceKey).indexOf(0);
                    write(indent, `<${name}>${escape(pages.bytes.toString('latin1', base, end < 0 ? base + entry.referenceKey : base + end))}</${name}>`);
                } break;
                case MetaType.ArrayOfBytes: {
                    const item = itemEntry(structure, index), size = (item && ELEMENT_BYTES[item.type]) || 1;
                    if (!fits(entry.referenceKey * size)) { break; }
                    const values = Array.from({ length: entry.referenceKey }, (_unused, at) => item && ELEMENT_BYTES[item.type] ? scalar(item.type, base + at * size) : pages.u8(base + at).toString(16).toUpperCase().padStart(2, '0'));
                    write(indent, `<${name}>${values.join(item && ELEMENT_BYTES[item.type] ? ' ' : '')}</${name}>`);
                    break;
                }
                case MetaType.CharPointer: if (fits(16)) {
                    const pointer = pages.u32(base), count = pages.u16(base + 8), target = file.block(pointer & 0xfff), from = (pointer >>> 12) & 0xfffff;
                    const valid = target && target.type === STRING_BLOCK && from + count <= target.length;
                    text(indent, name, valid ? escape(pages.bytes.toString('latin1', target.offset + from, target.offset + from + count)) : '');
                } break;
                case MetaType.DataBlockPointer: if (fits(8)) {
                    const target = file.block(pages.u32(base) & 0xfff);
                    file.spend(target?.length ?? 0);
                    rows(indent, name, target ? Array.from(pages.bytes.subarray(target.offset, target.offset + target.length), (byte) => byte.toString(16).toUpperCase().padStart(2, '0')) : [], 32);
                } break;
                case MetaType.Structure: {
                    const child = file.structures.get(entry.referenceKey);
                    write(indent, `<${name}>`);
                    if (child) { struct(indent + 1, child, block, offset + entry.offset, depth + 1); }
                    write(indent, `</${name}>`);
                    break;
                }
                case MetaType.Array: if (fits(16)) { array(indent, name, itemEntry(structure, index), base, depth); } break;
                default: write(indent, `<!-- ${name}: unsupported field type 0x${entry.type.toString(16)} -->`);
            }
        });
    }
    const root = file.root(), rootName = schemaName(root.type);
    write(0, `<${rootName}>`);
    struct(1, root.structure, root.block, 0, 0);
    write(0, `</${rootName}>`);
    return out.join('');
}
