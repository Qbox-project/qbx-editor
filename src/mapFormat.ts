import { assetHash } from './assetInventory';
import { normalize, type Quat, type Vec3 } from './mapMath';
import { MetaType, parseMeta, type MetaFile, type MetaRecord } from './metaFormat';
import { metaNames } from './metaNames';
import { hashText } from './metaXml';
import { parseXml, type XmlElement } from './xmlLite';

export const MAX_MAP_XML_BYTES = 32 * 1024 * 1024;
export interface NameRef { hash: number; name?: string }
export interface RawEntity {
    archetype: NameRef; position: Vec3; rotation: Quat; scaleXY: number; scaleZ: number; flags: number; guid: number; parentIndex: number;
    lodDist: number; childLodDist: number; lodLevel: string; priorityLevel: string; numChildren: number; extensions: number;
    mlo?: { groupId: number; floorId: number; defaultEntitySets: NameRef[]; numExitPortals: number; flags: number };
}
export interface RawRoom { name: string; bbMin: Vec3; bbMax: Vec3; blend: number; timecycle: NameRef; secondaryTimecycle: NameRef; flags: number; portalCount: number; floorId: number; attachedObjects: number[] }
export interface RawPortal { roomFrom: number; roomTo: number; flags: number; mirrorPriority: number; opacity: number; audioOcclusion: number; corners: Vec3[]; attachedObjects: number[] }
export interface RawEntitySet { name: NameRef; locations: number[]; entities: RawEntity[] }
export interface RawInterior { flags: number; entities: RawEntity[]; rooms: RawRoom[]; portals: RawPortal[]; entitySets: RawEntitySet[]; timeCycleModifiers: number }
export interface RawArchetype {
    kind: 'base' | 'time' | 'mlo'; name: NameRef; assetName: NameRef; lodDist: number; hdTextureDist: number; flags: number; specialAttribute: number;
    bbMin: Vec3; bbMax: Vec3; bsCentre: Vec3; bsRadius: number; textureDictionary: NameRef; clipDictionary: NameRef; drawableDictionary: NameRef;
    physicsDictionary: NameRef; assetType: string; extensions: number; timeFlags?: number; mlo?: RawInterior;
}
export interface RawCarGenerator { position: Vec3; orientX: number; orientY: number; perpendicularLength: number; model: NameRef; flags: number; bodyColors: number[]; popGroup: NameRef; livery: number }
export interface MapDocument {
    kind: 'ymap'; source: 'binary' | 'xml'; name: NameRef; parent: NameRef; flags: number; contentFlags: number;
    streamingExtents: [Vec3, Vec3]; entitiesExtents: [Vec3, Vec3]; entities: RawEntity[]; carGenerators: RawCarGenerator[];
    physicsDictionaries: NameRef[]; counts: { name: string; value: number }[]; block?: { name: string; exportedBy: string; owner: string; time: string };
}
export interface TypesDocument { kind: 'ytyp'; source: 'binary' | 'xml'; name: NameRef; archetypes: RawArchetype[]; dependencies: NameRef[]; compositeEntityTypes: number; extensions: number }
export type MapFile = MapDocument | TypesDocument;

export function nameRef(text: string): NameRef {
    const value = text.trim();
    if (!value) { return { hash: 0 }; }
    const hex = /^(?:hash_|0x)([0-9a-f]{1,8})$/i.exec(value);
    if (hex) { return { hash: parseInt(hex[1], 16) }; }
    try { return { hash: assetHash(value), name: value }; } catch { return { hash: 0, name: value }; }
}
function vec3(values: number[]): Vec3 { return [values[0] || 0, values[1] || 0, values[2] || 0]; }

interface Source {
    readonly type: string;
    num(name: string): number;
    ref(name: string): NameRef;
    vec(name: string): number[];
    str(name: string): string;
    enumText(name: string): string;
    child(name: string): Source | undefined;
    list(name: string): Source[];
    nums(name: string): number[];
    refs(name: string): NameRef[];
    vecs(name: string): Vec3[];
    size(name: string): number;
}

class BinarySource implements Source {
    constructor(private readonly record: MetaRecord) {}
    get type(): string { return metaNames().get(this.record.type) ?? hashText(this.record.type); }
    num(name: string): number { return this.record.number(name) ?? 0; }
    ref(name: string): NameRef { return { hash: this.record.number(name) ?? 0 }; }
    vec(name: string): number[] { return this.record.vector(name) ?? []; }
    str(name: string): string { return this.record.text(name) ?? ''; }
    enumText(name: string): string {
        const entry = this.record.entry(name), value = this.record.number(name);
        if (!entry || value === undefined) { return ''; }
        const label = entry.type === MetaType.IntEnum || entry.type === MetaType.ByteEnum ? this.record.file.enums.get(entry.referenceKey)?.values.get(value) : undefined;
        return label === undefined ? String(value) : metaNames().get(label) ?? hashText(label);
    }
    child(name: string): Source | undefined { const record = this.record.record(name); return record && new BinarySource(record); }
    list(name: string): Source[] { return this.record.records(name).map((record) => new BinarySource(record)); }
    nums(name: string): number[] { return this.record.numbers(name); }
    refs(name: string): NameRef[] { return this.record.numbers(name).map((hash) => ({ hash })); }
    vecs(name: string): Vec3[] { return this.record.vectors(name).map(vec3); }
    size(name: string): number { return this.record.count(name); }
}

function numeric(text: string | undefined): number {
    const value = (text ?? '').trim().toLowerCase();
    if (value === 'true') { return 1; }
    const number = /^-?0x[0-9a-f]+$/.test(value) ? parseInt(value, 16) : Number(value);
    return Number.isFinite(number) ? number : 0;
}
function words(text: string): string[] { return text.split(/[\s,]+/).filter(Boolean); }
class XmlSource implements Source {
    constructor(private readonly element: XmlElement, readonly type: string) {}
    private field(name: string): XmlElement | undefined { return this.element.children.find((child) => child.name === name); }
    private entries(name: string): XmlElement[] { return this.field(name)?.children.filter((child) => child.name.toLowerCase() === 'item') ?? []; }
    num(name: string): number { const field = this.field(name); return field ? numeric(field.attributes.value ?? field.text) : 0; }
    ref(name: string): NameRef { return nameRef(this.field(name)?.text ?? ''); }
    vec(name: string): number[] {
        const attributes = this.field(name)?.attributes;
        return attributes ? ['x', 'y', 'z', 'w'].filter((axis) => attributes[axis] !== undefined).map((axis) => Math.fround(numeric(attributes[axis]))) : [];
    }
    str(name: string): string { return (this.field(name)?.text ?? '').trim(); }
    enumText(name: string): string { const field = this.field(name); return (field?.attributes.value ?? field?.text ?? '').trim(); }
    child(name: string): Source | undefined { const field = this.field(name); return field && new XmlSource(field, field.attributes.type ?? name); }
    list(name: string): Source[] {
        const itemType = this.field(name)?.attributes.itemType ?? '';
        return this.entries(name).map((item) => new XmlSource(item, item.attributes.type ?? itemType));
    }
    nums(name: string): number[] {
        const items = this.entries(name);
        return items.length ? items.map((item) => numeric(item.attributes.value ?? item.text)) : words(this.field(name)?.text ?? '').map(numeric);
    }
    refs(name: string): NameRef[] {
        const items = this.entries(name);
        return (items.length ? items.map((item) => item.text) : words(this.field(name)?.text ?? '')).map(nameRef);
    }
    vecs(name: string): Vec3[] {
        const items = this.entries(name), float = (text: string | undefined): number => Math.fround(numeric(text));
        if (items.length) { return items.map((item) => item.attributes.x !== undefined ? vec3(['x', 'y', 'z'].map((axis) => float(item.attributes[axis]))) : vec3(words(item.text).map(float))); }
        return (this.field(name)?.text ?? '').split(/\r?\n/).map((line) => words(line).map(float)).filter((values) => values.length >= 3).map(vec3);
    }
    size(name: string): number { return this.entries(name).length || words(this.field(name)?.text ?? '').length; }
}

function entity(source: Source): RawEntity {
    const rotation = source.vec('rotation');
    const result: RawEntity = {
        archetype: source.ref('archetypeName'), position: vec3(source.vec('position')),
        rotation: normalize(rotation.length === 4 ? rotation as Quat : [0, 0, 0, 1]), scaleXY: source.num('scaleXY'), scaleZ: source.num('scaleZ'),
        flags: source.num('flags') >>> 0, guid: source.num('guid') >>> 0, parentIndex: source.num('parentIndex'), lodDist: source.num('lodDist'),
        childLodDist: source.num('childLodDist'), lodLevel: source.enumText('lodLevel'), priorityLevel: source.enumText('priorityLevel'),
        numChildren: source.num('numChildren'), extensions: source.size('extensions'),
    };
    if (source.type === 'CMloInstanceDef') {
        result.mlo = { groupId: source.num('groupId'), floorId: source.num('floorId'), defaultEntitySets: source.refs('defaultEntitySets'),
            numExitPortals: source.num('numExitPortals'), flags: source.num('MLOInstflags') >>> 0 };
    }
    return result;
}
function interior(source: Source): RawInterior {
    return {
        flags: source.num('mloFlags') >>> 0, entities: source.list('entities').map(entity), timeCycleModifiers: source.size('timeCycleModifiers'),
        rooms: source.list('rooms').map((room) => ({ name: room.str('name'), bbMin: vec3(room.vec('bbMin')), bbMax: vec3(room.vec('bbMax')), blend: room.num('blend'),
            timecycle: room.ref('timecycleName'), secondaryTimecycle: room.ref('secondaryTimecycleName'), flags: room.num('flags') >>> 0,
            portalCount: room.num('portalCount'), floorId: room.num('floorId'), attachedObjects: room.nums('attachedObjects') })),
        portals: source.list('portals').map((portal) => ({ roomFrom: portal.num('roomFrom'), roomTo: portal.num('roomTo'), flags: portal.num('flags') >>> 0,
            mirrorPriority: portal.num('mirrorPriority'), opacity: portal.num('opacity'), audioOcclusion: portal.num('audioOcclusion') >>> 0,
            corners: portal.vecs('corners'), attachedObjects: portal.nums('attachedObjects') })),
        entitySets: source.list('entitySets').map((set) => ({ name: set.ref('name'), locations: set.nums('locations'), entities: set.list('entities').map(entity) })),
    };
}
function archetype(source: Source): RawArchetype {
    const kind = source.type === 'CMloArchetypeDef' ? 'mlo' : source.type === 'CTimeArchetypeDef' ? 'time' : 'base';
    const result: RawArchetype = {
        kind, name: source.ref('name'), assetName: source.ref('assetName'), lodDist: source.num('lodDist'), hdTextureDist: source.num('hdTextureDist'),
        flags: source.num('flags') >>> 0, specialAttribute: source.num('specialAttribute') >>> 0, bbMin: vec3(source.vec('bbMin')), bbMax: vec3(source.vec('bbMax')),
        bsCentre: vec3(source.vec('bsCentre')), bsRadius: source.num('bsRadius'), textureDictionary: source.ref('textureDictionary'),
        clipDictionary: source.ref('clipDictionary'), drawableDictionary: source.ref('drawableDictionary'), physicsDictionary: source.ref('physicsDictionary'),
        assetType: source.enumText('assetType'), extensions: source.size('extensions'),
    };
    if (kind === 'time') { result.timeFlags = source.num('timeFlags') >>> 0; }
    if (kind === 'mlo') { result.mlo = interior(source); }
    return result;
}
function mapDocument(root: Source, source: 'binary' | 'xml'): MapDocument {
    const instanced = root.child('instancedData'), block = root.child('block');
    const counts = [
        { name: 'Time cycle modifiers', value: root.size('timeCycleModifiers') }, { name: 'Box occluders', value: root.size('boxOccluders') },
        { name: 'Occlusion models', value: root.size('occludeModels') }, { name: 'Container LODs', value: root.size('containerLods') },
        { name: 'LOD lights', value: root.child('LODLightsSOA')?.size('direction') ?? 0 }, { name: 'Distant LOD lights', value: root.child('DistantLODLightsSOA')?.size('position') ?? 0 },
        { name: 'Grass batches', value: instanced?.size('GrassInstanceList') ?? 0 }, { name: 'Instanced prop batches', value: instanced?.size('PropInstanceList') ?? 0 },
    ].filter((row) => row.value > 0);
    return {
        kind: 'ymap', source, name: root.ref('name'), parent: root.ref('parent'), flags: root.num('flags') >>> 0, contentFlags: root.num('contentFlags') >>> 0,
        streamingExtents: [vec3(root.vec('streamingExtentsMin')), vec3(root.vec('streamingExtentsMax'))],
        entitiesExtents: [vec3(root.vec('entitiesExtentsMin')), vec3(root.vec('entitiesExtentsMax'))],
        entities: root.list('entities').map(entity), physicsDictionaries: root.refs('physicsDictionaries'), counts,
        carGenerators: root.list('carGenerators').map((car) => ({ position: vec3(car.vec('position')), orientX: car.num('orientX'), orientY: car.num('orientY'),
            perpendicularLength: car.num('perpendicularLength'), model: car.ref('carModel'), flags: car.num('flags') >>> 0,
            bodyColors: [1, 2, 3, 4].map((index) => car.num(`bodyColorRemap${index}`)), popGroup: car.ref('popGroup'), livery: car.num('livery') })),
        block: block && { name: block.str('name'), exportedBy: block.str('exportedBy'), owner: block.str('owner'), time: block.str('time') },
    };
}
function typesDocument(root: Source, source: 'binary' | 'xml'): TypesDocument {
    return { kind: 'ytyp', source, name: root.ref('name'), archetypes: root.list('archetypes').map(archetype), dependencies: root.refs('dependencies'),
        compositeEntityTypes: root.size('compositeEntityTypes'), extensions: root.size('extensions') };
}
function build(root: Source, source: 'binary' | 'xml'): MapFile {
    if (root.type === 'CMapData') { return mapDocument(root, source); }
    if (root.type === 'CMapTypes') { return typesDocument(root, source); }
    throw new Error(`This file holds ${root.type} data; the map viewer reads map data (CMapData) and archetype definitions (CMapTypes).`);
}
export function isXml(data: Buffer): boolean {
    let at = data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? 3 : 0;
    while (at < data.length && (data[at] === 0x20 || data[at] === 0x09 || data[at] === 0x0a || data[at] === 0x0d)) { at++; }
    return data[at] === 0x3c;
}
/** Reads binary (RSC7 Meta) or XML map data. `meta` is present for binary files so they can be exported as XML. */
export async function readMapFile(data: Buffer): Promise<{ document: MapFile; meta?: MetaFile }> {
    if (isXml(data)) {
        if (data.length > MAX_MAP_XML_BYTES) { throw new Error('This XML file exceeds the 32 MiB inspection limit.'); }
        const root = parseXml(data.toString('utf8'));
        return { document: build(new XmlSource(root, root.name), 'xml') };
    }
    const meta = await parseMeta(data);
    return { document: build(new BinarySource(meta.root()), 'binary'), meta };
}
