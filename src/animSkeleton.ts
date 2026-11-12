export interface SkeletonBone { tag: number; name: string; parent: number; offset: [number, number, number]; rotation: [number, number, number, number] }

const HALF = Math.SQRT1_2;
// Bind offsets in the parent's frame, in metres; bones point along their own +X axis.
const PED: [name: string, tag: number, parent: string, x: number, y: number, z: number][] = [
    ['SKEL_ROOT', 0, '', 0, 0, 0], ['SKEL_Pelvis', 11816, 'SKEL_ROOT', 0, 0, 0],
    ['SKEL_L_Thigh', 58271, 'SKEL_Pelvis', 0.074, 0, -0.096], ['SKEL_L_Calf', 63931, 'SKEL_L_Thigh', 0.407, 0, 0], ['SKEL_L_Foot', 14201, 'SKEL_L_Calf', 0.413, 0, 0], ['SKEL_L_Toe0', 2108, 'SKEL_L_Foot', 0.162, 0, 0],
    ['SKEL_R_Thigh', 51826, 'SKEL_Pelvis', 0.074, 0, 0.096], ['SKEL_R_Calf', 36864, 'SKEL_R_Thigh', 0.407, 0, 0], ['SKEL_R_Foot', 52301, 'SKEL_R_Calf', 0.413, 0, 0], ['SKEL_R_Toe0', 20781, 'SKEL_R_Foot', 0.162, 0, 0],
    ['SKEL_Spine_Root', 57597, 'SKEL_ROOT', 0, 0, 0], ['SKEL_Spine0', 23553, 'SKEL_Spine_Root', 0.019, -0.01, 0], ['SKEL_Spine1', 24816, 'SKEL_Spine0', 0.085, 0, 0],
    ['SKEL_Spine2', 24817, 'SKEL_Spine1', 0.086, 0, 0], ['SKEL_Spine3', 24818, 'SKEL_Spine2', 0.113, 0, 0],
    ['SKEL_L_Clavicle', 64729, 'SKEL_Spine3', 0.218, 0.036, 0.032], ['SKEL_L_UpperArm', 45509, 'SKEL_L_Clavicle', 0.182, 0, 0], ['SKEL_L_Forearm', 61163, 'SKEL_L_UpperArm', 0.274, 0, 0], ['SKEL_L_Hand', 18905, 'SKEL_L_Forearm', 0.259, 0, 0],
    ['SKEL_R_Clavicle', 10706, 'SKEL_Spine3', 0.218, 0.036, -0.032], ['SKEL_R_UpperArm', 40269, 'SKEL_R_Clavicle', 0.182, 0, 0], ['SKEL_R_Forearm', 28252, 'SKEL_R_UpperArm', 0.274, 0, 0], ['SKEL_R_Hand', 57005, 'SKEL_R_Forearm', 0.259, 0, 0],
    ['SKEL_Neck_1', 39317, 'SKEL_Spine3', 0.248, 0, 0], ['SKEL_Head', 31086, 'SKEL_Neck_1', 0.113, 0, 0],
    ['SKEL_L_Finger00', 26610, 'SKEL_L_Hand', 0.026, 0.023, 0.001], ['SKEL_L_Finger01', 4089, 'SKEL_L_Finger00', 0.056, 0, 0], ['SKEL_L_Finger02', 4090, 'SKEL_L_Finger01', 0.036, 0, 0],
    ['SKEL_L_Finger10', 26611, 'SKEL_L_Hand', 0.107, 0.029, -0.021], ['SKEL_L_Finger11', 4169, 'SKEL_L_Finger10', 0.047, 0, 0], ['SKEL_L_Finger12', 4170, 'SKEL_L_Finger11', 0.024, 0, 0],
    ['SKEL_L_Finger20', 26612, 'SKEL_L_Hand', 0.106, 0.005, -0.023], ['SKEL_L_Finger21', 4185, 'SKEL_L_Finger20', 0.052, 0, 0], ['SKEL_L_Finger22', 4186, 'SKEL_L_Finger21', 0.033, 0, 0],
    ['SKEL_L_Finger30', 26613, 'SKEL_L_Hand', 0.1, -0.018, -0.013], ['SKEL_L_Finger31', 4137, 'SKEL_L_Finger30', 0.045, 0, 0], ['SKEL_L_Finger32', 4138, 'SKEL_L_Finger31', 0.031, 0, 0],
    ['SKEL_L_Finger40', 26614, 'SKEL_L_Hand', 0.094, -0.034, 0.002], ['SKEL_L_Finger41', 4153, 'SKEL_L_Finger40', 0.038, 0, 0], ['SKEL_L_Finger42', 4154, 'SKEL_L_Finger41', 0.023, 0, 0],
    ['SKEL_R_Finger00', 58866, 'SKEL_R_Hand', 0.026, 0.023, -0.001], ['SKEL_R_Finger01', 64016, 'SKEL_R_Finger00', 0.056, 0, 0], ['SKEL_R_Finger02', 64017, 'SKEL_R_Finger01', 0.036, 0, 0],
    ['SKEL_R_Finger10', 58867, 'SKEL_R_Hand', 0.107, 0.029, 0.021], ['SKEL_R_Finger11', 64096, 'SKEL_R_Finger10', 0.047, 0, 0], ['SKEL_R_Finger12', 64097, 'SKEL_R_Finger11', 0.024, 0, 0],
    ['SKEL_R_Finger20', 58868, 'SKEL_R_Hand', 0.106, 0.005, 0.023], ['SKEL_R_Finger21', 64112, 'SKEL_R_Finger20', 0.052, 0, 0], ['SKEL_R_Finger22', 64113, 'SKEL_R_Finger21', 0.033, 0, 0],
    ['SKEL_R_Finger30', 58869, 'SKEL_R_Hand', 0.1, -0.018, 0.013], ['SKEL_R_Finger31', 64064, 'SKEL_R_Finger30', 0.045, 0, 0], ['SKEL_R_Finger32', 64065, 'SKEL_R_Finger31', 0.031, 0, 0],
    ['SKEL_R_Finger40', 58870, 'SKEL_R_Hand', 0.094, -0.034, -0.002], ['SKEL_R_Finger41', 64080, 'SKEL_R_Finger40', 0.038, 0, 0], ['SKEL_R_Finger42', 64081, 'SKEL_R_Finger41', 0.023, 0, 0],
];
// The pelvis turns the leg chain to point down and the spine root turns the spine chain to point up.
const BIND_ROTATION: Record<string, [number, number, number, number]> = { SKEL_Pelvis: [0, HALF, 0, HALF], SKEL_Spine_Root: [0, -HALF, 0, HALF] };

/** The body bones of the standard ped skeleton, parents before children; `parent` is an index into this list, or -1 for the root. */
export const PED_SKELETON: readonly SkeletonBone[] = PED.map(([name, tag, parent, x, y, z]) => ({ tag, name, parent: PED.findIndex((bone) => bone[0] === parent), offset: [x, y, z], rotation: BIND_ROTATION[name] ?? [0, 0, 0, 1] }));
