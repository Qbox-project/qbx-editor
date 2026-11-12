import type { Vec3 } from './mapMath';
import type { LodMesh } from './modelFormat';

export const MAX_SURFACE_TRIANGLES = 600_000;
const MAX_CELL_REFERENCES = 4_000_000, MERGE_DISTANCE = 0.02;

/** Appends the triangles of a collision mesh, moved by `transform`, as nine floats each. Returns false once the limit is reached. */
export function appendTriangles(mesh: LodMesh, transform: (point: Vec3) => Vec3, out: number[]): boolean {
    for (const range of mesh.meshes) {
        const corners: Vec3[] = [];
        for (let vertex = 0; vertex < range.vertexCount; vertex++) {
            const at = range.positions + vertex * 12;
            corners.push(transform([mesh.buffer.readFloatLE(at), mesh.buffer.readFloatLE(at + 4), mesh.buffer.readFloatLE(at + 8)]));
        }
        for (let index = 0; index + 2 < range.indexCount; index += 3) {
            if (out.length >= MAX_SURFACE_TRIANGLES * 9) { return false; }
            for (let corner = 0; corner < 3; corner++) { out.push(...corners[mesh.buffer.readUInt16LE(range.indices + (index + corner) * 2)]); }
        }
    }
    return true;
}

/** Finds the heights of every surface above or below a point on the map, using a grid over the triangles' footprints. */
export class SurfaceIndex {
    private readonly cells = new Map<number, number[]>();
    private readonly cell: number;
    readonly count: number;
    constructor(private readonly triangles: Float32Array, cell = 1) {
        this.count = Math.floor(triangles.length / 9);
        let size = cell;
        // Large footprints fall into many cells; a coarser grid keeps the index small for terrain-sized triangles.
        for (;;) {
            let references = 0;
            for (let triangle = 0; triangle < this.count; triangle++) {
                const [minX, maxX, minY, maxY] = this.extent(triangle);
                references += (Math.floor(maxX / size) - Math.floor(minX / size) + 1) * (Math.floor(maxY / size) - Math.floor(minY / size) + 1);
                if (references > MAX_CELL_REFERENCES) { break; }
            }
            if (references <= MAX_CELL_REFERENCES) { break; }
            size *= 4;
        }
        this.cell = size;
        for (let triangle = 0; triangle < this.count; triangle++) {
            const [minX, maxX, minY, maxY] = this.extent(triangle);
            if (!Number.isFinite(minX + maxX + minY + maxY)) { continue; }
            for (let x = Math.floor(minX / size); x <= Math.floor(maxX / size); x++) {
                for (let y = Math.floor(minY / size); y <= Math.floor(maxY / size); y++) {
                    const key = this.key(x, y), list = this.cells.get(key);
                    if (list) { list.push(triangle); } else { this.cells.set(key, [triangle]); }
                }
            }
        }
    }
    private key(x: number, y: number): number { return x * 2_097_152 + y; }
    private extent(triangle: number): [number, number, number, number] {
        const t = this.triangles, at = triangle * 9;
        return [Math.min(t[at], t[at + 3], t[at + 6]), Math.max(t[at], t[at + 3], t[at + 6]), Math.min(t[at + 1], t[at + 4], t[at + 7]), Math.max(t[at + 1], t[at + 4], t[at + 7])];
    }
    /** Surface heights at (x, y), highest first; surfaces closer than two centimetres count once. Walls contribute nothing. */
    heights(x: number, y: number): number[] {
        const t = this.triangles, found: number[] = [];
        for (const triangle of this.cells.get(this.key(Math.floor(x / this.cell), Math.floor(y / this.cell))) ?? []) {
            const at = triangle * 9, ax = t[at], ay = t[at + 1], bx = t[at + 3], by = t[at + 4], cx = t[at + 6], cy = t[at + 7];
            const area = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
            if (Math.abs(area) < 1e-9) { continue; }
            const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / area, v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / area, w = 1 - u - v;
            if (u < -1e-6 || v < -1e-6 || w < -1e-6) { continue; }
            found.push(u * t[at + 2] + v * t[at + 5] + w * t[at + 8]);
        }
        found.sort((a, b) => b - a);
        return found.filter((height, index) => index === 0 || found[index - 1] - height > MERGE_DISTANCE);
    }
}
