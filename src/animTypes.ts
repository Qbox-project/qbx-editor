export interface AnimClipRow { id: number; name: string; hash: number; kind: 'animation' | 'list' | 'other'; duration: number; rate: number; frames: number; fps: number; bones: number; path: string }
export interface AnimView { snapshotId: string; title: string; path: string; dictionary: string; clips: AnimClipRow[]; animations: number; notes: string[] }
export interface AnimPlayback {
    clip: number; frames: number; duration: number; start: number; end: number; rate: number; names: string[]; parents: number[];
    positions: Uint8Array; rotations: Uint8Array; notes: string[];
}
export type AnimMessage = { type: 'loading' } | { type: 'state'; data: AnimView } | { type: 'error'; message: string } | { type: 'status'; message: string }
    | { type: 'animation'; requestId: number; data: AnimPlayback } | { type: 'noAnimation'; requestId: number; clip: number; message: string };
export type AnimAction = { type: 'ready' | 'reload' } | { type: 'loaded'; snapshotId: string } | { type: 'copy'; text: string; label: string }
    | { type: 'animation'; clip: number; requestId: number } | { type: 'played'; snapshotId: string; clip: number; frames: number };
