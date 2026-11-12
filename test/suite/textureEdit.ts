import * as assert from 'node:assert/strict';
import { deflateSync, inflateRawSync } from 'node:zlib';
import { parseYtd, resourcePageSize, textureMip } from '../../src/assetFormats';
import type { TextureEncoding } from '../../src/assetTypes';
import { decodePng, encodePng, type Image } from '../../src/pngCodec';
import { encodeLevel, encodeTexture, mipLevels, resize } from '../../src/textureEncode';
import { buildDictionary, readDictionary, renameTexture, storeTexture, textureHash, textureMemory, textureNameFromFile, textureNameProblem, type StoredDictionary } from '../../src/textureWrite';
import { RED_BC1, syntheticYtd } from './assets';

type Test = [string, () => void | Promise<void>];
export function testImage(width: number, height: number, pixel: (x: number, y: number) => readonly [number, number, number, number]): Image {
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) { for (let x = 0; x < width; x++) { rgba.set(pixel(x, y), (y * width + x) * 4); } }
    return { width, height, rgba };
}
function noise(seed: number): () => number { let state = seed; return () => { state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff; return state / 0x7fffffff; }; }
function psnr(a: Uint8Array, b: Uint8Array, channels: readonly number[], keep: (at: number) => boolean = () => true): number {
    let sum = 0, count = 0;
    for (let at = 0; at < a.length; at += 4) { if (keep(at)) { for (const channel of channels) { sum += (a[at + channel] - b[at + channel]) ** 2; count++; } } }
    return sum ? 10 * Math.log10(255 * 255 * count / sum) : Infinity;
}
const CRC = new Uint32Array(256).map((_, index) => { let value = index; for (let bit = 0; bit < 8; bit++) { value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; } return value >>> 0; });
function pngChunk(type: string, body: Buffer): Buffer {
    const out = Buffer.alloc(12 + body.length); out.writeUInt32BE(body.length, 0); out.write(type, 4, 'latin1'); body.copy(out, 8);
    let crc = 0xffffffff;
    for (const byte of out.subarray(4, 8 + body.length)) { crc = CRC[(crc ^ byte) & 0xff] ^ (crc >>> 8); }
    out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + body.length);
    return out;
}
/**
 * A PNG written sample by sample, independently of the codec under test: `samples(x, y)` gives one pixel's
 * channel values at the file's bit depth, and every row uses the filter `filters[row % filters.length]`.
 */
function handmadePng(width: number, height: number, depth: number, colour: number, samples: (x: number, y: number) => number[], extra: Buffer[] = [], interlaced = false, filters = [0]): Buffer {
    const passes = interlaced ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
    const channels = [1, 0, 3, 1, 2, 0, 4][colour], step = Math.max(1, (channels * depth) >> 3), lines: Buffer[] = [];
    for (const [x0, y0, dx, dy] of passes) {
        const columns = Math.ceil((width - x0) / dx), rows = Math.ceil((height - y0) / dy);
        if (columns <= 0 || rows <= 0) { continue; }
        let prior = Buffer.alloc(Math.ceil(columns * channels * depth / 8));
        for (let row = 0; row < rows; row++) {
            const line = Buffer.alloc(prior.length);
            let bit = 0;
            for (let column = 0; column < columns; column++) {
                for (const value of samples(x0 + column * dx, y0 + row * dy)) {
                    if (depth === 16) { line.writeUInt16BE(value, bit >> 3); } else if (depth === 8) { line[bit >> 3] = value; } else { line[bit >> 3] |= value << (8 - depth - (bit & 7)); }
                    bit += depth;
                }
            }
            const filter = filters[row % filters.length], out = Buffer.alloc(line.length + 1); out[0] = filter;
            for (let index = 0; index < line.length; index++) {
                const left = index >= step ? line[index - step] : 0, up = prior[index], corner = index >= step ? prior[index - step] : 0, estimate = left + up - corner;
                const paeth = Math.abs(estimate - left) <= Math.abs(estimate - up) && Math.abs(estimate - left) <= Math.abs(estimate - corner) ? left : Math.abs(estimate - up) <= Math.abs(estimate - corner) ? up : corner;
                out[index + 1] = (line[index] - [0, left, up, (left + up) >> 1, paeth][filter]) & 0xff;
            }
            lines.push(out); prior = line;
        }
    }
    const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = depth; header[9] = colour; header[12] = interlaced ? 1 : 0;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', header), ...extra, pngChunk('IDAT', deflateSync(Buffer.concat(lines))), pngChunk('IEND', Buffer.alloc(0))]);
}
function pixels(image: Image): number[][] { return Array.from({ length: image.width * image.height }, (_, index) => [...image.rgba.subarray(index * 4, index * 4 + 4)]); }
function expected(width: number, height: number, pixel: (x: number, y: number) => number[]): number[][] {
    return Array.from({ length: width * height }, (_, index) => pixel(index % width, Math.floor(index / width)));
}
async function decoded(image: Image, encoding: TextureEncoding): Promise<Uint8Array> {
    const { decodeAssetTexture } = await import('../../src/assetTextureDecode.mjs');
    return decodeAssetTexture(await encodeLevel(image, encoding), image.width, image.height, encoding);
}
/** Byte ranges of every page a flag word describes, largest pages first. */
function pageRanges(flags: number, base: number): [number, number][] {
    const unit = 512 * 2 ** (flags & 15), counts = [(flags >>> 4) & 1, (flags >>> 5) & 3, (flags >>> 7) & 15, (flags >>> 11) & 63, (flags >>> 17) & 127, (flags >>> 24) & 1, (flags >>> 25) & 1, (flags >>> 26) & 1, (flags >>> 27) & 1];
    const ranges: [number, number][] = [];
    let at = base;
    counts.forEach((count, index) => { for (let page = 0; page < count; page++) { ranges.push([at, at + unit * 2 ** (8 - index)]); at += unit * 2 ** (8 - index); } });
    return ranges;
}
/** Walks a built file without the reader under test and returns every block as a byte range of the expanded pages. */
function blocksOf(file: Buffer): { pages: Buffer; system: number; ranges: [number, number][]; blocks: { what: string; from: number; to: number }[] } {
    const gen9 = file.readUInt32LE(4) === 5, system = resourcePageSize(file.readUInt32LE(8)), pages = inflateRawSync(file.subarray(16));
    const offset = (at: number): number => { const value = pages.readBigUInt64LE(at); return Number(value & 0xfffffffn) + ((value & 0xf0000000n) === 0x60000000n ? system : 0); };
    const count = pages.readUInt16LE(0x38), blocks = [{ what: 'root', from: 0, to: 0x40 }, { what: 'page info', from: offset(0x08), to: offset(0x08) + 16 + 8 * (pages[offset(0x08) + 8] + pages[offset(0x08) + 9]) }];
    if (count) { blocks.push({ what: 'hashes', from: offset(0x20), to: offset(0x20) + count * 4 }, { what: 'list', from: offset(0x30), to: offset(0x30) + count * 8 }); }
    for (let index = 0; index < count; index++) {
        const record = offset(offset(0x30) + index * 8), name = offset(record + 0x28), end = pages.indexOf(0, name) + 1;
        const width = pages.readUInt16LE(record + (gen9 ? 0x18 : 0x50)), height = pages.readUInt16LE(record + (gen9 ? 0x1a : 0x52)), levels = pages[record + (gen9 ? 0x22 : 0x5d)];
        const code = gen9 ? pages[record + 0x1f] : pages.readUInt32LE(record + 0x58), block = [0x31545844, 0x31495441, 0x47, 0x50].includes(code) ? 8 : 16, compressed = gen9 ? code >= 0x46 && code !== 0x57 : code > 0xffff;
        let size = 0;
        for (let mip = 0; mip < levels; mip++) { const w = Math.max(1, width >> mip), h = Math.max(1, height >> mip); size += compressed ? Math.ceil(w / 4) * Math.ceil(h / 4) * block : w * h * 4; }
        blocks.push({ what: `record ${index}`, from: record, to: record + (gen9 ? 0x80 : 0x90) }, { what: `name ${index}`, from: name, to: end }, { what: `data ${index}`, from: offset(record + (gen9 ? 0x38 : 0x70)), to: offset(record + (gen9 ? 0x38 : 0x70)) + size });
    }
    return { pages, system, ranges: [...pageRanges(file.readUInt32LE(8), 0), ...pageRanges(file.readUInt32LE(12), system)], blocks };
}
function assertSound(file: Buffer): void {
    const { pages, ranges, blocks } = blocksOf(file);
    assert.equal(ranges.length ? ranges[ranges.length - 1][1] : 0, pages.length, 'the page flags describe exactly the expanded bytes');
    assert.ok(ranges.length <= 128, 'a resource holds at most 128 pages');
    for (const block of blocks) {
        assert.ok(ranges.some(([from, to]) => block.from >= from && block.to <= to), `${block.what} lies inside one page`);
        assert.equal(block.from % 16, 0, `${block.what} starts on a 16-byte boundary`);
    }
    const sorted = [...blocks].sort((a, b) => a.from - b.from);
    for (let index = 1; index < sorted.length; index++) { assert.ok(sorted[index].from >= sorted[index - 1].to, `${sorted[index].what} does not overlap ${sorted[index - 1].what}`); }
}
const smooth = (seed: number): Image => { const random = noise(seed); return testImage(64, 64, (x, y) => { const wave = 128 + 80 * Math.sin(x / 9) * Math.cos(y / 11), grain = (random() - 0.5) * 6; return [wave + grain, wave * 0.7 + 40 + grain, 200 - wave * 0.5 + grain, 255].map((value) => Math.max(0, Math.min(255, Math.round(value)))) as [number, number, number, number]; }); };
async function dictionary(gen9: boolean, images: [string, Image][]): Promise<StoredDictionary> {
    const textures = [];
    for (const [name, image] of images) { textures.push(storeTexture(name, await encodeTexture(image, name, { compression: 'auto', mipmaps: 'auto' }), gen9)); }
    return { gen9, textures };
}

const tests: Test[] = [
    ['PNG files of every colour type, bit depth, filter and interlacing decode to the pixels written', () => {
        const random = noise(7), rgba = Array.from({ length: 5 * 7 }, () => [0, 1, 2, 3].map(() => Math.floor(random() * 256)));
        assert.deepEqual(pixels(decodePng(handmadePng(5, 7, 8, 6, (x, y) => rgba[y * 5 + x], [], false, [0, 1, 2, 3, 4]))), rgba);
        const mono = decodePng(handmadePng(9, 3, 1, 0, (x, y) => [(x + y) & 1], [pngChunk('tRNS', Buffer.from([0, 0]))]));
        assert.deepEqual(pixels(mono), expected(9, 3, (x, y) => (x + y) & 1 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
        const palette = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 8, 7]);
        const indexed = decodePng(handmadePng(5, 5, 2, 3, (x, y) => [(x + y) % 4], [pngChunk('PLTE', palette), pngChunk('tRNS', Buffer.from([10, 200]))], false, [4]));
        assert.deepEqual(pixels(indexed), expected(5, 5, (x, y) => { const entry = (x + y) % 4; return [...palette.subarray(entry * 3, entry * 3 + 3), [10, 200, 255, 255][entry]]; }));
        const deep = decodePng(handmadePng(3, 2, 16, 2, (x, y) => [x * 0x2040 + 0x11, y * 0x8000 + 0xff, 0xabcd], [pngChunk('tRNS', Buffer.from([0x20, 0x51, 0x80, 0xff, 0xab, 0xcd]))], false, [3]));
        assert.deepEqual(pixels(deep), expected(3, 2, (x, y) => [(x * 0x2040 + 0x11) >> 8, (y * 0x8000 + 0xff) >> 8, 0xab, x === 1 && y === 1 ? 0 : 255]));
        const woven = decodePng(handmadePng(9, 9, 8, 4, (x, y) => [x * 20 + y, 255 - y * 9], [], true, [1, 2, 4]));
        assert.deepEqual(pixels(woven), expected(9, 9, (x, y) => [x * 20 + y, x * 20 + y, x * 20 + y, 255 - y * 9]));
        const tiny = decodePng(handmadePng(1, 1, 4, 0, () => [9], [], true));
        assert.deepEqual(pixels(tiny), [[153, 153, 153, 255]]);
    }],
    ['PNG output reads back exactly and malformed input is refused', () => {
        const random = noise(11), image = testImage(13, 6, (x) => [Math.floor(random() * 256), x * 19, 255 - x, x % 3 ? 255 : Math.floor(random() * 256)]);
        const file = encodePng(image), back = decodePng(file);
        assert.deepEqual([back.width, back.height], [13, 6]); assert.deepEqual(Buffer.from(back.rgba), Buffer.from(image.rgba));
        assert.throws(() => decodePng(Buffer.from('not a png at all')), /not a PNG/);
        assert.throws(() => decodePng(file.subarray(0, file.length - 20)), /truncated|corrupt/);
        assert.throws(() => decodePng(handmadePng(4097, 1, 8, 0, () => [0])), /largest supported texture is 4096/);
        assert.throws(() => decodePng(handmadePng(2, 2, 8, 3, () => [3], [pngChunk('PLTE', Buffer.from([1, 2, 3]))])), /outside its palette/);
        assert.throws(() => decodePng(handmadePng(2, 2, 8, 3, () => [0])), /no palette/);
        assert.throws(() => decodePng(handmadePng(2, 2, 3, 0, () => [0])), /header is invalid/);
        const broken = Buffer.from(file); broken.fill(0x55, 45, 60);
        assert.throws(() => decodePng(broken), /corrupt|truncated/);
    }],
    ['every encoding decodes back close to the source with an independent decoder', async () => {
        const source = smooth(3);
        const reached: Record<string, number> = {};
        for (const [encoding, channels, floor] of [['BC1', [0, 1, 2], 38], ['BC3', [0, 1, 2, 3], 38], ['BC7', [0, 1, 2, 3], 42], ['BC4', [0], 40], ['BC5', [0, 1], 40]] as const) {
            reached[encoding] = psnr(source.rgba, await decoded(source, encoding), channels);
            assert.ok(reached[encoding] >= floor, `${encoding} reached ${reached[encoding].toFixed(1)} dB, expected at least ${floor}`);
        }
        assert.ok(reached.BC7 > reached.BC1 + 2, 'BC7 is the higher-quality choice');
        for (const [encoding, channels] of [['BGRA8', [0, 1, 2, 3]], ['RGBA8', [0, 1, 2, 3]], ['R8', [0]], ['A8', [3]]] as const) {
            assert.equal(psnr(source.rgba, await decoded(source, encoding), channels), Infinity, `${encoding} is lossless`);
        }
        const flat = testImage(8, 8, () => [37, 141, 203, 255]);
        for (const encoding of ['BC1', 'BC3', 'BC7'] as const) {
            const out = await decoded(flat, encoding);
            for (let at = 0; at < out.length; at += 4) { for (let channel = 0; channel < 3; channel++) { assert.ok(Math.abs(out[at + channel] - flat.rgba[at + channel]) <= 3, `${encoding} keeps a flat colour`); } assert.equal(out[at + 3], 255); }
        }
        const edge = testImage(6, 5, (x, y) => [x * 40, y * 50, 90, 255]);
        assert.equal((await decoded(edge, 'BC1')).length, 6 * 5 * 4, 'sizes that are not multiples of four fill whole blocks');
    }],
    ['transparency survives: exact ends, clean edges and hidden pixels that do not bleed', async () => {
        const cutout = testImage(32, 32, (x, y) => x < 16 ? [200, 40 + y * 4, 30, 255] : x < 20 ? [200, 40 + y * 4, 30, 255 - (x - 15) * 50] : [255, 255, 255, 0]);
        for (const encoding of ['BC3', 'BC7'] as const) {
            const out = await decoded(cutout, encoding);
            for (let at = 0; at < out.length; at += 4) { if (cutout.rgba[at + 3] === 255 || cutout.rgba[at + 3] === 0) { assert.equal(out[at + 3], cutout.rgba[at + 3], `${encoding} keeps fully opaque and fully clear pixels exact`); } }
        }
        const visible = psnr(cutout.rgba, await decoded(cutout, 'BC3'), [0, 1, 2], (at) => cutout.rgba[at + 3] === 255);
        assert.ok(visible >= 36, `visible colour reached ${visible.toFixed(1)} dB although hidden pixels are white`);
        assert.deepEqual([...resize(testImage(2, 1, (x) => x ? [255, 255, 255, 0] : [200, 10, 10, 255]), 1, 1, 'colour').rgba], [200, 10, 10, 128]);
        assert.deepEqual([...resize(testImage(2, 1, () => [90, 80, 70, 0]), 1, 1, 'colour').rgba], [90, 80, 70, 0], 'fully hidden colour is kept, not turned black');
    }],
    ['mip levels are averaged in linear light for colour and as stored for data maps', async () => {
        const checker = testImage(4, 4, (x, y) => (x + y) & 1 ? [255, 255, 255, 255] : [0, 0, 0, 255]);
        assert.deepEqual([...resize(checker, 2, 2, 'colour').rgba.subarray(0, 4)], [188, 188, 188, 255]);
        assert.deepEqual([...resize(checker, 2, 2, 'data').rgba.subarray(0, 4)], [128, 128, 128, 255]);
        assert.deepEqual([mipLevels(1024, 1024), mipLevels(2048, 1024), mipLevels(256, 64), mipLevels(8, 8), mipLevels(4, 4), mipLevels(256, 2)], [9, 9, 5, 2, 1, 1]);
        const wide = testImage(8, 8, (x) => [x * 36, 0, 0, 255]);
        assert.deepEqual([...resize(wide, 16, 8, 'data').rgba.filter((_, index) => index % 4 === 0).subarray(0, 16)], [0, 9, 27, 45, 63, 81, 99, 117, 135, 153, 171, 189, 207, 225, 243, 252], 'enlarging interpolates between neighbours');
        const normal = await encodeTexture(checker, 'wall_n', { compression: 'BGRA8', mipmaps: 'all' }), colour = await encodeTexture(testImage(8, 8, (x, y) => (x + y) & 1 ? [255, 255, 255, 255] : [0, 0, 0, 255]), 'wall', { compression: 'BGRA8', mipmaps: 'all' });
        assert.deepEqual([normal.mipCount, colour.mipCount, colour.data.length], [1, 2, 8 * 8 * 4 + 4 * 4 * 4]);
        assert.equal(colour.data[8 * 8 * 4], 188); assert.equal((await encodeTexture(testImage(8, 8, (x, y) => (x + y) & 1 ? [255, 255, 255, 255] : [0, 0, 0, 255]), 'wall_n', { compression: 'BGRA8', mipmaps: 'all' })).data[8 * 8 * 4], 128);
    }],
    ['an image becomes a power-of-two texture with the encoding and levels its settings ask for', async () => {
        const opaque = testImage(1000, 500, (x, y) => [x & 255, y & 255, 0, 255]), clear = testImage(16, 16, (x) => [10, 20, 30, x * 16]);
        const automatic = await encodeTexture(opaque, 'sign', { compression: 'auto', mipmaps: 'auto' });
        assert.deepEqual([automatic.width, automatic.height, automatic.encoding, automatic.mipCount], [1024, 512, 'BC1', 8]);
        assert.equal(automatic.data.length, [0, 1, 2, 3, 4, 5, 6, 7].reduce((sum, mip) => sum + (1024 >> mip) * (512 >> mip) / 2, 0)); assert.match(automatic.notes.join(' '), /Resized from 1000 × 500 to 1024 × 512/);
        assert.equal((await encodeTexture(clear, 'decal', { compression: 'auto', mipmaps: 'auto' })).encoding, 'BC3');
        const upgraded = await encodeTexture(clear, 'decal', { compression: 'auto', mipmaps: 'auto' }, { encoding: 'BC1', mipCount: 3 });
        assert.equal(upgraded.encoding, 'BC3'); assert.match(upgraded.notes.join(' '), /transparency/);
        for (const [previous, kept] of [['BC7', 'BC7'], ['BC2', 'BC3'], ['BGRX8', 'BGRA8'], ['BC5', 'BC5'], ['RGBA8', 'RGBA8'], ['A8', 'A8']] as const) {
            assert.equal((await encodeTexture(clear, 'decal', { compression: 'auto', mipmaps: 'auto' }, { encoding: previous, mipCount: 2 })).encoding, kept, `a replaced ${previous} texture`);
        }
        assert.equal((await encodeTexture(clear, 'hud', { compression: 'auto', mipmaps: 'auto' }, { encoding: 'BC3', mipCount: 1 })).mipCount, 1, 'a texture stored without mip levels keeps one level');
        assert.equal((await encodeTexture(clear, 'hud', { compression: 'auto', mipmaps: 'all' }, { encoding: 'BC3', mipCount: 1 })).mipCount, 3);
        assert.equal((await encodeTexture(opaque, 'sign', { compression: 'BC7', mipmaps: 'none' })).mipCount, 1);
        const forced = await encodeTexture(clear, 'decal', { compression: 'BC1', mipmaps: 'auto' });
        assert.equal(forced.encoding, 'BC1'); assert.match(forced.notes.join(' '), /stored opaque/);
        const small = await encodeTexture(testImage(2, 2, () => [1, 2, 3, 255]), 'dot', { compression: 'auto', mipmaps: 'auto' });
        assert.deepEqual([small.encoding, small.mipCount, [...small.data.subarray(0, 4)]], ['BGRA8', 1, [3, 2, 1, 255]]); assert.match(small.notes.join(' '), /uncompressed/);
        let pauses = 0;
        await encodeTexture(testImage(64, 64, () => [1, 2, 3, 255]), 'paused', { compression: 'auto', mipmaps: 'auto' }, undefined, async () => { pauses++; });
        assert.ok(pauses >= 5, 'the caller is given a turn at every level');
        await assert.rejects(encodeTexture(testImage(64, 64, () => [1, 2, 3, 255]), 'stopped', { compression: 'auto', mipmaps: 'auto' }, undefined, async () => { throw new Error('cancelled'); }), /cancelled/);
    }],
    ['a dictionary written from images reads back with the same textures in both generations', async () => {
        for (const gen9 of [false, true]) {
            const images: [string, Image][] = [['Zebra_Diffuse', smooth(1)], ['alpha_decal', testImage(32, 16, (x, y) => [x * 8, y * 16, 99, x * 8])], ['tiny', testImage(4, 4, () => [9, 9, 9, 255])]];
            const built = await dictionary(gen9, images), file = await buildDictionary(built), parsed = await parseYtd(file);
            assertSound(file);
            assert.equal(file.readUInt32LE(4), gen9 ? 5 : 13); assert.equal(file.readUInt32LE(12) >>> 28, gen9 ? 5 : 13, 'the version is repeated in the flag words');
            const byHash = [...built.textures].sort((a, b) => a.hash - b.hash);
            assert.deepEqual(parsed.textures.map((texture) => [texture.name, texture.width, texture.height, texture.mipCount, texture.encoding]), byHash.map((texture) => [texture.name, texture.width, texture.height, texture.mipCount, texture.encoding]));
            assert.deepEqual(byHash.map((texture) => texture.encoding), [...built.textures].sort((a, b) => a.hash - b.hash).map((texture) => texture.name === 'alpha_decal' ? 'BC3' : 'BC1'));
            assert.ok(parsed.textures.every((texture) => texture.notes.length === 0 && texture.previewMip === 0));
            for (const [index, texture] of byHash.entries()) {
                let at = 0;
                for (let mip = 0; mip < texture.mipCount; mip++) { const level = textureMip(parsed, index, mip).data; assert.deepEqual(level, texture.data.subarray(at, at + level.length), `${texture.name} level ${mip}`); at += level.length; }
                assert.equal(at, texture.data.length);
            }
            const again = readDictionary(parsed);
            assert.equal(again.locked, undefined); assert.deepEqual(again.textures.map((texture) => [texture.name, texture.hash]), byHash.map((texture) => [texture.name, textureHash(texture.name)]));
            assert.deepEqual(await buildDictionary(again), file, 'reading and writing again changes nothing');
            if (gen9) {
                const { pages, blocks } = blocksOf(file), record = blocks.find((block) => block.what === 'record 0')!.from;
                assert.equal(pages.readUInt32LE(record + 0x08) * pages.readUInt32LE(record + 0x0c), byHash[0].data.length, 'block count times block size is the stored size');
                assert.equal(Number(pages.readBigUInt64LE(record + 0x30) & 0xfffffffn), record + 0x58, 'the resource view lives inside the record');
                assert.deepEqual([pages[record + 0x1e], pages[record + 0x20], pages.readUInt16LE(record + 0x68)], [1, 255, 0x41]);
            }
        }
        const empty = await buildDictionary({ gen9: false, textures: [] });
        assertSound(empty); assert.equal((await parseYtd(empty)).textures.length, 0);
    }],
    ['an existing dictionary keeps what the editor does not touch', async () => {
        for (const version of [13, 5] as const) {
            const original = syntheticYtd(version, true, (pages) => {
                pages.writeUInt32LE(0x40570fd0, 0); pages.writeUInt32LE(0x1234abcd, 0x80 + 0x40);
                pages.writeBigUInt64LE(0x50000060n, 0x20); pages.writeUInt16LE(1, 0x28); pages.writeUInt16LE(1, 0x2a); pages.writeUInt32LE(0x2a4c26d8, 0x60);
            });
            const read = readDictionary(await parseYtd(original)), gen9 = version === 5;
            assert.equal(read.locked, undefined); assert.equal(read.textures[0].hash, 0x2a4c26d8, 'the stored name hash is kept as it is');
            const added = storeTexture('second', await encodeTexture(smooth(5), 'second', { compression: 'BC7', mipmaps: 'auto' }), gen9);
            const file = await buildDictionary({ ...read, textures: [...read.textures, added] }), parsed = await parseYtd(file), { pages, blocks } = blocksOf(file);
            assertSound(file);
            assert.equal(pages.readUInt32LE(0), 0x40570fd0, 'the root keeps its first word');
            const kept = parsed.textures.findIndex((texture) => texture.name === 'test_diffuse'), record = blocks.find((block) => block.what === `record ${kept}`)!.from;
            assert.equal(pages.readUInt32LE(record + 0x40), 0x1234abcd, 'usage data of an untouched texture survives');
            assert.deepEqual(textureMip(parsed, kept, 0).data, RED_BC1);
            assert.deepEqual(parsed.textures.map((texture) => texture.encoding).sort(), ['BC1', 'BC7']);
            const replaced = storeTexture('test_diffuse', await encodeTexture(testImage(16, 16, (x) => [x * 16, 0, 0, 200]), 'test_diffuse', { compression: 'auto', mipmaps: 'auto' }, read.textures[0]), gen9, read.textures[0]);
            assert.equal(replaced.hash, 0x2a4c26d8); assert.equal(replaced.record.readUInt32LE(0x40), 0x1234abcd, 'a replacement inherits the record of the texture it replaces');
            const swapped = await parseYtd(await buildDictionary({ ...read, textures: [replaced] }));
            assert.deepEqual(swapped.textures.map((texture) => [texture.name, texture.width, texture.height, texture.mipCount, texture.encoding]), [['test_diffuse', 16, 16, 1, 'BC3']]);
        }
    }],
    ['names are checked, renaming moves a texture to its new hash and unsafe layouts stay read-only', async () => {
        const built = await dictionary(false, [['bravo', smooth(1)], ['alpha', smooth(2)]]);
        assert.equal(textureNameFromFile('My Livery (final) v2'), 'My_Livery_final_v2'); assert.equal(textureNameFromFile('  '), 'texture'); assert.equal(textureNameFromFile('a'.repeat(200)).length, 96);
        assert.match(textureNameProblem('has space', built.textures)!, /without spaces/); assert.match(textureNameProblem('x'.repeat(97), built.textures)!, /at most 96/);
        assert.match(textureNameProblem('ALPHA', built.textures)!, /already holds "alpha"/); assert.equal(textureNameProblem('charlie', built.textures), undefined);
        const renamed = { ...built, textures: [renameTexture(built.textures[0], 'zulu'), built.textures[1]] }, parsed = await parseYtd(await buildDictionary(renamed));
        assert.deepEqual(parsed.textures.map((texture) => texture.name), ['alpha', 'zulu'].sort((a, b) => textureHash(a) - textureHash(b)));
        await assert.rejects(buildDictionary({ ...built, textures: [built.textures[0], renameTexture(built.textures[1], 'BRAVO')] }), /share the name/);
        assert.equal(built.textures[0].data.length, 2728); assert.equal(textureMemory(built.textures), 0x2000, 'memory is counted in whole pages');
        const layered = readDictionary(await parseYtd(syntheticYtd(13, true, (pages) => pages.writeUInt16LE(6, 0x80 + 0x54))));
        assert.match(layered.locked!, /texture "test_diffuse"/); await assert.rejects(buildDictionary(layered), /cannot be rewritten/);
        const unknown = readDictionary(await parseYtd(syntheticYtd(13, true, (pages) => { pages.writeUInt32LE(25, 0x80 + 0x58); pages.writeUInt16LE(8, 0x80 + 0x56); })));
        assert.equal(unknown.locked, undefined, 'a format without a preview is still copied by its row size'); assert.equal(unknown.textures[0].data.length, 32);
        const shortened = readDictionary(await parseYtd(syntheticYtd(13, true, (pages) => { pages[0x80 + 0x5d] = 3; pages.writeBigUInt64LE(0x600001f0n, 0x80 + 0x70); RED_BC1.copy(pages, 512 + 0x1f0); RED_BC1.copy(pages, 512 + 0x1f8); })));
        assert.deepEqual(shortened.textures[0].data, Buffer.concat([RED_BC1, RED_BC1, Buffer.alloc(8)]), 'levels a file leaves out come back as zeros');
    }],
    ['large and numerous textures stay inside the page limits of a resource', async () => {
        const large = await dictionary(false, [['billboard', testImage(2048, 2048, (x, y) => [x & 255, y & 255, (x ^ y) & 255, (x + y) & 255])], ['icon', smooth(4)]]);
        const file = await buildDictionary(large), parsed = await parseYtd(file);
        assertSound(file);
        assert.deepEqual(parsed.textures.map((texture) => [texture.name, texture.width, texture.mipCount, texture.encoding]).sort(), [['billboard', 2048, 10, 'BC3'], ['icon', 64, 5, 'BC1']]);
        const random = noise(99), many: StoredDictionary = { gen9: true, textures: [] };
        for (let index = 0; index < 700; index++) {
            const side = 4 << Math.floor(random() * 5), tall = 4 << Math.floor(random() * 5);
            many.textures.push(storeTexture(`texture_${index}`, await encodeTexture(testImage(side, tall, () => [index & 255, index >> 8, 7, 255]), 'x', { compression: index % 3 ? 'auto' : 'BGRA8', mipmaps: 'auto' }), true));
        }
        const crowded = await buildDictionary(many);
        assertSound(crowded); assert.equal((await parseYtd(crowded)).textures.length, 700);
        many.textures.push(...Array.from({ length: 1349 }, (_, index) => renameTexture(many.textures[0], `more_${index}`)));
        await assert.rejects(buildDictionary(many), /at most 2,048 textures/);
    }],
];
export async function runTextureEditTests(): Promise<void> {
    const failures: string[] = [];
    for (const [name, body] of tests) {
        try { await body(); console.log(`  ok   ${name}`); }
        catch (error) { failures.push(name); console.error(`  FAIL ${name}\n${error instanceof Error ? error.stack : String(error)}`); }
    }
    if (failures.length) { throw new Error(`${failures.length} texture editing test(s) failed: ${failures.join(', ')}`); }
}
