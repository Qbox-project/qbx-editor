import { decodeAnimation, type AnimData } from './animFormat';
import { loadResourcePages, type ResourcePages } from './assetResource';

export const MAX_CLIPS = 20_000;
export interface ClipInfo {
    hash: number; name: string; path: string; kind: 'animation' | 'list' | 'other'; duration: number; rate: number;
    frames: number; fps: number; bones: number; sequences: number; parts: number;
}
export interface ClipWindow { animation: number | undefined; start: number; end: number }
export interface ClipFile { clips: ClipInfo[]; animations: number; notes: string[]; pages: ResourcePages; windows: Map<ClipInfo, ClipWindow> }

/** The name scripts pass to TaskPlayAnim: the clip's file name without folder or extension, in lower case. */
export function clipName(path: string): string { return path.replace(/^.*[\\/:]/, '').replace(/\.[^.]*$/, '').toLowerCase(); }

export async function parseClips(data: Buffer): Promise<ClipFile> {
    const pages = await loadResourcePages(data, 'YCD', [46]);
    pages.need(0, 0x40);
    const capacity = pages.u16(0x30), buckets = capacity ? pages.optionalPointer(0x28, capacity * 8) : undefined, file: ClipFile = { clips: [], animations: 0, notes: [], pages, windows: new Map() };
    const map = pages.optionalPointer(0x18, 0x30);
    if (map !== undefined) { file.animations = pages.u16(map + 0x22); }
    let visited = 0;
    for (let bucket = 0; buckets !== undefined && bucket < capacity; bucket++) {
        let entry = pages.optionalPointer(buckets + bucket * 8, 0x20);
        while (entry !== undefined) {
            if (++visited > MAX_CLIPS) { file.notes.push(`Only the first ${MAX_CLIPS.toLocaleString('en-US')} clips are listed.`); return file; }
            const clip = pages.optionalPointer(entry + 0x08, 0x70);
            if (clip !== undefined) {
                const type = pages.u32(clip + 0x10), nameAt = pages.optionalPointer(clip + 0x18, 1), path = nameAt === undefined ? '' : pages.text(nameAt, 512);
                const info: ClipInfo = { hash: pages.u32(entry), name: clipName(path), path, kind: type === 1 ? 'animation' : type === 2 ? 'list' : 'other', duration: 0, rate: 1, frames: 0, fps: 0, bones: 0, sequences: 0, parts: 0 };
                if (type === 1) {
                    const animation = pages.optionalPointer(clip + 0x50, 0x60), start = pages.f32(clip + 0x58), end = pages.f32(clip + 0x5c), rate = pages.f32(clip + 0x60);
                    file.windows.set(info, { animation, start: Number.isFinite(start) ? start : 0, end: Number.isFinite(end) ? end : 0 });
                    info.rate = Number.isFinite(rate) && rate > 0 ? rate : 1; info.duration = Number.isFinite(end - start) ? Math.max(0, end - start) / info.rate : 0; info.parts = animation === undefined ? 0 : 1;
                    if (animation !== undefined) {
                        const length = pages.f32(animation + 0x18);
                        info.frames = pages.u16(animation + 0x14); info.sequences = pages.u16(animation + 0x48); info.bones = pages.u16(animation + 0x58);
                        info.fps = info.frames > 1 && Number.isFinite(length) && length > 0 ? (info.frames - 1) / length : 0;
                    }
                } else if (type === 2) { info.parts = pages.u16(clip + 0x58); info.duration = Math.max(0, pages.f32(clip + 0x60)) || 0; }
                file.clips.push(info);
            }
            entry = pages.optionalPointer(entry + 0x10, 0x20);
        }
    }
    file.clips.sort((a, b) => a.name.localeCompare(b.name));
    return file;
}

/** The decoded animation behind a clip and the part of it the clip plays, or undefined for clips that are not a single animation. */
export function decodeClip(file: ClipFile, clip: ClipInfo): { data: AnimData; start: number; end: number } | undefined {
    const window = file.windows.get(clip);
    if (!window || window.animation === undefined) { return undefined; }
    return { data: decodeAnimation(file.pages, window.animation), start: window.start, end: window.end };
}
