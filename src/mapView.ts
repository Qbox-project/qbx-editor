import { add, conjugate, heading, IDENTITY, multiply, rotate, tilt, type Quat, type Vec3 } from './mapMath';
import type { MapDocument, MapFile, NameRef, RawArchetype, RawEntity, TypesDocument } from './mapFormat';
import type { MapArchetypeRow, MapEntityRow, MapInterior, MapRelatedFile, MapView } from './mapTypes';

export const MAX_MAP_ROWS = 60_000;
export interface LinkedMapFile { id: string; label: string; document: MapFile }
export interface MapContext { names: ReadonlyMap<number, string>; files: readonly LinkedMapFile[] }
interface Placement { position: Vec3; rotation: Quat; placedIn: string; defaultSets: NameRef[] }

const CONTENT_FLAGS = ['HD entities', 'LOD entities', 'SLOD2+ entities', 'interiors', 'SLOD entities', 'occlusion', 'physics', 'LOD lights', 'distant LOD lights', 'critical', 'grass'];
const MAP_FLAGS = ['script managed', 'has LOD children'];
export function hexHash(hash: number): string { return `0x${(hash >>> 0).toString(16).toUpperCase().padStart(8, '0')}`; }
function flagText(value: number, labels: string[]): string {
    const set = labels.filter((_label, bit) => value & (1 << bit));
    return `${value}${set.length ? ` (${set.join(', ')})` : ''}`;
}
function round(value: number): number { return Math.round(value * 1000) / 1000; }
function vector(value: Vec3): string { return value.map((part) => round(part)).join(', '); }
function extents(value: [Vec3, Vec3]): string {
    return `${vector(value[0])} to ${vector(value[1])} (${value[1].map((max, axis) => round(max - value[0][axis])).join(' × ')} m)`;
}

export function buildMapView(document: MapFile, title: string, path: string, context: MapContext): Omit<MapView, 'snapshotId'> {
    const label = (ref: NameRef): string => ref.name ?? context.names.get(ref.hash) ?? (ref.hash ? hexHash(ref.hash) : '');
    const view: Omit<MapView, 'snapshotId'> = { kind: document.kind, source: document.source, title, path, facts: [], notes: [], groups: [], entities: [],
        interiors: [], archetypes: [], carGenerators: [], related: [] };
    const related = new Map<string, MapRelatedFile>();
    const archetypes = new Map<number, { archetype: RawArchetype; file?: LinkedMapFile }>();
    const placements = new Map<number, { count: number; first?: Placement; file?: LinkedMapFile }>();
    const index = (types: TypesDocument, file?: LinkedMapFile): void => {
        for (const archetype of types.archetypes) { if (archetype.name.hash && !archetypes.has(archetype.name.hash)) { archetypes.set(archetype.name.hash, { archetype, file }); } }
    };
    const place = (map: MapDocument, placedIn: string, file?: LinkedMapFile): void => {
        for (const entity of map.entities) {
            const entry = placements.get(entity.archetype.hash) ?? { count: 0 };
            entry.count++;
            if (entity.mlo && !entry.first) { entry.first = { position: entity.position, rotation: entity.rotation, placedIn, defaultSets: entity.mlo.defaultEntitySets }; entry.file = file; }
            placements.set(entity.archetype.hash, entry);
        }
    };
    if (document.kind === 'ytyp') { index(document); } else { place(document, title); }
    for (const file of context.files) { if (file.document.kind === 'ytyp') { index(file.document, file); } else { place(file.document, file.label, file); } }
    const relate = (file: LinkedMapFile | undefined, role: string): void => { if (file && !related.has(file.id)) { related.set(file.id, { id: file.id, label: file.label, role }); } };
    let truncated = false, unresolved = 0;
    const row = (entity: RawEntity, position: Vec3, rotation: Quat, group: number, room?: number, portal?: number): void => {
        if (view.entities.length >= MAX_MAP_ROWS) { truncated = true; return; }
        const known = archetypes.get(entity.archetype.hash)?.archetype, name = label(entity.archetype);
        if (name.startsWith('0x')) { unresolved++; }
        const result: MapEntityRow = { id: view.entities.length, name, hash: entity.archetype.hash, position, rotation, heading: heading(rotation), scale: [entity.scaleXY, entity.scaleZ],
            lodDist: entity.lodDist, lodLevel: entity.lodLevel, flags: entity.flags, group, kind: entity.mlo ? 'interior' : 'entity' };
        if (known) { result.size = [0, 1, 2].map((axis) => Math.abs(known.bbMax[axis] - known.bbMin[axis])) as Vec3; }
        if (room !== undefined) { result.room = room; }
        if (portal !== undefined) { result.portal = portal; }
        view.entities.push(result);
    };
    const interior = (archetype: RawArchetype, definedIn: string, placement: Placement | undefined, count: number): void => {
        const data = archetype.mlo!, origin = placement?.position ?? [0, 0, 0], rotation = placement?.rotation ?? IDENTITY, name = label(archetype.name);
        const world = (local: Vec3): Vec3 => add(origin, rotate(rotation, local));
        const number = view.interiors.length, group = view.groups.push({ label: `Interior · ${name}`, kind: 'interior', interior: number, enabled: true }) - 1;
        const rooms = new Map<number, number>(), portals = new Map<number, number>();
        data.rooms.forEach((room, roomIndex) => { for (const attached of room.attachedObjects) { if (!rooms.has(attached)) { rooms.set(attached, roomIndex); } } });
        data.portals.forEach((portal, portalIndex) => { for (const attached of portal.attachedObjects) { if (!portals.has(attached)) { portals.set(attached, portalIndex); } } });
        data.entities.forEach((entity, entityIndex) => row(entity, world(entity.position), multiply(rotation, conjugate(entity.rotation)), group, rooms.get(entityIndex), portals.get(entityIndex)));
        const result: MapInterior = { name, hash: archetype.name.hash, placed: placement !== undefined, position: origin, rotation, heading: heading(rotation), tilt: tilt(rotation),
            definedIn, placedIn: placement?.placedIn, placements: count, rooms: [], portals: [], entitySets: [], entityCount: data.entities.length, group };
        for (const [roomIndex, room] of data.rooms.entries()) {
            const min = room.bbMin.map((value, axis) => Math.min(value, room.bbMax[axis])) as Vec3, max = room.bbMin.map((value, axis) => Math.max(value, room.bbMax[axis])) as Vec3;
            const corners = [[min[0], min[1]], [max[0], min[1]], [max[0], max[1]], [min[0], max[1]]].flatMap(([x, y]) => [world([x, y, min[2]]), world([x, y, max[2]])]);
            const heights = corners.map((corner) => corner[2]);
            result.rooms.push({ index: roomIndex, name: room.name || `room ${roomIndex}`, center: world([(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]),
                size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]], corners: [0, 2, 4, 6].map((corner) => [corners[corner][0], corners[corner][1]]),
                floor: Math.min(...heights), ceiling: Math.max(...heights), portalCount: room.portalCount, flags: room.flags, timecycle: label(room.timecycle), entityCount: room.attachedObjects.length });
        }
        for (const [portalIndex, portal] of data.portals.entries()) {
            const corners = portal.corners.slice(0, 8).map(world);
            const center = corners.length ? corners.reduce((sum, corner) => add(sum, corner), [0, 0, 0] as Vec3).map((value) => value / corners.length) as Vec3 : world([0, 0, 0]);
            result.portals.push({ index: portalIndex, roomFrom: portal.roomFrom, roomTo: portal.roomTo, flags: portal.flags, corners, center, attached: portal.attachedObjects.length });
        }
        for (const set of data.entitySets) {
            const enabled = placement?.defaultSets.some((entry) => entry.hash === set.name.hash) ?? false;
            const setGroup = view.groups.push({ label: `Entity set · ${label(set.name)}`, kind: 'entitySet', interior: number, enabled }) - 1;
            set.entities.forEach((entity, entityIndex) => row(entity, world(entity.position), multiply(rotation, conjugate(entity.rotation)), setGroup, set.locations[entityIndex]));
            result.entitySets.push({ name: label(set.name), hash: set.name.hash, entityCount: set.entities.length, enabledByDefault: enabled, group: setGroup });
        }
        if (result.tilt > 0.5) { view.notes.push(`Interior ${name} is tilted ${round(result.tilt)}° from vertical; room boxes are shown by their rotated corners.`); }
        view.interiors.push(result);
    };

    if (document.kind === 'ymap') {
        view.groups.push({ label: 'Map entities', kind: 'map', enabled: true });
        const interiors: { entity: RawEntity; definition: { archetype: RawArchetype; file?: LinkedMapFile } }[] = [];
        for (const entity of document.entities) {
            row(entity, entity.position, entity.mlo ? entity.rotation : conjugate(entity.rotation), 0);
            if (!entity.mlo) { continue; }
            const definition = archetypes.get(entity.archetype.hash);
            if (definition?.archetype.mlo) { interiors.push({ entity, definition }); }
            else { view.notes.push(`Interior ${label(entity.archetype)} is placed here, but no archetype file (.ytyp) in this resource defines it; its rooms and entities are unavailable.`); }
        }
        for (const { entity, definition } of interiors) {
            relate(definition.file, 'defines interior');
            interior(definition.archetype, definition.file?.label ?? title, { position: entity.position, rotation: entity.rotation, placedIn: title, defaultSets: entity.mlo!.defaultEntitySets },
                placements.get(entity.archetype.hash)?.count ?? 1);
        }
        document.carGenerators.forEach((car, id) => view.carGenerators.push({ id, model: label(car.model) || label(car.popGroup) || '(any)', hash: car.model.hash, position: car.position,
            heading: ((Math.atan2(-car.orientX, car.orientY) * 180 / Math.PI) % 360 + 360) % 360, length: Math.hypot(car.orientX, car.orientY), flags: car.flags, colors: car.bodyColors, livery: car.livery }));
        const interiorCount = document.entities.filter((entity) => entity.mlo).length;
        view.facts.push({ name: 'Name', value: label(document.name) || '(none)' }, { name: 'Parent map', value: label(document.parent) || '(none)' },
            { name: 'Entities', value: `${document.entities.length.toLocaleString('en-US')}${interiorCount ? ` (${interiorCount} interior ${interiorCount === 1 ? 'placement' : 'placements'})` : ''}` },
            { name: 'Car generators', value: String(document.carGenerators.length) }, { name: 'Flags', value: flagText(document.flags, MAP_FLAGS) },
            { name: 'Content flags', value: flagText(document.contentFlags, CONTENT_FLAGS) }, { name: 'Entity extents', value: extents(document.entitiesExtents) },
            { name: 'Streaming extents', value: extents(document.streamingExtents) });
        if (document.physicsDictionaries.length) { view.facts.push({ name: 'Physics dictionaries', value: document.physicsDictionaries.map(label).join(', ') }); }
        for (const count of document.counts) { view.facts.push({ name: count.name, value: count.value.toLocaleString('en-US') }); }
        if (document.block?.exportedBy || document.block?.time) { view.facts.push({ name: 'Exported', value: [document.block.exportedBy, document.block.time].filter(Boolean).join(' · ') }); }
        view.bounds = document.entitiesExtents;
    } else {
        document.archetypes.forEach((archetype, id) => {
            const result: MapArchetypeRow = { id, name: label(archetype.name), hash: archetype.name.hash, kind: archetype.kind,
                size: [0, 1, 2].map((axis) => Math.abs(archetype.bbMax[axis] - archetype.bbMin[axis])) as Vec3, lodDist: archetype.lodDist, assetType: archetype.assetType,
                textureDictionary: label(archetype.textureDictionary), drawableDictionary: label(archetype.drawableDictionary), physicsDictionary: label(archetype.physicsDictionary),
                clipDictionary: label(archetype.clipDictionary), flags: archetype.flags, placements: placements.get(archetype.name.hash)?.count ?? 0 };
            view.archetypes.push(result);
            if (archetype.mlo) {
                const placement = placements.get(archetype.name.hash);
                relate(placement?.file, 'places interior');
                interior(archetype, title, placement?.first, placement?.count ?? 0);
                if (!placement?.first) { view.notes.push(`No map file (.ymap) in this resource places interior ${result.name}; its coordinates are relative to the interior origin, not world positions.`); }
                else if (placement.count > 1) { view.notes.push(`Interior ${result.name} is placed ${placement.count} times; world positions use the placement in ${placement.first.placedIn}.`); }
            }
        });
        const kinds = (['base', 'time', 'mlo'] as const).map((kind) => [kind, document.archetypes.filter((archetype) => archetype.kind === kind).length] as const).filter(([, count]) => count);
        view.facts.push({ name: 'Name', value: label(document.name) || '(none)' },
            { name: 'Archetypes', value: `${document.archetypes.length.toLocaleString('en-US')}${kinds.length ? ` (${kinds.map(([kind, count]) => `${count} ${kind === 'mlo' ? 'interior' : kind}`).join(', ')})` : ''}` });
        if (document.dependencies.length) { view.facts.push({ name: 'Dependencies', value: document.dependencies.map(label).join(', ') }); }
        if (document.compositeEntityTypes) { view.facts.push({ name: 'Composite entity types', value: String(document.compositeEntityTypes) }); }
    }
    view.facts.push({ name: 'Format', value: document.source === 'xml' ? 'XML text' : 'Binary (RSC7 Meta)' });
    if (truncated) { view.notes.push(`Only the first ${MAX_MAP_ROWS.toLocaleString('en-US')} entities are listed.`); }
    if (unresolved) { view.notes.push(`${unresolved.toLocaleString('en-US')} of ${view.entities.length.toLocaleString('en-US')} model names are shown as hashes. Binary files store only hashes; names come from asset files in the same resource and from the name lists in the qbxLua.assets.nameLists setting.`); }
    view.related = [...related.values()];
    return view;
}
