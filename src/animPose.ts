import type { AnimData } from './animFormat';
import { PED_SKELETON } from './animSkeleton';

const POSITION = 0, ROTATION = 1;
/** Local transforms of the ped body bones for every frame: three floats of position and four of rotation per bone. */
export interface AnimPose { frames: number; duration: number; names: string[]; parents: number[]; positions: Float32Array; rotations: Float32Array; animated: number; assumed: number; otherBones: number }

/** Maps decoded tracks onto the ped skeleton, filling bones the clip does not animate from the bind pose. Undefined when the clip is not a ped animation. */
export function buildPedPose(data: AnimData): AnimPose | undefined {
    const bones = PED_SKELETON.length, tracks = data.tracks.length;
    const track = (tag: number, kind: number): number => data.tracks.findIndex((entry) => entry.bone === tag && entry.track === kind);
    const positionTracks = PED_SKELETON.map((bone) => track(bone.tag, POSITION)), rotationTracks = PED_SKELETON.map((bone) => track(bone.tag, ROTATION));
    const animated = rotationTracks.filter((index) => index >= 0).length;
    if (!data.frames || animated < 3) { return undefined; }
    const tags = new Set(PED_SKELETON.map((bone) => bone.tag));
    const pose: AnimPose = { frames: data.frames, duration: data.duration, names: PED_SKELETON.map((bone) => bone.name), parents: PED_SKELETON.map((bone) => bone.parent),
        positions: new Float32Array(data.frames * bones * 3), rotations: new Float32Array(data.frames * bones * 4), animated,
        assumed: positionTracks.filter((index, bone) => index < 0 && PED_SKELETON[bone].parent >= 0).length, otherBones: new Set(data.tracks.filter((entry) => !tags.has(entry.bone)).map((entry) => entry.bone)).size };
    for (let frame = 0; frame < data.frames; frame++) {
        PED_SKELETON.forEach((bone, index) => {
            const position = positionTracks[index], rotation = rotationTracks[index], to = frame * bones + index;
            for (let axis = 0; axis < 3; axis++) { pose.positions[to * 3 + axis] = position < 0 ? bone.offset[axis] : data.values[(frame * tracks + position) * 4 + axis]; }
            const from = (frame * tracks + rotation) * 4, length = rotation < 0 ? 0 : Math.hypot(data.values[from], data.values[from + 1], data.values[from + 2], data.values[from + 3]);
            for (let part = 0; part < 4; part++) { pose.rotations[to * 4 + part] = length > 1e-6 && Number.isFinite(length) ? data.values[from + part] / length : bone.rotation[part]; }
        });
    }
    return pose;
}

/** World positions of every bone at a fractional frame, three floats per bone, blending the two nearest frames. */
export function poseWorld(pose: AnimPose, frame: number, out = new Float32Array(pose.names.length * 3), orientations = new Float32Array(pose.names.length * 4)): Float32Array {
    const bones = pose.names.length, clamped = Math.max(0, Math.min(pose.frames - 1, Number.isFinite(frame) ? frame : 0)), first = Math.floor(clamped), second = Math.min(pose.frames - 1, first + 1), blend = clamped - first;
    for (let bone = 0; bone < bones; bone++) {
        const a = first * bones + bone, b = second * bones + bone, parent = pose.parents[bone];
        const local = [0, 1, 2].map((axis) => pose.positions[a * 3 + axis] * (1 - blend) + pose.positions[b * 3 + axis] * blend);
        let dot = 0;
        for (let part = 0; part < 4; part++) { dot += pose.rotations[a * 4 + part] * pose.rotations[b * 4 + part]; }
        const turn = [0, 1, 2, 3].map((part) => pose.rotations[a * 4 + part] * (1 - blend) + pose.rotations[b * 4 + part] * (dot < 0 ? -blend : blend));
        const length = Math.hypot(turn[0], turn[1], turn[2], turn[3]) || 1;
        const [x, y, z, w] = turn.map((part) => part / length);
        if (parent < 0) { out.set(local, bone * 3); orientations.set([x, y, z, w], bone * 4); continue; }
        const px = orientations[parent * 4], py = orientations[parent * 4 + 1], pz = orientations[parent * 4 + 2], pw = orientations[parent * 4 + 3];
        const tx = 2 * (py * local[2] - pz * local[1]), ty = 2 * (pz * local[0] - px * local[2]), tz = 2 * (px * local[1] - py * local[0]);
        out[bone * 3] = out[parent * 3] + local[0] + pw * tx + (py * tz - pz * ty);
        out[bone * 3 + 1] = out[parent * 3 + 1] + local[1] + pw * ty + (pz * tx - px * tz);
        out[bone * 3 + 2] = out[parent * 3 + 2] + local[2] + pw * tz + (px * ty - py * tx);
        orientations[bone * 4] = pw * x + px * w + py * z - pz * y; orientations[bone * 4 + 1] = pw * y - px * z + py * w + pz * x;
        orientations[bone * 4 + 2] = pw * z + px * y - py * x + pz * w; orientations[bone * 4 + 3] = pw * w - px * x - py * y - pz * z;
    }
    return out;
}
