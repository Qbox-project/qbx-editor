import * as assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { assetHash } from '../../src/assetInventory';
import { parseBounds } from '../../src/boundsFormat';
import { clipName, MAX_CLIPS, parseClips } from '../../src/clipFormat';
import { buildLodMesh, parseModel } from '../../src/modelFormat';
import { RED_BC1 } from './assets';

type Test = [string, () => void | Promise<void>];
const SYSTEM = 0x4000, GRAPHICS = 0x2000;
const system = (offset: number): bigint => BigInt(0x50000000 + offset), graphics = (offset: number): bigint => BigInt(0x60000000 + offset);
function container(version: number, pages: Buffer, compressed = true): Buffer {
    const header = Buffer.alloc(16); header.write('RSC7'); header.writeUInt32LE(version, 4);
    header.writeUInt32LE(0x08000005, 8); header.writeUInt32LE(pages.length > SYSTEM ? 0x08000004 : 0, 12);
    return Buffer.concat([header, compressed ? deflateRawSync(pages) : pages]);
}
function floats(pages: Buffer, at: number, values: number[]): void { values.forEach((value, index) => pages.writeFloatLE(value, at + index * 4)); }
interface DrawableOptions { secondPointer?: boolean; withoutNormals?: boolean; badIndex?: boolean }
const QUAD = [[-1, -1, 0, 0, 0], [1, -1, 0, 1, 0], [1, 1, 0, 1, 1], [-1, 1, 0, 0, 1]];
/** Writes one drawable at `base` with independently chosen offsets: a textured quad, one material and one embedded BC1 texture. */
function drawable(pages: Buffer, base: number, options: DrawableOptions = {}): void {
    const at = (offset: number): number => base + offset, stride = options.withoutNormals ? 20 : 36;
    pages.writeBigUInt64LE(system(at(0x100)), at(0x10));
    floats(pages, at(0x20), [0, 0, 0, 1.5]); floats(pages, at(0x30), [-1, -1, 0]); floats(pages, at(0x40), [1, 1, 0]);
    pages.writeBigUInt64LE(system(at(0x280)), at(0x50)); pages.writeFloatLE(9998, at(0x70));
    pages.writeBigUInt64LE(system(at(0x260)), at(0xa8)); pages.write('test_prop.#dr\0', at(0x260), 'latin1'); pages.writeUInt16LE(2, at(0xb8));
    pages.writeBigUInt64LE(system(at(0x500)), at(0x108)); pages.writeBigUInt64LE(system(at(0x140)), at(0x110)); pages.writeUInt16LE(1, at(0x118));
    pages.writeBigUInt64LE(system(at(0x150)), at(0x140));
    pages.writeBigUInt64LE(system(at(0x180)), at(0x150)); pages.writeUInt32LE(assetHash('normal_spec'), at(0x158)); pages[at(0x160)] = 2; pages[at(0x161)] = 1;
    pages[at(0x180)] = 0; pages.writeBigUInt64LE(system(at(0x200)), at(0x188)); pages[at(0x190)] = 1; pages.writeBigUInt64LE(system(at(0x1a0)), at(0x198));
    pages.writeUInt32LE(assetHash('DiffuseSampler'), at(0x1b0)); pages.writeUInt32LE(assetHash('bumpiness'), at(0x1b4));
    pages.writeBigUInt64LE(system(at(0x240)), at(0x228)); pages.write('test_diffuse\0', at(0x240), 'latin1');
    pages.writeBigUInt64LE(system(at(0x290)), at(0x280)); pages.writeUInt16LE(1, at(0x288)); pages.writeUInt16LE(1, at(0x28a));
    pages.writeBigUInt64LE(system(at(0x2a0)), at(0x290));
    pages.writeBigUInt64LE(system(at(0x2d0)), at(0x2a8)); pages.writeUInt16LE(1, at(0x2b0)); pages.writeBigUInt64LE(system(at(0x2e0)), at(0x2c0));
    pages.writeBigUInt64LE(system(at(0x300)), at(0x2d0));
    pages.writeBigUInt64LE(system(at(0x3a0)), at(0x318)); pages.writeBigUInt64LE(system(at(0x420)), at(0x338));
    pages.writeUInt16LE(stride, at(0x3a8)); pages.writeBigUInt64LE(graphics(0), at(options.secondPointer ? 0x3c0 : 0x3b0)); pages.writeUInt32LE(4, at(0x3b8)); pages.writeBigUInt64LE(system(at(0x480)), at(0x3d0));
    pages.writeUInt32LE(6, at(0x428)); pages.writeBigUInt64LE(graphics(0x100), at(0x430));
    pages.writeUInt32LE(options.withoutNormals ? 0x41 : 0x59, at(0x480)); pages.writeUInt16LE(stride, at(0x484)); pages.writeBigUInt64LE(0x7755555555996996n, at(0x488));
    pages.writeBigUInt64LE(system(at(0x540)), at(0x530)); pages.writeUInt16LE(1, at(0x538)); pages.writeUInt16LE(1, at(0x53a));
    pages.writeBigUInt64LE(system(at(0x560)), at(0x540));
    pages.writeBigUInt64LE(system(at(0x240)), at(0x588)); pages.writeUInt16LE(4, at(0x5b0)); pages.writeUInt16LE(4, at(0x5b2)); pages.writeUInt16LE(1, at(0x5b4));
    pages.writeUInt32LE(0x31545844, at(0x5b8)); pages[at(0x5bd)] = 1; pages.writeBigUInt64LE(graphics(0x200), at(0x5d0));
    QUAD.forEach(([x, y, z, u, v], vertex) => {
        const from = SYSTEM + vertex * stride;
        floats(pages, from, [x, y, z]);
        if (options.withoutNormals) { floats(pages, from + 12, [u, v]); }
        else { floats(pages, from + 12, [0, 0, 1]); pages.writeUInt32LE(0xff8040ff, from + 24); floats(pages, from + 28, [u, v]); }
    });
    [0, 1, 2, 0, 2, options.badIndex ? 9 : 3].forEach((index, slot) => pages.writeUInt16LE(index, SYSTEM + 0x100 + slot * 2));
    RED_BC1.copy(pages, SYSTEM + 0x200);
}
export function syntheticYdr(options: DrawableOptions = {}, compressed = true): Buffer {
    const pages = Buffer.alloc(SYSTEM + GRAPHICS);
    drawable(pages, 0, options);
    return container(165, pages, compressed);
}
interface Gen9Options { halfFloats?: boolean }
/** Writes one Gen9 drawable at `base`: the same quad with a tangent between its normal and colour, a tinted material that lists its palette before its diffuse texture, and one embedded BC1 texture. */
function gen9Drawable(pages: Buffer, base: number, options: Gen9Options = {}): void {
    const at = (offset: number): number => base + offset, stride = options.halfFloats ? 12 : 52;
    pages.writeBigUInt64LE(system(at(0x100)), at(0x10));
    floats(pages, at(0x20), [0, 0, 0, 1.5]); floats(pages, at(0x30), [-1, -1, 0]); floats(pages, at(0x40), [1, 1, 0]);
    pages.writeBigUInt64LE(system(at(0x2e0)), at(0x50)); pages.writeFloatLE(9998, at(0x70));
    pages.writeBigUInt64LE(system(at(0x2c0)), at(0xa8)); pages.write('test_prop.#dr\0', at(0x2c0), 'latin1'); pages.writeUInt16LE(2, at(0xb8));
    pages.writeBigUInt64LE(system(at(0x5c0)), at(0x108)); pages.writeBigUInt64LE(system(at(0x140)), at(0x110)); pages.writeUInt16LE(1, at(0x118));
    pages.writeBigUInt64LE(system(at(0x150)), at(0x140));
    pages.writeUInt32LE(assetHash('normal_tnt'), at(0x150)); pages.writeBigUInt64LE(system(at(0x1c0)), at(0x158)); pages.writeBigUInt64LE(system(at(0x1e0)), at(0x160));
    pages.writeBigUInt64LE(system(at(0x190)), at(0x170)); pages[at(0x189)] = 1;
    pages[at(0x190)] = 1; pages[at(0x191)] = 3; pages[at(0x193)] = 1; pages[at(0x194)] = 5; pages[at(0x197)] = 12;
    const parameters: [string, number][] = [['TintPaletteTex', 0], ['DiffuseTex', 1 << 2], ['BumpTex', 2 << 2], ['DiffuseSampler', (1 << 2) | 2], ['Bumpiness', (4 << 20) | 3]];
    parameters.forEach(([name, data], index) => { pages.writeUInt32LE(assetHash(name), at(0x198 + index * 8)); pages.writeUInt32LE(data, at(0x19c + index * 8)); });
    pages.writeBigUInt64LE(system(at(0x200)), at(0x1e0)); pages.writeBigUInt64LE(system(at(0x250)), at(0x1e8));
    pages.writeBigUInt64LE(system(at(0x2a0)), at(0x228)); pages.write('test_pal\0', at(0x2a0), 'latin1');
    pages.writeBigUInt64LE(system(at(0x2b0)), at(0x278)); pages.write('test_diffuse\0', at(0x2b0), 'latin1');
    pages.writeBigUInt64LE(system(at(0x2f0)), at(0x2e0)); pages.writeUInt16LE(1, at(0x2e8)); pages.writeUInt16LE(1, at(0x2ea));
    pages.writeBigUInt64LE(system(at(0x300)), at(0x2f0));
    pages.writeBigUInt64LE(system(at(0x330)), at(0x308)); pages.writeUInt16LE(1, at(0x310)); pages.writeBigUInt64LE(system(at(0x338)), at(0x320));
    pages.writeBigUInt64LE(system(at(0x340)), at(0x330));
    pages.writeBigUInt64LE(system(at(0x3e0)), at(0x358)); pages.writeBigUInt64LE(system(at(0x420)), at(0x378));
    pages.writeUInt32LE(4, at(0x3e8)); pages.writeUInt16LE(stride, at(0x3ec)); pages.writeBigUInt64LE(graphics(0), at(0x3f8)); pages.writeBigUInt64LE(system(at(0x460)), at(0x418));
    pages.writeUInt32LE(6, at(0x428)); pages.writeUInt16LE(2, at(0x42c)); pages.writeBigUInt64LE(graphics(0x100), at(0x438));
    const element = (slot: number, offset: number, format: number): void => { pages.writeUInt32LE(offset, at(0x460 + slot * 4)); pages[at(0x530 + slot)] = stride; pages[at(0x564 + slot)] = format; };
    if (options.halfFloats) { element(0, 0, 10); element(28, 8, 34); }
    else { element(0, 0, 6); element(4, 12, 6); element(8, 24, 2); element(24, 40, 28); element(28, 44, 16); }
    pages.writeUInt32LE(stride << 2, at(0x598));
    pages.writeBigUInt64LE(system(at(0x600)), at(0x5f0)); pages.writeUInt16LE(1, at(0x5f8)); pages.writeUInt16LE(1, at(0x5fa));
    pages.writeBigUInt64LE(system(at(0x610)), at(0x600));
    pages.writeUInt16LE(4, at(0x628)); pages.writeUInt16LE(4, at(0x62a)); pages.writeUInt16LE(1, at(0x62c)); pages[at(0x62e)] = 1; pages[at(0x62f)] = 71; pages[at(0x630)] = 255; pages[at(0x632)] = 1;
    pages.writeBigUInt64LE(system(at(0x2b0)), at(0x638)); pages.writeBigUInt64LE(graphics(0x200), at(0x648));
    QUAD.forEach(([x, y, z, u, v], vertex) => {
        const from = SYSTEM + vertex * stride;
        if (options.halfFloats) { [x, y, z, 1, u, v].forEach((value, index) => pages.writeUInt16LE(value === 0 ? 0 : value > 0 ? 0x3c00 : 0xbc00, from + index * 2)); }
        else { floats(pages, from, [x, y, z, 0, 0, 1, 1, 0, 0, 1]); pages.writeUInt32LE(0xff8040ff, from + 40); floats(pages, from + 44, [u, v]); }
    });
    [0, 1, 2, 0, 2, 3].forEach((index, slot) => pages.writeUInt16LE(index, SYSTEM + 0x100 + slot * 2));
    RED_BC1.copy(pages, SYSTEM + 0x200);
}
function syntheticGen9Ydr(options: Gen9Options = {}, mutate?: (pages: Buffer) => void, compressed = true): Buffer {
    const pages = Buffer.alloc(SYSTEM + GRAPHICS);
    gen9Drawable(pages, 0, options); mutate?.(pages);
    return container(159, pages, compressed);
}
function meshFloats(buffer: Buffer, at: number, count: number): number[] { return Array.from({ length: count }, (_unused, index) => buffer.readFloatLE(at + index * 4)); }
/** A composite with one geometry child moved by (10, 20, 30): a triangle on surface type 56 and a sphere polygon on type 4. */
function syntheticYbn(mutate?: (pages: Buffer) => void): Buffer {
    const pages = Buffer.alloc(SYSTEM);
    pages[0x10] = 10; floats(pages, 0x20, [99, 99, 99]); floats(pages, 0x30, [-99, -99, -99]);
    pages.writeBigUInt64LE(system(0x100), 0x70); pages.writeBigUInt64LE(system(0x140), 0x78); pages.writeUInt16LE(1, 0xa0);
    pages.writeBigUInt64LE(system(0x200), 0x100);
    floats(pages, 0x140, [1, 0, 0]); floats(pages, 0x150, [0, 1, 0]); floats(pages, 0x160, [0, 0, 1]); floats(pages, 0x170, [10, 20, 30]);
    const child = 0x200;
    pages[child + 0x10] = 8; floats(pages, child + 0x90, [0.5, 0.5, 0.5]); floats(pages, child + 0xa0, [1, 1, 1]);
    pages.writeBigUInt64LE(system(0x440), child + 0x88); pages.writeBigUInt64LE(system(0x400), child + 0xb0); pages.writeUInt32LE(4, child + 0xd0); pages.writeUInt32LE(2, child + 0xd4);
    pages.writeBigUInt64LE(system(0x480), child + 0xf0); pages.writeBigUInt64LE(system(0x4a0), child + 0x118); pages[child + 0x120] = 2;
    [[0, 0, 0], [4, 0, 0], [0, 4, 0], [2, 2, 8]].forEach((vertex, index) => vertex.forEach((value, axis) => pages.writeInt16LE(value, 0x400 + index * 6 + axis * 2)));
    pages.writeFloatLE(1, 0x440); pages[0x440] &= 0xf8; pages.writeUInt16LE(0, 0x444); pages.writeUInt16LE(0x8001, 0x446); pages.writeUInt16LE(2, 0x448);
    pages.writeUInt16LE(1, 0x450); pages.writeUInt16LE(3, 0x452); pages.writeFloatLE(0.5, 0x454);
    pages[0x480] = 56; pages[0x488] = 4; pages[0x4a0] = 0; pages[0x4a1] = 1;
    mutate?.(pages);
    return container(43, pages);
}

/** Two clips in one hash bucket: an animation clip played at half rate and a list clip. */
export function syntheticYcd(mutate?: (pages: Buffer) => void): Buffer {
    const pages = Buffer.alloc(SYSTEM);
    pages.writeBigUInt64LE(system(0x100), 0x18); pages.writeBigUInt64LE(system(0x200), 0x28); pages.writeUInt16LE(2, 0x30); pages.writeUInt16LE(2, 0x32);
    pages.writeUInt16LE(1, 0x122);
    pages.writeBigUInt64LE(system(0x240), 0x200);
    pages.writeUInt32LE(0x1111, 0x240); pages.writeBigUInt64LE(system(0x300), 0x248); pages.writeBigUInt64LE(system(0x260), 0x250);
    pages.writeUInt32LE(0x2222, 0x260); pages.writeBigUInt64LE(system(0x400), 0x268);
    pages.writeUInt32LE(1, 0x310); pages.writeBigUInt64LE(system(0x380), 0x318); pages.write('pack:/Idle_A.clip\0', 0x380, 'latin1');
    pages.writeBigUInt64LE(system(0x500), 0x350); floats(pages, 0x358, [0, 2, 0.5]);
    pages.writeUInt32LE(2, 0x410); pages.writeBigUInt64LE(system(0x3c0), 0x418); pages.write('walk_list\0', 0x3c0, 'latin1'); pages.writeUInt16LE(3, 0x458); pages.writeFloatLE(4.5, 0x460);
    pages.writeUInt16LE(61, 0x514); pages.writeFloatLE(2, 0x518); pages.writeUInt16LE(1, 0x548); pages.writeUInt16LE(74, 0x558);
    mutate?.(pages);
    return container(46, pages);
}

const tests: Test[] = [
    ['a legacy drawable yields its geometry, material, embedded texture and bounds', async () => {
        for (const compressed of [true, false]) {
            const model = await parseModel(syntheticYdr({}, compressed), '.ydr'), [prop] = model.drawables;
            assert.equal(model.kind, 'ydr'); assert.equal(model.drawables.length, 1); assert.equal(prop.name, 'test_prop.#dr'); assert.equal(prop.lights, 2);
            assert.deepEqual([prop.min, prop.max, prop.center, prop.radius], [[-1, -1, 0], [1, 1, 0], [0, 0, 0], 1.5]);
            assert.deepEqual(prop.materials, [{ shader: 'normal_spec', bucket: 1, textures: [{ parameter: assetHash('DiffuseSampler'), name: 'test_diffuse' }], diffuse: 'test_diffuse' }]);
            assert.deepEqual(prop.textures.map((texture) => [texture.name, texture.width, texture.height, texture.encoding]), [['test_diffuse', 4, 4, 'BC1']]);
            assert.deepEqual(prop.lods.map((lod) => [lod.level, lod.distance, lod.vertices, lod.triangles, lod.geometries.length]), [[0, 9998, 4, 2, 1]]);
            const mesh = buildLodMesh(model, prop.lods[0]), [range] = mesh.meshes;
            assert.deepEqual(mesh.notes, []); assert.equal(mesh.meshes.length, 1); assert.deepEqual([range.material, range.vertexCount, range.indexCount], [0, 4, 6]);
            assert.deepEqual(meshFloats(mesh.buffer, range.positions, 12), QUAD.flatMap(([x, y, z]) => [x, y, z]));
            assert.deepEqual(meshFloats(mesh.buffer, range.normals, 12), [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
            assert.deepEqual(meshFloats(mesh.buffer, range.uvs, 8), QUAD.flatMap(([, , , u, v]) => [u, v]));
            assert.equal(mesh.buffer.readUInt32LE(range.colours), 0xff8040ff);
            assert.deepEqual(Array.from({ length: 6 }, (_unused, index) => mesh.buffer.readUInt16LE(range.indices + index * 2)), [0, 1, 2, 0, 2, 3]);
            assert.equal(mesh.buffer.length, range.indices + 12);
        }
    }],
    ['vertex data is found through the second buffer pointer, and missing normals are computed', async () => {
        const second = await parseModel(syntheticYdr({ secondPointer: true }), '.ydr');
        assert.deepEqual(meshFloats(buildLodMesh(second, second.drawables[0].lods[0]).buffer, 0, 3), [-1, -1, 0]);
        const bare = await parseModel(syntheticYdr({ withoutNormals: true }), '.ydr'), mesh = buildLodMesh(bare, bare.drawables[0].lods[0]), [range] = mesh.meshes;
        assert.deepEqual(meshFloats(mesh.buffer, range.normals, 12), [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]); assert.deepEqual(meshFloats(mesh.buffer, range.uvs + 8, 2), [1, 0]);
        assert.equal(mesh.buffer.readUInt32LE(range.colours), 0xffffffff);
        const broken = await parseModel(syntheticYdr({ badIndex: true }), '.ydr'), skipped = buildLodMesh(broken, broken.drawables[0].lods[0]);
        assert.equal(skipped.meshes.length, 0); assert.equal(skipped.buffer.length, 0); assert.match(skipped.notes[0], /1 geometry uses a vertex layout or indices that cannot be shown/);
    }],
    ['drawable dictionaries and fragments expose their drawables', async () => {
        const dictionary = Buffer.alloc(SYSTEM + GRAPHICS);
        dictionary.writeBigUInt64LE(system(0x80), 0x20); dictionary.writeUInt16LE(1, 0x28); dictionary.writeBigUInt64LE(system(0x90), 0x30); dictionary.writeUInt16LE(1, 0x38);
        dictionary.writeUInt32LE(assetHash('test_prop'), 0x80); dictionary.writeBigUInt64LE(system(0x1000), 0x90);
        drawable(dictionary, 0x1000);
        const ydd = await parseModel(container(165, dictionary), '.YDD');
        assert.equal(ydd.kind, 'ydd'); assert.equal(ydd.drawables.length, 1); assert.equal(ydd.drawables[0].name, 'test_prop.#dr'); assert.equal(ydd.drawables[0].lods[0].triangles, 2);
        const fragment = Buffer.alloc(SYSTEM + GRAPHICS);
        fragment.writeBigUInt64LE(system(0x1000), 0x30); fragment.writeUInt32LE(2, 0x48); fragment.writeBigUInt64LE(system(0x80), 0x58); fragment.write('test_frag\0', 0x80, 'latin1');
        drawable(fragment, 0x1000);
        const yft = await parseModel(container(162, fragment), '.yft');
        assert.equal(yft.drawables[0].name, 'test_frag'); assert.equal(buildLodMesh(yft, yft.drawables[0].lods[0]).meshes[0].indexCount, 6);
        assert.ok(yft.notes.some((note) => /2 damaged or extra drawables/.test(note)));
    }],
    ['a Gen9 drawable yields the same model and mesh as its legacy counterpart', async () => {
        for (const compressed of [true, false]) {
            const model = await parseModel(syntheticGen9Ydr({}, undefined, compressed), '.ydr'), [prop] = model.drawables;
            assert.equal(model.kind, 'ydr'); assert.equal(model.gen9, true); assert.deepEqual(model.notes, ['Gen9 (GTA V Enhanced) layout, resource version 159.']);
            assert.equal(model.drawables.length, 1); assert.equal(prop.name, 'test_prop.#dr'); assert.equal(prop.lights, 2); assert.deepEqual(prop.notes, []);
            assert.deepEqual([prop.min, prop.max, prop.center, prop.radius], [[-1, -1, 0], [1, 1, 0], [0, 0, 0], 1.5]);
            assert.deepEqual(prop.materials, [{ shader: 'normal_tnt', bucket: 1, diffuse: 'test_diffuse',
                textures: [{ parameter: assetHash('TintPaletteTex'), name: 'test_pal' }, { parameter: assetHash('DiffuseTex'), name: 'test_diffuse' }] }]);
            assert.deepEqual(prop.textures.map((texture) => [texture.name, texture.width, texture.height, texture.encoding]), [['test_diffuse', 4, 4, 'BC1']]);
            assert.deepEqual(prop.lods.map((lod) => [lod.level, lod.distance, lod.vertices, lod.triangles, lod.geometries.length]), [[0, 9998, 4, 2, 1]]);
            const mesh = buildLodMesh(model, prop.lods[0]), [range] = mesh.meshes;
            assert.deepEqual(mesh.notes, []); assert.deepEqual([range.material, range.vertexCount, range.indexCount], [0, 4, 6]);
            assert.deepEqual(meshFloats(mesh.buffer, range.positions, 12), QUAD.flatMap(([x, y, z]) => [x, y, z]));
            assert.deepEqual(meshFloats(mesh.buffer, range.normals, 12), [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
            assert.deepEqual(meshFloats(mesh.buffer, range.uvs, 8), QUAD.flatMap(([, , , u, v]) => [u, v]));
            assert.equal(mesh.buffer.readUInt32LE(range.colours), 0xff8040ff);
            const legacy = await parseModel(syntheticYdr(), '.ydr');
            assert.equal(legacy.gen9, false); assert.ok(mesh.buffer.equals(buildLodMesh(legacy, legacy.drawables[0].lods[0]).buffer));
        }
    }],
    ['Gen9 vertex declarations give each element its own offset and format, and unreadable ones are skipped', async () => {
        const halves = await parseModel(syntheticGen9Ydr({ halfFloats: true }), '.ydr'), mesh = buildLodMesh(halves, halves.drawables[0].lods[0]), [range] = mesh.meshes;
        assert.deepEqual(meshFloats(mesh.buffer, range.positions, 12), QUAD.flatMap(([x, y, z]) => [x, y, z]));
        assert.deepEqual(meshFloats(mesh.buffer, range.normals, 12), [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]); assert.deepEqual(meshFloats(mesh.buffer, range.uvs, 8), QUAD.flatMap(([, , , u, v]) => [u, v]));
        assert.equal(mesh.buffer.readUInt32LE(range.colours), 0xffffffff);
        const plain = await parseModel(syntheticGen9Ydr(), '.ydr'), unstepped = await parseModel(syntheticGen9Ydr({}, (pages) => pages.fill(0, 0x530, 0x564)), '.ydr');
        assert.ok(buildLodMesh(unstepped, unstepped.drawables[0].lods[0]).buffer.equals(buildLodMesh(plain, plain.drawables[0].lods[0]).buffer));
        for (const mutate of [(pages: Buffer) => pages.writeUInt32LE(0x1000, 0x460), (pages: Buffer) => pages.writeUInt32LE(41, 0x460), (pages: Buffer) => { pages[0x564] = 24; }, (pages: Buffer) => { pages[0x564] = 0; }]) {
            const unreadable = await parseModel(syntheticGen9Ydr({}, mutate), '.ydr'), skipped = buildLodMesh(unreadable, unreadable.drawables[0].lods[0]);
            assert.equal(skipped.meshes.length, 0); assert.equal(skipped.buffer.length, 0); assert.match(skipped.notes[0], /1 geometry uses a vertex layout or indices that cannot be shown/);
        }
        const faces = await parseModel(syntheticGen9Ydr({}, (pages) => { pages[0x564 + 4] = 24; pages.writeUInt32LE(0x1000, 0x460 + 28 * 4); }), '.ydr'), computed = buildLodMesh(faces, faces.drawables[0].lods[0]);
        assert.deepEqual(meshFloats(computed.buffer, computed.meshes[0].normals, 3), [0, 0, 1]); assert.deepEqual(meshFloats(computed.buffer, computed.meshes[0].uvs, 8), [0, 0, 0, 0, 0, 0, 0, 0]);
        const wide = await parseModel(syntheticGen9Ydr({}, (pages) => pages.writeUInt16LE(4, 0x42c)), '.ydr');
        assert.deepEqual(wide.drawables[0].lods, []); assert.match(wide.drawables[0].notes[0], /1 geometry uses indices wider than 16 bits/);
    }],
    ['Gen9 materials name textures through the parameter table', async () => {
        const names = async (mutate: (pages: Buffer) => void): Promise<[string[], string | undefined]> => {
            const [material] = (await parseModel(syntheticGen9Ydr({}, mutate), '.ydr')).drawables[0].materials;
            return [material.textures.map((use) => use.name), material.diffuse];
        };
        assert.deepEqual(await names((pages) => pages.writeUInt32LE(assetHash('DiffuseTexture_layer0'), 0x1a0)), [['test_pal', 'test_diffuse'], 'test_diffuse']);
        assert.deepEqual(await names((pages) => pages.writeUInt32LE(assetHash('SpecularTex'), 0x1a0)), [['test_pal', 'test_diffuse'], 'test_pal']);
        assert.deepEqual(await names((pages) => pages.writeUInt32LE(9 << 2, 0x1a4)), [['test_pal'], 'test_pal']);
        assert.deepEqual(await names((pages) => pages.writeUInt32LE((1 << 2) | 3, 0x1a4)), [['test_pal'], 'test_pal']);
        assert.deepEqual(await names((pages) => pages.writeBigUInt64LE(0n, 0x160)), [[], undefined]);
        assert.deepEqual(await names((pages) => pages.writeBigUInt64LE(0n, 0x170)), [[], undefined]);
        await assert.rejects(parseModel(syntheticGen9Ydr({}, (pages) => { pages[0x194] = 97; }), '.ydr'), /more than 96 parameters/);
        await assert.rejects(parseModel(syntheticGen9Ydr({}, (pages) => pages.writeBigUInt64LE(system(0x3ffc), 0x170)), '.ydr'), /invalid resource pointer/);
        await assert.rejects(parseModel(syntheticGen9Ydr({}, (pages) => pages.writeBigUInt64LE(graphics(0x1ff0), 0x1e8)), '.ydr'), /invalid resource pointer/);
    }],
    ['Gen9 drawable dictionaries and fragments expose their drawables', async () => {
        const dictionary = Buffer.alloc(SYSTEM + GRAPHICS);
        dictionary.writeBigUInt64LE(system(0x80), 0x20); dictionary.writeUInt16LE(1, 0x28); dictionary.writeBigUInt64LE(system(0x90), 0x30); dictionary.writeUInt16LE(1, 0x38);
        dictionary.writeUInt32LE(assetHash('test_prop'), 0x80); dictionary.writeBigUInt64LE(system(0x1000), 0x90);
        gen9Drawable(dictionary, 0x1000);
        const ydd = await parseModel(container(159, dictionary), '.ydd');
        assert.equal(ydd.gen9, true); assert.equal(ydd.drawables.length, 1); assert.equal(ydd.drawables[0].name, 'test_prop.#dr'); assert.equal(ydd.drawables[0].materials[0].diffuse, 'test_diffuse');
        assert.equal(buildLodMesh(ydd, ydd.drawables[0].lods[0]).meshes[0].indexCount, 6);
        const fragment = Buffer.alloc(SYSTEM + GRAPHICS);
        fragment.writeBigUInt64LE(system(0x1000), 0x30); fragment.writeUInt32LE(1, 0x48); fragment.writeBigUInt64LE(system(0x80), 0x58); fragment.write('test_frag\0', 0x80, 'latin1');
        gen9Drawable(fragment, 0x1000);
        const yft = await parseModel(container(171, fragment), '.yft');
        assert.equal(yft.gen9, true); assert.equal(yft.drawables[0].name, 'test_frag'); assert.equal(yft.drawables[0].textures[0].name, 'test_diffuse');
        assert.deepEqual(meshFloats(buildLodMesh(yft, yft.drawables[0].lods[0]).buffer, 0, 3), [-1, -1, 0]);
        assert.deepEqual(yft.notes, ['Gen9 (GTA V Enhanced) layout, resource version 171.', 'The fragment also holds 1 damaged or extra drawable, which are not shown.', 'Fragment physics, glass and cloth data are not shown.']);
        await assert.rejects(parseModel(container(171, dictionary), '.ydd'), /YDD resource version 171 is unsupported; expected 165 or 159/);
        await assert.rejects(parseModel(container(159, fragment), '.yft'), /YFT resource version 159 is unsupported; expected 162 or 171/);
    }],
    ['unsupported, truncated and inconsistent model files are rejected with a reason', async () => {
        const good = syntheticYdr({}, false);
        const gen9 = syntheticGen9Ydr({}, undefined, false);
        for (const length of [0, 12, 16, 0x400]) { await assert.rejects(parseModel(gen9.subarray(0, length), '.ydr'), /./); }
        const gen9Mutated = (mutate: (pages: Buffer) => void): Promise<unknown> => parseModel(syntheticGen9Ydr({}, mutate), '.ydr');
        await assert.rejects(gen9Mutated((pages) => pages.writeBigUInt64LE(graphics(0x1f80), 0x3f8)), /invalid resource pointer/);
        await assert.rejects(gen9Mutated((pages) => pages.writeBigUInt64LE(system(0x3f00), 0x418)), /invalid resource pointer/);
        await assert.rejects(gen9Mutated((pages) => pages.writeBigUInt64LE(0n, 0x418)), /missing a required resource pointer/);
        await assert.rejects(gen9Mutated((pages) => pages.writeUInt32LE(0x10000, 0x3e8)), /more vertices or indices than the format allows/);
        await assert.rejects(gen9Mutated((pages) => pages.writeUInt32LE(0x2000, 0x428)), /invalid resource pointer/);
        await assert.rejects(gen9Mutated((pages) => pages.writeUInt16LE(5000, 0x118)), /more than 1,024 materials/);
        const noTextures9 = await parseModel(syntheticGen9Ydr({}, (pages) => pages.writeUInt16LE(3000, 0x5f8)), '.ydr');
        assert.equal(noTextures9.drawables[0].textures.length, 0); assert.match(noTextures9.drawables[0].notes[0], /Embedded textures were not read/);
        const other = Buffer.from(good); other.writeUInt32LE(13, 4);
        await assert.rejects(parseModel(other, '.ydr'), /YDR resource version 13 is unsupported; expected 165 or 159/);
        await assert.rejects(parseModel(good, '.txt'), /reads YDR, YDD and YFT/);
        for (const length of [0, 12, 16, 0x400]) { await assert.rejects(parseModel(good.subarray(0, length), '.ydr'), /./); }
        const mutated = (mutate: (pages: Buffer) => void): Buffer => { const copy = Buffer.from(good); mutate(copy.subarray(16)); return copy; };
        await assert.rejects(parseModel(mutated((pages) => pages.writeBigUInt64LE(0x5fffffffn, 0x50)), '.ydr'), /invalid resource pointer/);
        await assert.rejects(parseModel(mutated((pages) => pages.writeUInt16LE(5000, 0x118)), '.ydr'), /more than 1,024 materials/);
        await assert.rejects(parseModel(mutated((pages) => pages.writeUInt32LE(0x10000, 0x3b8)), '.ydr'), /more vertices or indices than the format allows/);
        await assert.rejects(parseModel(mutated((pages) => pages.writeUInt32LE(0xffff, 0x3b8)), '.ydr'), /invalid resource pointer/);
        const noTextures = await parseModel(mutated((pages) => pages.writeUInt16LE(3000, 0x538)), '.ydr');
        assert.equal(noTextures.drawables[0].textures.length, 0); assert.match(noTextures.drawables[0].notes[0], /Embedded textures were not read/);
    }],
    ['collision bounds become triangles grouped by surface type, in the parent space', async () => {
        const bounds = await parseBounds(syntheticYbn()), { summary, mesh } = bounds;
        assert.deepEqual(summary.kinds, [{ name: 'Composite', count: 1 }, { name: 'Geometry (BVH)', count: 1 }]);
        assert.equal(summary.polygons, 2); assert.equal(summary.vertices, 4); assert.deepEqual(summary.materials, [{ type: 4, triangles: 100 }, { type: 56, triangles: 1 }]);
        assert.equal(summary.triangles, 101); assert.deepEqual(mesh.meshes.map((range) => range.material), [4, 56]);
        const triangle = mesh.meshes[1];
        assert.deepEqual([triangle.vertexCount, triangle.indexCount, triangle.normals, triangle.uvs, triangle.colours], [3, 3, -1, -1, -1]);
        assert.deepEqual(meshFloats(mesh.buffer, triangle.positions, 9), [11, 21, 31, 13, 21, 31, 11, 23, 31]);
        const sphere = mesh.meshes[0], points = meshFloats(mesh.buffer, sphere.positions, sphere.vertexCount * 3);
        for (let index = 0; index < points.length; index += 3) { assert.ok(Math.abs(Math.hypot(points[index] - 12, points[index + 1] - 22, points[index + 2] - 35) - 0.5) < 1e-5); }
        assert.deepEqual(summary.min.map((value) => Math.round(value * 100) / 100), [11, 21, 31]); assert.deepEqual(summary.max.map((value) => Math.round(value * 100) / 100), [13, 23, 35.5]);
        await assert.rejects(parseBounds(syntheticYbn((pages) => pages.writeUInt16LE(7, 0x448))), /refers to a vertex that does not exist/);
        await assert.rejects(parseBounds(syntheticYbn((pages) => pages.writeBigUInt64LE(system(0), 0x100))), /nests or repeats bounds beyond the inspection limit/);
        const box = await parseBounds(syntheticYbn((pages) => { pages[0x10] = 3; floats(pages, 0x20, [1, 2, 3]); floats(pages, 0x30, [-1, -2, -3]); }));
        assert.deepEqual(box.summary.kinds, [{ name: 'Box', count: 1 }]); assert.equal(box.summary.triangles, 12); assert.deepEqual([box.summary.min, box.summary.max], [[-1, -2, -3], [1, 2, 3]]);
    }],
    ['an animation dictionary lists its clips with the names scripts use', async () => {
        assert.equal(clipName('pack:/Idle_A.clip'), 'idle_a'); assert.equal(clipName('folder\\Walk.Fast.clip'), 'walk.fast'); assert.equal(clipName('plain'), 'plain');
        const file = await parseClips(syntheticYcd());
        assert.equal(file.animations, 1); assert.deepEqual(file.notes, []);
        assert.deepEqual(file.clips, [
            { hash: 0x1111, name: 'idle_a', path: 'pack:/Idle_A.clip', kind: 'animation', duration: 4, rate: 0.5, frames: 61, fps: 30, bones: 74, sequences: 1, parts: 1 },
            { hash: 0x2222, name: 'walk_list', path: 'walk_list', kind: 'list', duration: 4.5, rate: 1, frames: 0, fps: 0, bones: 0, sequences: 0, parts: 3 },
        ]);
        const looped = await parseClips(syntheticYcd((pages) => pages.writeBigUInt64LE(system(0x260), 0x270)));
        assert.equal(looped.clips.length, MAX_CLIPS); assert.match(looped.notes[0], /Only the first 20,000 clips are listed/);
        const empty = await parseClips(syntheticYcd((pages) => pages.writeUInt16LE(0, 0x30)));
        assert.deepEqual(empty.clips, []);
        await assert.rejects(parseClips(syntheticYcd((pages) => pages.writeBigUInt64LE(0x5fffffffn, 0x248))), /invalid resource pointer/);
        const model = Buffer.from(syntheticYcd()); model.writeUInt32LE(165, 4);
        await assert.rejects(parseClips(model), /YCD resource version 165 is unsupported; expected 46/);
    }],
];
export async function runModelDataTests(): Promise<void> {
    const failures: string[] = [];
    for (const [name, body] of tests) {
        try { await body(); console.log(`  ok   ${name}`); }
        catch (error) { failures.push(name); console.error(`  FAIL ${name}\n${error instanceof Error ? error.stack : String(error)}`); }
    }
    if (failures.length) { throw new Error(`${failures.length} model data test(s) failed: ${failures.join(', ')}`); }
}
