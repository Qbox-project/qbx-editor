import type { ResourceIdentity, ResourceLocation } from './resourceDetailsTypes';

export interface AssetDeclaration { kind: string; value: string; dataType?: string; location: ResourceLocation }
export interface AssetReference {
    kind: 'model' | 'textureDictionary' | 'texture' | 'particleAsset' | 'audioBank';
    value?: string; hash?: number; dictionary?: string; location: ResourceLocation;
}
export interface ResourceAssets {
    resource: ResourceIdentity; declarations: AssetDeclaration[]; references: AssetReference[];
    truncated: { declarations: number; references: number }; notes: string[];
}
export type AssetRequest = (method: 'qbx/resourceAssets', params: { uri: string }) => Promise<unknown>;
export type AssetCategory = 'texture' | 'model' | 'map' | 'image' | 'audio' | 'video' | 'metadata' | 'other';
export interface AssetIssue { severity: 'warning' | 'info'; message: string; assetId?: string; sourceId?: string; source?: string }
export interface AssetEntry { id: string; path: string; name: string; category: AssetCategory; extension: string; size: number; hash?: number; format: string; issues: string[] }
export interface AssetReferenceView { id: string; kind: string; name: string; source: string; resolved: boolean; targets: { id: string; path: string }[]; targetCount: number; note?: string }
export interface AssetView {
    snapshotId: string; resource: { name: string; path: string }; entries: AssetEntry[]; references: AssetReferenceView[];
    issues: AssetIssue[]; notes: string[]; totalBytes: number;
}
export type TextureEncoding = 'BC1' | 'BC2' | 'BC3' | 'BC4' | 'BC5' | 'BC7' | 'RGBA8' | 'BGRA8' | 'BGRX8' | 'R8' | 'A8';
export interface AssetTexture {
    id: number; name: string; width: number; height: number; mipCount: number; format: string;
    encoding?: TextureEncoding; previewMip?: number; notes: string[];
}
export interface AssetDetail {
    id: string; title: string; metadata: { name: string; value: string }[]; notes: string[];
    textures?: AssetTexture[]; text?: string; media?: { mime: string; data: string; kind: 'image' | 'audio' | 'video' };
}
export interface AssetPixels { assetId: string; textureId: number; mip: number; width: number; height: number; encoding: TextureEncoding; data: string }
export type AssetMessage = { type: 'loading' } | { type: 'state'; data: AssetView }
    | { type: 'detail'; requestId: number; data: AssetDetail } | { type: 'pixels'; requestId: number; data: AssetPixels }
    | { type: 'referenceMatches'; requestId: number; assetId: string; ids: string[]; incomplete: boolean }
    | { type: 'error'; requestId?: number; message: string };
export type AssetAction = { type: 'ready' | 'choose' | 'refresh' } | { type: 'loaded'; snapshotId: string } | { type: 'detail' | 'findReferences'; id: string; requestId: number }
    | { type: 'texture'; id: string; textureId: number; mip: number; requestId: number }
    | { type: 'openAsset' | 'openSource' | 'copyName' | 'copyHash'; id: string };
