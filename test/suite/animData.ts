import * as assert from 'node:assert/strict';
import { MAX_ANIMATION_VALUES, type AnimData } from '../../src/animFormat';
import { buildPedPose, poseWorld } from '../../src/animPose';
import { PED_SKELETON } from '../../src/animSkeleton';
import { decodeClip, parseClips } from '../../src/clipFormat';
import { syntheticYcd } from './modelData';

type Test = [string, () => void | Promise<void>];
const system = (offset: number): bigint => BigInt(0x50000000 + offset);
class BitWriter {
    private readonly bytes: number[] = [];
    private position = 0;
    write(value: number, bits: number): void {
        for (let bit = 0; bit < bits; bit++, this.position++) {
            while (this.bytes.length <= this.position >> 3) { this.bytes.push(0); }
            if (Math.floor(value / 2 ** bit) % 2) { this.bytes[this.position >> 3] |= 1 << (this.position & 7); }
        }
    }
    buffer(length: number): Buffer { const result = Buffer.alloc(length); Buffer.from(this.bytes).copy(result); return result; }
}
function floats(...values: number[]): Buffer { const result = Buffer.alloc(values.length * 4); values.forEach((value, index) => result.writeFloatLE(value, index * 4)); return result; }
function ints(...values: number[]): Buffer { const result = Buffer.alloc(values.length * 4); values.forEach((value, index) => result.writeInt32LE(value, index * 4)); return result; }
interface Channel { type: number; track: number; index: number; body?: Buffer; frameBits?: number; frame?: (frame: number) => number }
/** Lays out one sequence block as the game stores it: channel bodies, per-frame bits, channel counts, then packed track and index words. */
function sequence(channels: Channel[], frames: number, chunkSize = 64): Buffer {
    const ordered = [...channels].sort((a, b) => a.type - b.type), bodies = Buffer.concat(ordered.map((channel) => channel.body ?? Buffer.alloc(0)));
    const frameLength = Math.ceil(ordered.reduce((sum, channel) => sum + (channel.frameBits ?? 0), 0) / 32) * 4, frameData = Buffer.alloc(frameLength * frames);
    for (let frame = 0; frame < frames; frame++) {
        const writer = new BitWriter();
        for (const channel of ordered) { if (channel.frameBits && channel.frame) { writer.write(channel.frame(frame), channel.frameBits); } }
        writer.buffer(frameLength).copy(frameData, frame * frameLength);
    }
    const counts = Buffer.alloc(18), info: Buffer[] = [];
    for (let type = 0; type < 9; type++) {
        const list = ordered.filter((channel) => channel.type === type), words = Buffer.alloc(Math.ceil(list.length / 4) * 8);
        counts.writeUInt16LE(list.length, type * 2);
        list.forEach((channel, index) => words.writeUInt16LE((channel.track << 2) | channel.index, index * 2));
        info.push(words);
    }
    const data = Buffer.concat([bodies, frameData, counts, ...info]), header = Buffer.alloc(0x20);
    header.writeUInt32LE(data.length, 4); header.writeUInt32LE(bodies.length, 0x0c); header.writeUInt16LE(frames, 0x16); header.writeUInt16LE(frameLength, 0x18); header[0x1e] = chunkSize;
    return Buffer.concat([header, data]);
}
function rawBits(value: number): number { const view = new DataView(new ArrayBuffer(4)); view.setFloat32(0, value, true); return view.getUint32(0, true); }
function linear(values: number[], quantum: number, offset: number): Buffer {
    const writer = new BitWriter();
    writer.write(values[0], 8);
    let increment = 0;
    for (let index = 1; index < values.length; index++) {
        const delta = values[index] - values[index - 1] - increment, size = Math.abs(delta);
        writer.write(size & 3, 2); writer.write(0, size >> 2); writer.write(1, 1);
        if (size) { writer.write(delta < 0 ? 1 : 0, 1); }
        increment += delta;
    }
    writer.write(1, 1);
    return Buffer.concat([ints(6, (8 << 8) | (2 << 16)), floats(quantum, offset), writer.buffer(8)]);
}
/** A dictionary whose first clip plays the given tracks; each track is `[bone tag, track kind]`. */
function animated(tracks: [number, number][], block: Buffer, frames: number, duration: number, mutate?: (pages: Buffer) => void): Buffer {
    return syntheticYcd((pages) => {
        pages.writeUInt16LE(frames, 0x514); pages.writeUInt16LE(127, 0x516); pages.writeFloatLE(duration, 0x518);
        pages.writeBigUInt64LE(system(0x600), 0x540); pages.writeUInt16LE(1, 0x548); pages.writeBigUInt64LE(system(0x680), 0x550); pages.writeUInt16LE(tracks.length, 0x558);
        pages.writeBigUInt64LE(system(0x800), 0x600);
        tracks.forEach(([bone, kind], index) => { pages.writeUInt16LE(bone, 0x680 + index * 4); pages[0x680 + index * 4 + 3] = kind; });
        block.copy(pages, 0x800);
        pages.writeFloatLE(0, 0x358); pages.writeFloatLE(duration, 0x35c); pages.writeFloatLE(1, 0x360);
        mutate?.(pages);
    });
}
const tag = (name: string): number => PED_SKELETON.find((bone) => bone.name === name)!.tag;
/** Two frames of a ped that turns its left thigh a quarter turn forward; every other bone keeps its bind pose. */
export function syntheticPedYcd(): Buffer {
    const quaternion = (track: number, x: number, y: number, z: number): Channel => ({ type: 0, track, index: 0, body: floats(x, y, z) });
    return animated([[tag('SKEL_ROOT'), 1], [tag('SKEL_L_Thigh'), 1], [tag('SKEL_L_Calf'), 1], [tag('SKEL_R_Thigh'), 1]],
        sequence([quaternion(0, 0, 0, 0), quaternion(1, 0, 0, Math.SQRT1_2), quaternion(2, 0, 0, 0), quaternion(3, 0, 0, 0)], 2), 2, 0.5);
}
function close(actual: ArrayLike<number>, expected: number[], message: string): void {
    assert.equal(actual.length, expected.length, message);
    expected.forEach((value, index) => assert.ok(Math.abs(actual[index] - value) < 1e-4, `${message} [${index}]: ${actual[index]} is not ${value}`));
}
function value(data: AnimData, frame: number, track: number): number[] { return Array.from(data.values.subarray((frame * data.tracks.length + track) * 4, (frame * data.tracks.length + track) * 4 + 4)); }

const tests: Test[] = [
    ['every animation channel encoding decodes to the values that were stored', async () => {
        const frames = 4, indirectBody = new BitWriter(), steps = [5, 7, 12, 14], picks = [0, 2, 1, 0];
        [10, 20, 30].forEach((entry) => indirectBody.write(entry, 8));
        const channels: Channel[] = [
            { type: 1, track: 0, index: 0, body: floats(1, 2, 3) }, { type: 0, track: 1, index: 0, body: floats(0.6, 0, 0) },
            ...[0, 1, 2].map((axis): Channel => ({ type: 4, track: 2, index: axis, body: Buffer.concat([ints(10), floats(0.01, -1)]), frameBits: 10, frame: (frame) => axis === 0 ? 100 + frame * 10 : 100 })),
            { type: 7, track: 2, index: 3 },
            ...[0, 1, 2].map((axis): Channel => ({ type: 3, track: 3, index: axis, frameBits: 32, frame: (frame) => rawBits([frame * 0.5, -frame, 7][axis]) })),
            { type: 5, track: 4, index: 0, body: Buffer.concat([ints(2, 8, 1), floats(0.5, 1), indirectBody.buffer(4)]), frameBits: 2, frame: (frame) => picks[frame] },
            { type: 2, track: 4, index: 1, body: floats(4) }, { type: 2, track: 4, index: 2, body: floats(5) },
            { type: 6, track: 5, index: 0, body: linear(steps, 0.25, -1) }, { type: 2, track: 5, index: 1, body: floats(8) }, { type: 2, track: 5, index: 2, body: floats(9) },
        ];
        const file = await parseClips(animated([[100, 0], [100, 1], [200, 1], [300, 0], [400, 0], [500, 0]], sequence(channels, frames), frames, 0.1));
        const clip = file.clips.find((entry) => entry.name === 'idle_a')!, decoded = decodeClip(file, clip)!;
        assert.deepEqual([decoded.data.frames, decoded.data.tracks.length, decoded.start], [frames, 6, 0]); close([decoded.data.duration, decoded.end], [0.1, 0.1], 'timing');
        assert.deepEqual(decoded.data.tracks.slice(0, 3), [{ bone: 100, track: 0 }, { bone: 100, track: 1 }, { bone: 200, track: 1 }]);
        for (let frame = 0; frame < frames; frame++) {
            const x = frame * 0.1;
            close(value(decoded.data, frame, 0), [1, 2, 3, 0], `static vector, frame ${frame}`);
            close(value(decoded.data, frame, 1), [0.6, 0, 0, 0.8], `static quaternion, frame ${frame}`);
            close(value(decoded.data, frame, 2), [x, 0, 0, Math.sqrt(1 - x * x)], `quantized rotation with a derived component, frame ${frame}`);
            close(value(decoded.data, frame, 3), [frame * 0.5, -frame, 7, 0], `raw floats, frame ${frame}`);
            close(value(decoded.data, frame, 4), [[6, 11, 16][picks[frame]], 4, 5, 0], `indexed floats, frame ${frame}`);
            close(value(decoded.data, frame, 5), [steps[frame] * 0.25 - 1, 8, 9, 0], `delta-coded floats, frame ${frame}`);
        }
        assert.equal(decodeClip(file, file.clips.find((entry) => entry.kind === 'list')!), undefined);
    }],
    ['damaged or oversized animations are rejected', async () => {
        const block = sequence([{ type: 1, track: 0, index: 0, body: floats(1, 2, 3) }], 2);
        const decode = async (mutate: (pages: Buffer) => void): Promise<unknown> => { const file = await parseClips(animated([[100, 0]], block, 2, 0.1, mutate)); return decodeClip(file, file.clips.find((entry) => entry.name === 'idle_a')!); };
        await assert.rejects(decode((pages) => pages.writeUInt32LE(8, 0x804)), /sequence is truncated/);
        await assert.rejects(decode((pages) => pages.writeUInt16LE(900, 0x800 + 0x20 + 12 + 2)), /more channels than it holds/);
        await assert.rejects(decode((pages) => pages.writeUInt32LE(0x7fffffff, 0x804)), /truncated or contains an invalid offset/);
        await assert.rejects(decode((pages) => { pages.writeUInt16LE(0xffff, 0x514); pages.writeUInt16LE(Math.ceil(MAX_ANIMATION_VALUES / 0xffff) + 1, 0x558); }), /four-million-value preview limit/);
        const empty = await decode((pages) => pages.writeUInt16LE(0, 0x548)) as { data: AnimData };
        assert.equal(empty.data.frames, 0);
    }],
    ['clips map onto the ped skeleton and fill unanimated bones from the bind pose', async () => {
        const file = await parseClips(syntheticPedYcd()), decoded = decodeClip(file, file.clips.find((entry) => entry.name === 'idle_a')!)!, pose = buildPedPose(decoded.data)!;
        assert.deepEqual([pose.frames, pose.animated, pose.assumed, pose.otherBones, pose.names.length], [2, 4, PED_SKELETON.length - 1, 0, PED_SKELETON.length]);
        const world = poseWorld(pose, 0), at = (name: string): number[] => Array.from(world.subarray(pose.names.indexOf(name) * 3, pose.names.indexOf(name) * 3 + 3));
        close(at('SKEL_ROOT'), [0, 0, 0], 'root'); close(at('SKEL_R_Thigh'), [0.096, 0, -0.074], 'right hip is on +X, below the pelvis');
        close(at('SKEL_R_Foot'), [0.096, 0, -0.894], 'a straight right leg reaches down'); close(at('SKEL_Head'), [0, -0.01, 0.664], 'the spine points up');
        close(at('SKEL_L_Thigh'), [-0.096, 0, -0.074], 'left hip'); close(at('SKEL_L_Calf'), [-0.096, 0.407, -0.074], 'a thigh turned a quarter turn points forward');
        assert.equal(buildPedPose({ frames: 2, duration: 1, tracks: [{ bone: 100, track: 1 }, { bone: 0, track: 1 }], values: new Float32Array(16) }), undefined);
    }],
    ['poses blend between frames along the shorter rotation', () => {
        const data: AnimData = { frames: 2, duration: 1, tracks: [{ bone: 0, track: 0 }, { bone: 0, track: 1 }, { bone: tag('SKEL_L_Thigh'), track: 1 }, { bone: tag('SKEL_R_Thigh'), track: 1 }],
            values: new Float32Array([0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 1, 0, 0, 0, 1]) };
        const pose = buildPedPose(data)!, middle = poseWorld(pose, 0.5), foot = pose.names.indexOf('SKEL_L_Foot') * 3;
        close(Array.from(middle.subarray(0, 3)), [0, 0, 0.5], 'the root is halfway between its two positions');
        close(Array.from(middle.subarray(foot, foot + 3)), [-0.096, 0, 0.5 - 0.894], 'a rotation stored with the opposite sign is the same rotation');
        close(Array.from(poseWorld(pose, 9).subarray(0, 3)), [0, 0, 1], 'frames past the end hold the last pose');
    }],
];
export async function runAnimDataTests(): Promise<void> {
    const failures: string[] = [];
    for (const [name, body] of tests) {
        try { await body(); console.log(`  ok   ${name}`); }
        catch (error) { failures.push(name); console.error(`  FAIL ${name}\n${error instanceof Error ? error.stack : String(error)}`); }
    }
    if (failures.length) { throw new Error(`${failures.length} animation data test(s) failed: ${failures.join(', ')}`); }
}
