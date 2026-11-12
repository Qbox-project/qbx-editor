export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export const IDENTITY: Quat = [0, 0, 0, 1];

export function add(a: Vec3, b: Vec3): Vec3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
export function normalize(q: Quat): Quat {
    const length = Math.hypot(q[0], q[1], q[2], q[3]);
    return length > 1e-6 && Number.isFinite(length) ? [q[0] / length, q[1] / length, q[2] / length, q[3] / length] : [...IDENTITY];
}
export function conjugate(q: Quat): Quat { return [-q[0], -q[1], -q[2], q[3]]; }
export function multiply(a: Quat, b: Quat): Quat {
    return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
}
export function rotate(q: Quat, v: Vec3): Vec3 {
    const [x, y, z, w] = q;
    const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
    return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}
/** Game heading in degrees: 0 faces +Y (north) and grows counter-clockwise, as GetEntityHeading reports it. */
export function heading(q: Quat): number {
    const forward = rotate(q, [0, 1, 0]);
    const degrees = Math.atan2(-forward[0], forward[1]) * 180 / Math.PI;
    return ((degrees % 360) + 360) % 360;
}
export function tilt(q: Quat): number { return Math.acos(Math.max(-1, Math.min(1, rotate(q, [0, 0, 1])[2]))) * 180 / Math.PI; }
