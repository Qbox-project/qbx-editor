import type { ResourcePages } from './assetResource';

export const MAX_ANIMATION_VALUES = 4_000_000;
const MAX_SEQUENCE_BLOCKS = 4096, MAX_CHANNELS = 16_384, MAX_TRACKS = 4096;
export const TRACK_POSITION = 0, TRACK_ROTATION = 1, TRACK_MOVER_POSITION = 5, TRACK_MOVER_ROTATION = 6;
export interface AnimTrack { bone: number; track: number }
/** Per frame and track, four floats: x, y, z of a position or x, y, z, w of a rotation. */
export interface AnimData { frames: number; duration: number; tracks: AnimTrack[]; values: Float32Array }

interface Channel { type: number; sequence: number; index: number; quatIndex: number; value: number[]; frames?: Float32Array; frameBits: number; quantum: number; offset: number; lookup?: Float32Array }

const scratch = new DataView(new ArrayBuffer(4));
class Bits {
    constructor(private readonly data: Buffer) {}
    read(start: number, length: number): number {
        let result = 0;
        for (let bit = 0; bit < length; bit++) {
            const at = start + bit, byte = at >> 3;
            if (byte < this.data.length && (this.data[byte] >> (at & 7)) & 1) { result += 2 ** bit; }
        }
        return result;
    }
}

function decodeBlock(data: Buffer, frameCount: number, frameOffset: number, frameLength: number, chunkSize: number, trackCount: number, out: Float32Array, firstFrame: number, totalFrames: number): void {
    const bits = new Bits(data), channels: Channel[] = [], listStart = frameOffset + frameLength * frameCount;
    if (listStart + 18 > data.length) { throw new Error('An animation sequence is truncated.'); }
    let position = 0, info = listStart + 18;
    const need = (bytes: number): void => { if (position + bytes > data.length) { throw new Error('An animation channel extends past its sequence data.'); } };
    for (let type = 0; type < 9; type++) {
        const count = data.readUInt16LE(listStart + type * 2);
        if (channels.length + count > MAX_CHANNELS || info + count * 2 > data.length) { throw new Error('An animation sequence declares more channels than it holds.'); }
        for (let index = 0; index < count; index++) {
            const packed = data.readUInt16LE(info); info += 2;
            const channel: Channel = { type, sequence: packed >> 2, index: packed & 3, quatIndex: 0, value: [], frameBits: 0, quantum: 0, offset: 0 };
            if (type === 0 || type === 1) {
                need(12);
                channel.value = [data.readFloatLE(position), data.readFloatLE(position + 4), data.readFloatLE(position + 8)]; position += 12;
                if (type === 0) { channel.value.push(Math.sqrt(Math.max(1 - channel.value[0] ** 2 - channel.value[1] ** 2 - channel.value[2] ** 2, 0))); }
            } else if (type === 2) { need(4); channel.value = [data.readFloatLE(position)]; position += 4; }
            else if (type === 3) { channel.frameBits = 32; channel.frames = new Float32Array(frameCount); }
            else if (type === 4) {
                need(12);
                channel.frameBits = data.readInt32LE(position); channel.quantum = data.readFloatLE(position + 4); channel.offset = data.readFloatLE(position + 8); position += 12;
                channel.frames = new Float32Array(frameCount);
            } else if (type === 5) {
                need(20);
                const valueBits = data.readInt32LE(position + 4), ints = data.readInt32LE(position + 8);
                channel.frameBits = data.readInt32LE(position); channel.quantum = data.readFloatLE(position + 12); channel.offset = data.readFloatLE(position + 16); position += 20;
                if (channel.frameBits < 0 || channel.frameBits > 32 || valueBits < 1 || valueBits > 32 || ints < 0) { throw new Error('An animation channel has an invalid bit layout.'); }
                need(ints * 4);
                const values = Math.min(Math.floor(ints * 32 / valueBits), 2 ** channel.frameBits - 1, 1 << 20);
                channel.lookup = new Float32Array(values);
                for (let value = 0; value < values; value++) { channel.lookup[value] = bits.read(position * 8 + value * valueBits, valueBits) * channel.quantum + channel.offset; }
                position += ints * 4; channel.frames = new Float32Array(frameCount);
            } else if (type === 6) {
                need(16);
                const ints = data.readInt32LE(position), counts = data.readInt32LE(position + 4), quantum = data.readFloatLE(position + 8), offset = data.readFloatLE(position + 12);
                const offsetBits = counts & 0xff, valueBits = (counts >> 8) & 0xff, deltaBits = (counts >> 16) & 0xff, size = Math.max(1, chunkSize), chunks = Math.floor((size + frameCount - 1) / size);
                if (ints < 4 || offsetBits > 32 || valueBits > 32 || deltaBits > 31) { throw new Error('An animation channel has an invalid bit layout.'); }
                need(ints * 4);
                const start = (position + 16) * 8, deltas = start + chunks * (offsetBits + valueBits), end = data.length * 8;
                channel.frames = new Float32Array(frameCount);
                for (let chunk = 0; chunk < chunks; chunk++) {
                    let cursor = deltas + (offsetBits ? bits.read(start + chunk * offsetBits, offsetBits) : 0);
                    let value = valueBits ? bits.read(start + chunks * offsetBits + chunk * valueBits, valueBits) : 0, increment = 0;
                    for (let step = 0; step < size; step++) {
                        const frame = chunk * size + step;
                        if (frame >= frameCount) { break; }
                        channel.frames[frame] = value * quantum + offset;
                        if (step + 1 >= size) { break; }
                        let delta = deltaBits ? bits.read(cursor, deltaBits) : 0;
                        cursor += deltaBits;
                        const scan = cursor;
                        while (cursor < end && !bits.read(cursor, 1)) { cursor++; }
                        cursor++;
                        delta |= (cursor - scan - 1) << deltaBits;
                        if (delta !== 0) { if (bits.read(cursor, 1)) { delta = -delta; } cursor++; }
                        increment += delta; value += increment;
                    }
                }
                position += ints * 4;
            } else { channel.quatIndex = channel.index; channel.index = type === 7 ? 3 : 4; }
            if (channel.frameBits < 0 || channel.frameBits > 32) { throw new Error('An animation channel has an invalid bit layout.'); }
            channels.push(channel);
        }
        if (count % 4) { info += (4 - count % 4) * 2; }
    }
    for (let frame = 0; frame < frameCount; frame++) {
        let cursor = (frameOffset + frameLength * frame) * 8;
        for (const channel of channels) {
            if (!channel.frameBits || !channel.frames) { continue; }
            const raw = bits.read(cursor, channel.frameBits);
            cursor += channel.frameBits;
            if (channel.type === 3) { scratch.setUint32(0, raw, true); channel.frames[frame] = scratch.getFloat32(0, true); }
            else if (channel.type === 4) { channel.frames[frame] = raw * channel.quantum + channel.offset; }
            else { channel.frames[frame] = channel.lookup && raw < channel.lookup.length ? channel.lookup[raw] : channel.offset; }
        }
    }
    const byTrack = new Map<number, Channel[]>();
    for (const channel of channels) { byTrack.set(channel.sequence, [...(byTrack.get(channel.sequence) ?? []), channel]); }
    for (const [track, list] of byTrack) {
        if (track >= trackCount) { continue; }
        list.sort((a, b) => a.index - b.index);
        const cached = list.find((channel) => channel.type >= 7), plain = list.filter((channel) => channel.type < 7);
        for (let frame = 0; frame < frameCount && firstFrame + frame < totalFrames; frame++) {
            const parts: number[] = [];
            for (const channel of plain) {
                if (channel.type <= 2) { parts.push(...channel.value); } else { parts.push(channel.frames![frame]); }
            }
            const at = ((firstFrame + frame) * trackCount + track) * 4;
            if (cached) {
                const [x = 0, y = 0, z = 0] = parts, rest = Math.sqrt(Math.max(1 - x * x - y * y - z * z, 0));
                const quaternion = cached.quatIndex === 0 ? [rest, x, y, z] : cached.quatIndex === 1 ? [x, rest, y, z] : cached.quatIndex === 2 ? [x, y, rest, z] : [x, y, z, rest];
                out.set(quaternion, at);
            } else { for (let part = 0; part < 4; part++) { out[at + part] = parts[part] ?? 0; } }
        }
    }
}

/** Decodes every frame of the animation at `at`. Sequence blocks hold consecutive runs of frames; the last frame of a block repeats as the first of the next. */
export function decodeAnimation(pages: ResourcePages, at: number): AnimData {
    pages.need(at, 0x60);
    const frames = pages.u16(at + 0x14), limit = pages.u16(at + 0x16), duration = pages.f32(at + 0x18), blockCount = pages.u16(at + 0x48), trackCount = pages.u16(at + 0x58);
    if (!frames || !limit || !blockCount || !trackCount) { return { frames: 0, duration: 0, tracks: [], values: new Float32Array(0) }; }
    if (trackCount > MAX_TRACKS || blockCount > MAX_SEQUENCE_BLOCKS || frames * trackCount > MAX_ANIMATION_VALUES) { throw new Error('This animation exceeds the four-million-value preview limit.'); }
    const trackList = pages.pointer(at + 0x50, trackCount * 4), blocks = pages.pointer(at + 0x40, blockCount * 8), tracks: AnimTrack[] = [];
    for (let track = 0; track < trackCount; track++) { tracks.push({ bone: pages.u16(trackList + track * 4), track: pages.u8(trackList + track * 4 + 3) }); }
    const values = new Float32Array(frames * trackCount * 4);
    for (let block = 0; block < blockCount; block++) {
        const from = pages.optionalPointer(blocks + block * 8, 0x20);
        if (from === undefined || block * limit >= frames) { continue; }
        const length = pages.u32(from + 4), frameCount = pages.u16(from + 0x16);
        pages.need(from + 0x20, length);
        decodeBlock(pages.bytes.subarray(from + 0x20, from + 0x20 + length), frameCount, pages.u32(from + 0x0c), pages.u16(from + 0x18), pages.u8(from + 0x1e), trackCount, values, block * limit, frames);
    }
    return { frames, duration: Number.isFinite(duration) && duration > 0 ? duration : 0, tracks, values };
}
