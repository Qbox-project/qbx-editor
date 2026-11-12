import { deflateRawSync } from 'node:zlib';
import { assetHash } from '../../src/assetInventory';
import { metaHash, MetaType } from '../../src/metaFormat';

type Kind = 'hash' | 'u32' | 'i32' | 'f32' | 'vec3' | 'vec4' | 'enum' | 'string' | 'struct' | 'structs' | 'pointers' | 'hashes' | 'u32s' | 'vec3s';
type Field = [name: string, kind: Kind, of?: string];
export type MetaObject = { $type: string } & Record<string, unknown>;

const ENTITY: Field[] = [['archetypeName', 'hash'], ['flags', 'u32'], ['guid', 'u32'], ['position', 'vec3'], ['rotation', 'vec4'], ['scaleXY', 'f32'], ['scaleZ', 'f32'],
    ['parentIndex', 'i32'], ['lodDist', 'f32'], ['childLodDist', 'f32'], ['lodLevel', 'enum', 'rage__eLodType'], ['numChildren', 'u32'], ['priorityLevel', 'enum', 'rage__ePriorityLevel']];
const ARCHETYPE: Field[] = [['lodDist', 'f32'], ['flags', 'u32'], ['specialAttribute', 'u32'], ['bbMin', 'vec3'], ['bbMax', 'vec3'], ['bsCentre', 'vec3'], ['bsRadius', 'f32'], ['hdTextureDist', 'f32'],
    ['name', 'hash'], ['textureDictionary', 'hash'], ['clipDictionary', 'hash'], ['drawableDictionary', 'hash'], ['physicsDictionary', 'hash'],
    ['assetType', 'enum', 'rage__fwArchetypeDef__eAssetType'], ['assetName', 'hash']];
export const SCHEMA: Record<string, Field[]> = {
    CMapData: [['name', 'hash'], ['parent', 'hash'], ['flags', 'u32'], ['contentFlags', 'u32'], ['streamingExtentsMin', 'vec3'], ['streamingExtentsMax', 'vec3'],
        ['entitiesExtentsMin', 'vec3'], ['entitiesExtentsMax', 'vec3'], ['entities', 'pointers'], ['physicsDictionaries', 'hashes'], ['carGenerators', 'structs', 'CCarGen'], ['block', 'struct', 'CBlockDesc']],
    CBlockDesc: [['version', 'u32'], ['flags', 'u32'], ['name', 'string'], ['exportedBy', 'string'], ['owner', 'string'], ['time', 'string']],
    CEntityDef: ENTITY,
    CMloInstanceDef: [...ENTITY, ['groupId', 'u32'], ['floorId', 'u32'], ['defaultEntitySets', 'hashes'], ['numExitPortals', 'u32'], ['MLOInstflags', 'u32']],
    CCarGen: [['position', 'vec3'], ['orientX', 'f32'], ['orientY', 'f32'], ['perpendicularLength', 'f32'], ['carModel', 'hash'], ['flags', 'u32'],
        ['bodyColorRemap1', 'i32'], ['bodyColorRemap2', 'i32'], ['bodyColorRemap3', 'i32'], ['bodyColorRemap4', 'i32'], ['popGroup', 'hash'], ['livery', 'i32']],
    CMapTypes: [['archetypes', 'pointers'], ['name', 'hash'], ['dependencies', 'hashes']],
    CBaseArchetypeDef: ARCHETYPE,
    CTimeArchetypeDef: [...ARCHETYPE, ['timeFlags', 'u32']],
    CMloArchetypeDef: [...ARCHETYPE, ['mloFlags', 'u32'], ['entities', 'pointers'], ['rooms', 'structs', 'CMloRoomDef'], ['portals', 'structs', 'CMloPortalDef'], ['entitySets', 'structs', 'CMloEntitySet']],
    CMloRoomDef: [['name', 'string'], ['bbMin', 'vec3'], ['bbMax', 'vec3'], ['blend', 'f32'], ['timecycleName', 'hash'], ['secondaryTimecycleName', 'hash'], ['flags', 'u32'],
        ['portalCount', 'u32'], ['floorId', 'i32'], ['attachedObjects', 'u32s']],
    CMloPortalDef: [['roomFrom', 'u32'], ['roomTo', 'u32'], ['flags', 'u32'], ['mirrorPriority', 'u32'], ['opacity', 'u32'], ['audioOcclusion', 'u32'], ['corners', 'vec3s'], ['attachedObjects', 'u32s']],
    CMloEntitySet: [['name', 'hash'], ['locations', 'u32s'], ['entities', 'pointers']],
};
export const ENUMS: Record<string, string[]> = {
    rage__eLodType: ['LODTYPES_DEPTH_HD', 'LODTYPES_DEPTH_LOD', 'LODTYPES_DEPTH_SLOD1', 'LODTYPES_DEPTH_SLOD2', 'LODTYPES_DEPTH_SLOD3', 'LODTYPES_DEPTH_ORPHANHD', 'LODTYPES_DEPTH_SLOD4'],
    rage__ePriorityLevel: ['PRI_REQUIRED', 'PRI_OPTIONAL_HIGH', 'PRI_OPTIONAL_MEDIUM', 'PRI_OPTIONAL_LOW'],
    rage__fwArchetypeDef__eAssetType: ['ASSET_TYPE_UNINITIALIZED', 'ASSET_TYPE_FRAGMENT', 'ASSET_TYPE_DRAWABLE', 'ASSET_TYPE_DRAWABLEDICTIONARY', 'ASSET_TYPE_ASSETLESS'],
};
const SIZE: Record<Kind, number> = { hash: 4, u32: 4, i32: 4, f32: 4, enum: 4, vec3: 16, vec4: 16, string: 16, struct: 0, structs: 16, pointers: 16, hashes: 16, u32s: 16, vec3s: 16 };
const ALIGN: Record<Kind, number> = { hash: 4, u32: 4, i32: 4, f32: 4, enum: 4, vec3: 16, vec4: 16, string: 8, struct: 8, structs: 8, pointers: 8, hashes: 8, u32s: 8, vec3s: 8 };
const ITEM: Partial<Record<Kind, [type: number, bytes: number]>> = { hashes: [MetaType.Hash, 4], u32s: [MetaType.UnsignedInt, 4], vec3s: [MetaType.Vector3, 16] };
const TYPE: Record<Kind, number> = { hash: MetaType.Hash, u32: MetaType.UnsignedInt, i32: MetaType.SignedInt, f32: MetaType.Float, enum: MetaType.IntEnum, vec3: MetaType.Vector3, vec4: MetaType.Vector4,
    string: MetaType.CharPointer, struct: MetaType.Structure, structs: MetaType.Array, pointers: MetaType.Array, hashes: MetaType.Array, u32s: MetaType.Array, vec3s: MetaType.Array };

interface Layout { size: number; offsets: number[] }
function layout(type: string): Layout {
    let size = 8;
    const offsets = SCHEMA[type].map(([, kind, of]) => {
        const bytes = kind === 'struct' ? layout(of!).size : SIZE[kind];
        size = Math.ceil(size / ALIGN[kind]) * ALIGN[kind];
        const offset = size; size += bytes; return offset;
    });
    return { size: Math.ceil(size / 16) * 16, offsets };
}
/** A hash value: a number as is, a string hashed the way asset names are. */
export function hashOf(value: unknown): number { return typeof value === 'number' ? value >>> 0 : typeof value === 'string' && value ? assetHash(value) : 0; }

/**
 * Encodes objects that follow `SCHEMA` as an RSC7 Meta resource with independently chosen offsets.
 * `chunk` splits structure arrays over consecutive data blocks, as large game files do.
 */
export function syntheticMeta(root: MetaObject, options: { compressed?: boolean; chunk?: number; mutate?: (pages: Buffer) => void } = {}): Buffer {
    const blocks: { type: number; data: Buffer }[] = [], used = new Set<string>(), usedEnums = new Set<string>();
    const pointer = (block: number, offset: number): number => ((block & 0xfff) | (offset << 12)) >>> 0;
    function append(type: number, data: Buffer): { block: number; offset: number } {
        blocks.push({ type, data }); return { block: blocks.length, offset: 0 };
    }
    function array(target: Buffer, at: number, to: { block: number; offset: number } | undefined, count: number): void {
        if (to && count) { target.writeUInt32LE(pointer(to.block, to.offset), at); }
        target.writeUInt16LE(count, at + 8); target.writeUInt16LE(count, at + 10);
    }
    function encode(object: MetaObject, target: Buffer, base: number): void {
        const info = layout(object.$type); used.add(object.$type);
        SCHEMA[object.$type].forEach(([name, kind, of], index) => {
            const at = base + info.offsets[index], value = object[name];
            if (kind === 'hash') { target.writeUInt32LE(hashOf(value), at); }
            else if (kind === 'u32') { target.writeUInt32LE((Number(value) || 0) >>> 0, at); }
            else if (kind === 'i32') { target.writeInt32LE(Number(value) || 0, at); }
            else if (kind === 'f32') { target.writeFloatLE(Number(value) || 0, at); }
            else if (kind === 'enum') { usedEnums.add(of!); target.writeInt32LE(Math.max(0, ENUMS[of!].indexOf(String(value))), at); }
            else if (kind === 'vec3' || kind === 'vec4') { (Array.isArray(value) ? value as number[] : []).forEach((part, axis) => target.writeFloatLE(part, at + axis * 4)); }
            else if (kind === 'string') { const text = Buffer.from(typeof value === 'string' ? value : '', 'latin1'); array(target, at, text.length ? append(0x10, Buffer.concat([text, Buffer.alloc(1)])) : undefined, text.length); }
            else if (kind === 'struct') { used.add(of!); if (value) { encode(value as MetaObject, target, at); } }
            else if (kind === 'structs') {
                used.add(of!);
                const items = (value as MetaObject[] | undefined) ?? [], size = layout(of!).size, chunk = options.chunk ?? items.length;
                const placed: { block: number; offset: number; from: number }[] = [];
                for (let from = 0; from < items.length; from += chunk) { placed.push({ ...append(metaHash(of!), Buffer.alloc(Math.min(chunk, items.length - from) * size)), from }); }
                for (const part of placed) { items.slice(part.from, part.from + chunk).forEach((item, itemIndex) => encode(item, blocks[part.block - 1].data, itemIndex * size)); }
                const first = placed[0];
                array(target, at, first, items.length);
            } else if (kind === 'pointers') {
                const items = (value as MetaObject[] | undefined) ?? [], pointers = Buffer.alloc(items.length * 8);
                items.forEach((item, itemIndex) => {
                    const placed = append(metaHash(item.$type), Buffer.alloc(layout(item.$type).size));
                    encode(item, blocks[placed.block - 1].data, 0);
                    pointers.writeUInt32LE(pointer(placed.block, placed.offset), itemIndex * 8);
                });
                array(target, at, items.length ? append(0x07, pointers) : undefined, items.length);
            } else {
                const [type, bytes] = ITEM[kind]!, items = (value as unknown[] | undefined) ?? [], data = Buffer.alloc(items.length * bytes);
                items.forEach((item, itemIndex) => {
                    if (kind === 'vec3s') { (item as number[]).forEach((part, axis) => data.writeFloatLE(part, itemIndex * 16 + axis * 4)); }
                    else { data.writeUInt32LE(kind === 'hashes' ? hashOf(item) : Number(item) >>> 0, itemIndex * 4); }
                });
                array(target, at, items.length ? append(type, data) : undefined, items.length);
            }
        });
    }
    const rootData = Buffer.alloc(layout(root.$type).size);
    blocks.push({ type: metaHash(root.$type), data: rootData });
    encode(root, rootData, 0);

    const structures = [...used], enums = [...usedEnums], pages = Buffer.alloc(0x40000);
    let cursor = 0x70;
    const reserve = (bytes: number): number => { const at = cursor; cursor = Math.ceil((cursor + bytes) / 16) * 16; return at; };
    const structureTable = reserve(structures.length * 32), enumTable = reserve(enums.length * 24), blockTable = reserve(blocks.length * 16);
    pages.writeInt32LE(1, 0x1c);
    pages.writeBigUInt64LE(BigInt(0x50000000 + structureTable), 0x20); pages.writeBigUInt64LE(BigInt(0x50000000 + enumTable), 0x28); pages.writeBigUInt64LE(BigInt(0x50000000 + blockTable), 0x30);
    pages.writeInt16LE(structures.length, 0x48); pages.writeInt16LE(enums.length, 0x4a); pages.writeInt16LE(blocks.length, 0x4c);
    const nameAt = reserve(16); pages.write('synthetic\0', nameAt, 'latin1'); pages.writeBigUInt64LE(BigInt(0x50000000 + nameAt), 0x38);
    structures.forEach((type, index) => {
        const info = layout(type), entries: [number, number, number, number, number][] = [];
        SCHEMA[type].forEach(([name, kind, of], fieldIndex) => {
            let reference = 0, referenceIndex = 0;
            if (kind === 'structs' || kind === 'pointers' || ITEM[kind]) {
                referenceIndex = entries.length;
                entries.push([0x100, 0, kind === 'structs' ? MetaType.Structure : kind === 'pointers' ? MetaType.StructurePointer : ITEM[kind]![0], 0, kind === 'structs' ? metaHash(of!) : 0]);
            } else if (kind === 'struct' || kind === 'enum') { reference = metaHash(of!); }
            entries.push([metaHash(name), info.offsets[fieldIndex], TYPE[kind], referenceIndex, reference]);
        });
        const at = structureTable + index * 32, entryTable = reserve(entries.length * 16);
        pages.writeUInt32LE(metaHash(type), at); pages.writeBigUInt64LE(BigInt(0x50000000 + entryTable), at + 0x10); pages.writeInt32LE(info.size, at + 0x18); pages.writeInt16LE(entries.length, at + 0x1e);
        entries.forEach(([name, offset, type, referenceIndex, reference], entryIndex) => {
            const from = entryTable + entryIndex * 16;
            pages.writeUInt32LE(name, from); pages.writeInt32LE(offset, from + 4); pages[from + 8] = type; pages.writeInt16LE(referenceIndex, from + 10); pages.writeUInt32LE(reference, from + 12);
        });
    });
    enums.forEach((name, index) => {
        const at = enumTable + index * 24, values = ENUMS[name], entryTable = reserve(values.length * 8);
        pages.writeUInt32LE(metaHash(name), at); pages.writeBigUInt64LE(BigInt(0x50000000 + entryTable), at + 8); pages.writeInt32LE(values.length, at + 0x10);
        values.forEach((value, valueIndex) => { pages.writeUInt32LE(metaHash(value), entryTable + valueIndex * 8); pages.writeInt32LE(valueIndex, entryTable + valueIndex * 8 + 4); });
    });
    blocks.forEach((block, index) => {
        const at = blockTable + index * 16, data = reserve(block.data.length);
        pages.writeUInt32LE(block.type, at); pages.writeInt32LE(block.data.length, at + 4);
        if (block.data.length) { pages.writeBigUInt64LE(BigInt(0x50000000 + data), at + 8); block.data.copy(pages, data); }
    });
    if (cursor > pages.length) { throw new Error('synthetic Meta fixture exceeds its page'); }
    options.mutate?.(pages);
    const header = Buffer.alloc(16); header.write('RSC7'); header.writeUInt32LE(2, 4);
    header.writeUInt32LE(0x08000009, 8); // one system page of 512 << 9 bytes
    return Buffer.concat([header, options.compressed === false ? pages : deflateRawSync(pages)]);
}

/** A collision file holding one horizontal rectangle at height `z`, as a composite with a single geometry child. */
export function syntheticFloorYbn(min: [number, number], max: [number, number], z: number): Buffer {
    const pages = Buffer.alloc(0x4000), child = 0x200, quantum = 0.01;
    const pointer = (offset: number): bigint => BigInt(0x50000000 + offset);
    pages[0x10] = 10; pages.writeBigUInt64LE(pointer(0x100), 0x70); pages.writeUInt16LE(1, 0xa0); pages.writeBigUInt64LE(pointer(child), 0x100);
    pages[child + 0x10] = 8; [0, 4, 8].forEach((offset) => pages.writeFloatLE(quantum, child + 0x90 + offset));
    pages.writeBigUInt64LE(pointer(0x440), child + 0x88); pages.writeBigUInt64LE(pointer(0x400), child + 0xb0); pages.writeUInt32LE(4, child + 0xd0); pages.writeUInt32LE(2, child + 0xd4);
    pages.writeBigUInt64LE(pointer(0x480), child + 0xf0); pages.writeBigUInt64LE(pointer(0x4a0), child + 0x118); pages[child + 0x120] = 1; pages[0x480] = 1;
    [[min[0], min[1]], [max[0], min[1]], [max[0], max[1]], [min[0], max[1]]].forEach(([x, y], index) => [x, y, z].forEach((value, axis) => pages.writeInt16LE(Math.round(value / quantum), 0x400 + index * 6 + axis * 2)));
    [[0, 1, 2], [0, 2, 3]].forEach((corners, polygon) => corners.forEach((corner, index) => pages.writeUInt16LE(corner, 0x440 + polygon * 16 + 4 + index * 2)));
    const header = Buffer.alloc(16); header.write('RSC7'); header.writeUInt32LE(43, 4); header.writeUInt32LE(0x08000005, 8);
    return Buffer.concat([header, deflateRawSync(pages)]);
}

export const INTERIOR_NAME = 'test_interior', SHELL_NAME = 'test_shell', DOOR_NAME = 'test_door';
const HALF = Math.SQRT1_2;
function entity(type: string, name: string | number, position: number[], rotation: number[], extra: Record<string, unknown> = {}): MetaObject {
    return { $type: type, archetypeName: name, flags: 32, guid: 7, position, rotation, scaleXY: 1, scaleZ: 1, parentIndex: -1, lodDist: 60, childLodDist: 0,
        lodLevel: 'LODTYPES_DEPTH_ORPHANHD', numChildren: 0, priorityLevel: 'PRI_REQUIRED', ...extra };
}
/** A map that places the test interior at (100, 200, 30), turned 90 degrees counter-clockwise, beside one plain prop and a car generator. */
export function mapFixture(): MetaObject {
    return { $type: 'CMapData', name: 'test_map', parent: 0, flags: 0, contentFlags: 9, streamingExtentsMin: [50, 150, 0], streamingExtentsMax: [150, 250, 80],
        entitiesExtentsMin: [90, 190, 28], entitiesExtentsMax: [110, 210, 36], physicsDictionaries: [SHELL_NAME],
        entities: [entity('CMloInstanceDef', INTERIOR_NAME, [100, 200, 30], [0, 0, HALF, HALF], { groupId: 0, floorId: 0, defaultEntitySets: ['set_default'], numExitPortals: 1, MLOInstflags: 0 }),
            entity('CEntityDef', 0x12345678, [95.5, 190.25, 28.5], [0, 0, -HALF, HALF])],
        carGenerators: [{ $type: 'CCarGen', position: [90, 195, 28], orientX: 0, orientY: 5, perpendicularLength: 2.5, carModel: 'adder', flags: 0,
            bodyColorRemap1: -1, bodyColorRemap2: -1, bodyColorRemap3: -1, bodyColorRemap4: -1, popGroup: 0, livery: -1 }],
        block: { $type: 'CBlockDesc', version: 1, flags: 0, name: 'test_map', exportedBy: 'synthetic', owner: '', time: '' } };
}
/** Archetypes for `mapFixture`: one prop and an interior with two rooms, one portal with a door, and two entity sets. */
export function typesFixture(): MetaObject {
    const archetype = { lodDist: 80, flags: 0, specialAttribute: 0, bsCentre: [0, 0, 1.5], bsRadius: 6, hdTextureDist: 40, textureDictionary: SHELL_NAME, clipDictionary: 0, drawableDictionary: 0,
        physicsDictionary: SHELL_NAME, assetType: 'ASSET_TYPE_DRAWABLE' };
    return { $type: 'CMapTypes', name: 'test_types', dependencies: [], archetypes: [
        { $type: 'CBaseArchetypeDef', ...archetype, name: SHELL_NAME, assetName: SHELL_NAME, bbMin: [-4, -3, 0], bbMax: [4, 3, 3] },
        { $type: 'CTimeArchetypeDef', ...archetype, name: 'test_sign', assetName: 'test_sign', bbMin: [-1, -1, 0], bbMax: [1, 1, 2], timeFlags: 0x00ffffff },
        { $type: 'CMloArchetypeDef', ...archetype, name: INTERIOR_NAME, assetName: INTERIOR_NAME, bbMin: [-4, -3, 0], bbMax: [4, 3, 3], assetType: 'ASSET_TYPE_ASSETLESS', mloFlags: 0,
            entities: [entity('CEntityDef', SHELL_NAME, [0, 0, 0], [0, 0, 0, 1]), entity('CEntityDef', DOOR_NAME, [4, 0, 0.5], [0, 0, 0, 1]), entity('CEntityDef', 0xabcdef01, [-2, 1, 0.25], [0, 0, HALF, HALF])],
            rooms: [{ $type: 'CMloRoomDef', name: 'limbo', bbMin: [-4, -3, 0], bbMax: [4, 3, 3], blend: 1, timecycleName: 0, secondaryTimecycleName: 0, flags: 0, portalCount: 1, floorId: 0, attachedObjects: [] },
                { $type: 'CMloRoomDef', name: 'Office', bbMin: [-4, 3, 0.5], bbMax: [4, -3, 3], blend: 1, timecycleName: 'int_office', secondaryTimecycleName: 0, flags: 96, portalCount: 1, floorId: 0, attachedObjects: [0, 2] }],
            portals: [{ $type: 'CMloPortalDef', roomFrom: 1, roomTo: 0, flags: 0, mirrorPriority: 0, opacity: 0, audioOcclusion: 0, corners: [[4, -1, 0.5], [4, -1, 2.5], [4, 1, 2.5], [4, 1, 0.5]], attachedObjects: [1] }],
            entitySets: [{ $type: 'CMloEntitySet', name: 'set_default', locations: [1], entities: [entity('CEntityDef', 'test_crate', [1, 1, 0.5], [0, 0, 0, 1])] },
                { $type: 'CMloEntitySet', name: 'set_extra', locations: [1, 1], entities: [entity('CEntityDef', 'test_crate', [2, 2, 0.5], [0, 0, 0, 1]), entity('CEntityDef', 'test_crate', [3, 2, 0.5], [0, 0, 0, 1])] }] },
    ] };
}
