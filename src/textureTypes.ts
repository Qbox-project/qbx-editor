import type { AssetTexture, TextureEncoding } from './assetTypes';
import type { EncodeOptions } from './textureEncode';

export interface TextureView {
    snapshotId: string; title: string; path: string; dictionary: string; kind: 'ytd' | 'dds'; textures: AssetTexture[]; notes: string[];
    /** Why the file cannot be edited; absent when it can. */
    readOnly?: string;
    dirty: boolean; memory: number;
    /** The texture an edit just touched, which the list selects. */
    focus?: string;
}
export interface TexturePixels { textureId: number; mip: number; width: number; height: number; encoding: TextureEncoding; data: Uint8Array }
export type TextureMessage = { type: 'loading' } | { type: 'state'; data: TextureView } | { type: 'error'; message: string } | { type: 'status'; message: string }
    | { type: 'pixels'; requestId: number; data: TexturePixels } | { type: 'noPixels'; requestId: number; message: string };
export type TextureAction = { type: 'ready' } | { type: 'reload' } | { type: 'loaded'; snapshotId: string } | { type: 'copy'; text: string; label: string }
    | { type: 'pixels'; textureId: number; mip: number; requestId: number } | { type: 'drawn'; snapshotId: string; textureId: number; width: number; height: number }
    | { type: 'add'; snapshotId: string; options?: EncodeOptions } | { type: 'exportAll'; snapshotId: string } | { type: 'replace'; snapshotId: string; textureId: number; options?: EncodeOptions }
    | { type: 'remove' | 'rename' | 'export'; snapshotId: string; textureId: number };
