import type { ResourceIdentity, ResourceLocation } from './resourceDetailsTypes';

export interface NuiResource {
    resource: ResourceIdentity;
    uiPage: string | null;
    callbacks: { name: string; location: ResourceLocation }[];
    truncated: number;
    notes: string[];
}
export type NuiRequest = (method: 'qbx/nuiResource', params: { uri: string }) => Promise<unknown>;
export interface NuiPreset { name: string; message: string; mocks: string }
export interface NuiView {
    resource: { name: string; path: string; uri: string };
    uiPage: string | null;
    frameUrl: string | null;
    token: string | null;
    callbacks: { id: string; name: string; source: string }[];
    truncated: number;
    notes: string[];
    presets: NuiPreset[];
}
export type NuiMessage = { type: 'state'; data: NuiView } | { type: 'notice' | 'error'; message: string };
export type NuiAction = { type: 'ready' | 'chooseResource' | 'reload' }
    | { type: 'openSource'; id: string }
    | { type: 'savePreset'; preset: NuiPreset }
    | { type: 'deletePreset'; name: string }
    | { type: 'previewReady'; token: string };
