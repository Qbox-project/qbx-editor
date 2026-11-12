import type { Quat, Vec3 } from './mapMath';

export interface MapEntityRow {
    id: number; name: string; hash: number; position: Vec3; rotation: Quat; heading: number; scale: [number, number];
    lodDist: number; lodLevel: string; flags: number; group: number; kind: 'entity' | 'interior'; size?: Vec3; room?: number; portal?: number;
}
export interface MapGroup { label: string; kind: 'map' | 'interior' | 'entitySet'; interior?: number; enabled: boolean }
export interface MapRoom {
    index: number; name: string; center: Vec3; size: Vec3; corners: [number, number][]; floor: number; ceiling: number;
    portalCount: number; flags: number; timecycle: string; entityCount: number; surface?: number;
}
export interface MapPortal { index: number; roomFrom: number; roomTo: number; flags: number; corners: Vec3[]; center: Vec3; attached: number }
export interface MapEntitySet { name: string; hash: number; entityCount: number; enabledByDefault: boolean; group: number }
export interface MapInterior {
    name: string; hash: number; placed: boolean; position: Vec3; rotation: Quat; heading: number; tilt: number; definedIn: string; placedIn?: string;
    placements: number; rooms: MapRoom[]; portals: MapPortal[]; entitySets: MapEntitySet[]; entityCount: number; group: number;
    collision?: { files: string[]; triangles: number };
}
export interface MapArchetypeRow {
    id: number; name: string; hash: number; kind: 'base' | 'time' | 'mlo'; size: Vec3; lodDist: number; assetType: string;
    textureDictionary: string; drawableDictionary: string; physicsDictionary: string; clipDictionary: string; flags: number; placements: number;
}
export interface MapCarGenerator { id: number; model: string; hash: number; position: Vec3; heading: number; length: number; flags: number; colors: number[]; livery: number }
export interface MapRelatedFile { id: string; label: string; role: string }
export interface MapView {
    snapshotId: string; kind: 'ymap' | 'ytyp'; source: 'binary' | 'xml'; title: string; path: string;
    facts: { name: string; value: string }[]; notes: string[]; groups: MapGroup[]; entities: MapEntityRow[]; interiors: MapInterior[];
    archetypes: MapArchetypeRow[]; carGenerators: MapCarGenerator[]; related: MapRelatedFile[]; bounds?: [Vec3, Vec3];
}
export type MapMessage = { type: 'loading' } | { type: 'state'; data: MapView } | { type: 'error'; message: string } | { type: 'status'; message: string }
    | { type: 'surfaces'; requestId: number; heights: number[] };
export type MapAction = { type: 'ready' | 'reload' | 'exportXml' | 'openText' } | { type: 'loaded'; snapshotId: string }
    | { type: 'copy'; text: string; label: string } | { type: 'openRelated'; id: string }
    | { type: 'surfaces'; requestId: number; interior: number; x: number; y: number; low: number; high: number };
