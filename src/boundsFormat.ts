import { loadResourcePages, type ResourcePages } from './assetResource';
import type { LodMesh, MeshRange } from './modelFormat';

export const MAX_BOUND_TRIANGLES = 3_000_000;
const MAX_CHILDREN = 8192, MAX_DEPTH = 8, CHUNK_VERTICES = 65_535;
const TYPE_NAMES: Record<number, string> = { 0: 'Sphere', 1: 'Capsule', 3: 'Box', 4: 'Geometry', 8: 'Geometry (BVH)', 10: 'Composite', 12: 'Disc', 13: 'Cylinder', 15: 'Cloth' };
type Vec3 = [number, number, number];
type Transform = (point: Vec3) => Vec3;
export interface BoundsSummary {
    kinds: { name: string; count: number }[]; polygons: number; triangles: number; vertices: number; min: Vec3; max: Vec3;
    materials: { type: number; triangles: number }[];
}
export interface BoundsFile { summary: BoundsSummary; mesh: LodMesh }

interface MeshGroup { positions: number[]; indices: number[]; remap: Map<number, number>; done: { positions: number[]; indices: number[] }[] }
class MeshBuilder {
    private readonly groups = new Map<number, MeshGroup>();
    triangles = 0;
    truncated = false;
    private group(material: number): MeshGroup {
        let group = this.groups.get(material);
        if (!group) { group = { positions: [], indices: [], remap: new Map(), done: [] }; this.groups.set(material, group); }
        return group;
    }
    /** Adds a triangle whose corners are identified by `keys` so that shared corners become shared vertices. */
    triangle(material: number, corners: [Vec3, Vec3, Vec3], keys?: [number, number, number]): void {
        if (this.triangles >= MAX_BOUND_TRIANGLES) { this.truncated = true; return; }
        const group = this.group(material);
        if (group.positions.length / 3 > CHUNK_VERTICES - 3) { group.done.push({ positions: group.positions, indices: group.indices }); group.positions = []; group.indices = []; group.remap = new Map(); }
        corners.forEach((corner, index) => {
            const key = keys?.[index];
            let local = key === undefined ? undefined : group.remap.get(key);
            if (local === undefined) {
                local = group.positions.length / 3; group.positions.push(corner[0], corner[1], corner[2]);
                if (key !== undefined) { group.remap.set(key, local); }
            }
            group.indices.push(local);
        });
        this.triangles++;
    }
    forget(): void { for (const group of this.groups.values()) { group.remap = new Map(); } }
    build(): { buffer: Buffer; meshes: MeshRange[]; materials: { type: number; triangles: number }[] } {
        const parts: { material: number; positions: number[]; indices: number[] }[] = [], materials: { type: number; triangles: number }[] = [];
        for (const [material, group] of [...this.groups].sort((a, b) => a[0] - b[0])) {
            const chunks = [...group.done, { positions: group.positions, indices: group.indices }].filter((chunk) => chunk.indices.length);
            for (const chunk of chunks) { parts.push({ material, ...chunk }); }
            materials.push({ type: material, triangles: chunks.reduce((sum, chunk) => sum + chunk.indices.length / 3, 0) });
        }
        const buffer = Buffer.alloc(parts.reduce((sum, part) => sum + part.positions.length * 4 + Math.ceil(part.indices.length * 2 / 4) * 4, 0)), meshes: MeshRange[] = [];
        let cursor = 0;
        for (const part of parts) {
            const range: MeshRange = { material: part.material, vertexCount: part.positions.length / 3, indexCount: part.indices.length, positions: cursor, normals: -1, uvs: -1, colours: -1, indices: cursor + part.positions.length * 4 };
            part.positions.forEach((value, index) => buffer.writeFloatLE(value, range.positions + index * 4));
            part.indices.forEach((value, index) => buffer.writeUInt16LE(value, range.indices + index * 2));
            meshes.push(range);
            cursor = range.indices + Math.ceil(part.indices.length * 2 / 4) * 4;
        }
        return { buffer, meshes, materials };
    }
}

function vector(pages: ResourcePages, at: number): Vec3 { return [pages.f32(at), pages.f32(at + 4), pages.f32(at + 8)]; }
function box(builder: MeshBuilder, material: number, corners: Vec3[]): void {
    for (const [a, b, c, d] of [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]]) {
        builder.triangle(material, [corners[a], corners[b], corners[c]]); builder.triangle(material, [corners[a], corners[c], corners[d]]);
    }
}
function aabb(builder: MeshBuilder, material: number, min: Vec3, max: Vec3, transform: Transform): void {
    box(builder, material, [0, 1, 2, 3, 4, 5, 6, 7].map((corner) => transform([corner & 1 ? max[0] : min[0], corner & 2 ? max[1] : min[1], corner & 4 ? max[2] : min[2]])));
}
function sphere(builder: MeshBuilder, material: number, center: Vec3, radius: number, transform: Transform): void {
    const rings = 6, segments = 10, point = (ring: number, segment: number): Vec3 => {
        const polar = Math.PI * ring / rings, azimuth = 2 * Math.PI * segment / segments;
        return transform([center[0] + radius * Math.sin(polar) * Math.cos(azimuth), center[1] + radius * Math.sin(polar) * Math.sin(azimuth), center[2] + radius * Math.cos(polar)]);
    };
    for (let ring = 0; ring < rings; ring++) {
        for (let segment = 0; segment < segments; segment++) {
            const a = point(ring, segment), b = point(ring + 1, segment), c = point(ring + 1, segment + 1), d = point(ring, segment + 1);
            if (ring > 0) { builder.triangle(material, [a, b, d]); }
            if (ring < rings - 1) { builder.triangle(material, [b, c, d]); }
        }
    }
}
/** A tube around the segment from `from` to `to`; collision capsules and cylinders are shown without rounded caps. */
function tube(builder: MeshBuilder, material: number, from: Vec3, to: Vec3, radius: number): void {
    const axis: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]], length = Math.hypot(...axis) || 1;
    const unit = axis.map((value) => value / length) as Vec3, helper: Vec3 = Math.abs(unit[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const side = cross(unit, helper), sideLength = Math.hypot(...side) || 1, u = side.map((value) => value / sideLength) as Vec3, v = cross(unit, u);
    const ring = (center: Vec3, segment: number): Vec3 => {
        const angle = 2 * Math.PI * segment / 10, x = Math.cos(angle) * radius, y = Math.sin(angle) * radius;
        return [center[0] + u[0] * x + v[0] * y, center[1] + u[1] * x + v[1] * y, center[2] + u[2] * x + v[2] * y];
    };
    for (let segment = 0; segment < 10; segment++) {
        const a = ring(from, segment), b = ring(from, segment + 1), c = ring(to, segment + 1), d = ring(to, segment);
        builder.triangle(material, [a, b, c]); builder.triangle(material, [a, c, d]);
        builder.triangle(material, [from, b, a]); builder.triangle(material, [to, d, c]);
    }
}

export async function parseBounds(data: Buffer): Promise<BoundsFile> {
    const pages = await loadResourcePages(data, 'YBN', [43]);
    const builder = new MeshBuilder(), kinds = new Map<string, number>(), notes: string[] = [];
    let polygons = 0, vertices = 0, visited = 0;
    function geometry(at: number, transform: Transform): void {
        pages.need(at, 0x130);
        const vertexCount = pages.u32(at + 0xd0), polygonCount = pages.u32(at + 0xd4), quantum = vector(pages, at + 0x90), center = vector(pages, at + 0xa0);
        if (!vertexCount || !polygonCount) { return; }
        if (vertexCount > 0x8000 * 4 || polygonCount > 0x100000) { throw new Error('A collision geometry declares more vertices or polygons than the format allows.'); }
        const points = pages.pointer(at + 0xb0, vertexCount * 6), list = pages.pointer(at + 0x88, polygonCount * 16);
        const materialCount = pages.u8(at + 0x120), materials = materialCount ? pages.optionalPointer(at + 0xf0, materialCount * 8) : undefined;
        const polygonMaterials = pages.optionalPointer(at + 0x118, polygonCount);
        const cache = new Map<number, Vec3>(), base = vertices;
        const point = (index: number): Vec3 => {
            let value = cache.get(index);
            if (!value) {
                if (index >= vertexCount) { throw new Error('A collision polygon refers to a vertex that does not exist.'); }
                const from = points + index * 6;
                value = transform([pages.i16(from) * quantum[0] + center[0], pages.i16(from + 2) * quantum[1] + center[1], pages.i16(from + 4) * quantum[2] + center[2]]);
                cache.set(index, value);
            }
            return value;
        };
        vertices += vertexCount; polygons += polygonCount;
        builder.forget();
        for (let polygon = 0; polygon < polygonCount; polygon++) {
            const from = list + polygon * 16, kind = pages.u8(from) & 7;
            const slot = polygonMaterials === undefined ? 0 : pages.u8(polygonMaterials + polygon);
            const material = materials !== undefined && slot < materialCount ? pages.u8(materials + slot * 8) : 0;
            if (kind === 0) {
                const corners = [4, 6, 8].map((offset) => pages.u16(from + offset) & 0x7fff) as [number, number, number];
                builder.triangle(material, [point(corners[0]), point(corners[1]), point(corners[2])], [base + corners[0], base + corners[1], base + corners[2]]);
            } else if (kind === 1) { sphere(builder, material, point(pages.u16(from + 2)), pages.f32(from + 4), (value) => value); }
            else if (kind === 2 || kind === 4) { tube(builder, material, point(pages.u16(from + 2)), point(pages.u16(from + 8)), pages.f32(from + 4)); }
            else if (kind === 3) {
                const given = [4, 6, 8, 10].map((offset) => point(pages.u16(from + offset) & 0x7fff));
                const middle = [0, 1, 2].map((axis) => (given[0][axis] + given[1][axis] + given[2][axis] + given[3][axis]) / 4);
                const opposite = given.map((corner) => corner.map((value, axis) => 2 * middle[axis] - value) as Vec3);
                for (const [i, j, k, l] of [[0, 1, 2, 3], [0, 2, 1, 3], [0, 3, 1, 2], [1, 2, 0, 3], [1, 3, 0, 2], [2, 3, 0, 1]]) {
                    builder.triangle(material, [given[i], opposite[k], given[j]]); builder.triangle(material, [given[i], given[j], opposite[l]]);
                }
            }
        }
    }
    function bound(at: number, transform: Transform, depth: number): void {
        pages.need(at, 0x70);
        if (++visited > MAX_CHILDREN || depth > MAX_DEPTH) { throw new Error('The collision file nests or repeats bounds beyond the inspection limit.'); }
        const type = pages.u8(at + 0x10), name = TYPE_NAMES[type] ?? `Type ${type}`, material = pages.u8(at + 0x4c);
        kinds.set(name, (kinds.get(name) ?? 0) + 1);
        if (type === 10) {
            const count = pages.u16(at + 0xa0);
            const children = count ? pages.pointer(at + 0x70, count * 8) : 0, matrices = count ? pages.optionalPointer(at + 0x78, count * 64) : undefined;
            for (let index = 0; index < count; index++) {
                const child = pages.optionalPointer(children + index * 8, 0x70);
                if (child === undefined) { continue; }
                const matrix = matrices === undefined ? undefined : [0, 16, 32, 48].map((row) => vector(pages, matrices + index * 64 + row));
                bound(child, matrix === undefined ? transform : (value) => transform([0, 1, 2].map((axis) => value[0] * matrix[0][axis] + value[1] * matrix[1][axis] + value[2] * matrix[2][axis] + matrix[3][axis]) as Vec3), depth + 1);
            }
        } else if (type === 4 || type === 8) { geometry(at, transform); }
        else if (type === 0) { sphere(builder, material, vector(pages, at + 0x50), pages.f32(at + 0x14), transform); }
        else if (type === 1 || type === 3 || type === 12 || type === 13) {
            aabb(builder, material, vector(pages, at + 0x30), vector(pages, at + 0x20), transform);
            if (type !== 3 && !notes.some((note) => note.startsWith('Capsule'))) { notes.push('Capsule, cylinder and disc bounds are shown as their bounding boxes.'); }
        } else { notes.push(`${name} bounds are not shown.`); }
    }
    bound(0, (value) => value, 0);
    const built = builder.build();
    if (builder.truncated) { notes.push(`Only the first ${MAX_BOUND_TRIANGLES.toLocaleString('en-US')} triangles are shown.`); }
    // Exported files often carry a stale root box, so the extent comes from the vertices that are shown.
    const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const range of built.meshes) {
        for (let index = 0; index < range.vertexCount * 3; index++) {
            const value = built.buffer.readFloatLE(range.positions + index * 4), axis = index % 3;
            if (value < min[axis]) { min[axis] = value; }
            if (value > max[axis]) { max[axis] = value; }
        }
    }
    const empty = !built.meshes.length;
    return { summary: { kinds: [...kinds].map(([name, count]) => ({ name, count })), polygons, triangles: builder.triangles, vertices, min: empty ? vector(pages, 0x30) : min, max: empty ? vector(pages, 0x20) : max, materials: built.materials },
        mesh: { buffer: built.buffer, meshes: built.meshes, notes } };
}
