import type { TextureEncoding } from './assetTypes';

export type ModelVec3 = [number, number, number];
export interface ModelLodView { level: number; name: string; distance: number; vertices: number; triangles: number; geometries: number }
export interface ModelMaterialView { shader: string; diffuse?: string; textures: string[] }
export interface ModelDrawableView {
    id: number; name: string; min: ModelVec3; max: ModelVec3; center: ModelVec3; radius: number; lods: ModelLodView[];
    materials: ModelMaterialView[]; embeddedTextures: number; skeleton: boolean; lights: number; notes: string[];
}
export interface ModelCollisionView { kinds: { name: string; count: number }[]; polygons: number; triangles: number; vertices: number; materials: { type: number; triangles: number }[] }
export interface ModelView {
    snapshotId: string; kind: 'ydr' | 'ydd' | 'yft' | 'ybn'; title: string; path: string; drawables: ModelDrawableView[];
    collision?: ModelCollisionView; notes: string[];
}
export interface ModelMeshRange { material: number; vertexCount: number; indexCount: number; positions: number; normals: number; uvs: number; colours: number; indices: number }
export interface ModelMesh { drawable: number; lod: number; buffer: Uint8Array; meshes: ModelMeshRange[]; notes: string[] }
export interface ModelTexture { name: string; source: string; width: number; height: number; encoding: TextureEncoding; data: Uint8Array }
export type ModelMessage = { type: 'loading' } | { type: 'state'; data: ModelView } | { type: 'error'; message: string } | { type: 'status'; message: string }
    | { type: 'mesh'; requestId: number; data: ModelMesh } | { type: 'meshError'; requestId: number; message: string }
    | { type: 'texture'; requestId: number; data: ModelTexture } | { type: 'texturesDone'; requestId: number; missing: string[] };
export type ModelAction = { type: 'ready' | 'reload' } | { type: 'loaded'; snapshotId: string } | { type: 'rendered'; snapshotId: string; drawable: number; triangles: number }
    | { type: 'mesh'; drawable: number; lod: number; requestId: number } | { type: 'textures'; drawable: number; requestId: number } | { type: 'copy'; text: string; label: string };
