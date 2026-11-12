import { textureLevelSize } from './assetFormats';
import type { TextureEncoding } from './assetTypes';
import { MAX_IMAGE_SIDE, type Image } from './pngCodec';

export type Compression = 'auto' | 'BC1' | 'BC3' | 'BC7' | 'BGRA8';
export type Mipmaps = 'auto' | 'all' | 'none';
export interface EncodeOptions { compression: Compression; mipmaps: Mipmaps }
export interface EncodedTexture { width: number; height: number; mipCount: number; encoding: TextureEncoding; data: Buffer; notes: string[] }
export type TextureKind = 'colour' | 'data';
export const COMPRESSIONS: readonly Compression[] = ['auto', 'BC1', 'BC3', 'BC7', 'BGRA8'];
export const MIPMAPS: readonly Mipmaps[] = ['auto', 'all', 'none'];
export const WRITABLE: readonly TextureEncoding[] = ['BC1', 'BC3', 'BC4', 'BC5', 'BC7', 'BGRA8', 'RGBA8', 'A8', 'R8'];

const TO_LINEAR = new Float32Array(256).map((_, value) => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
const FROM_LINEAR = new Uint8Array(65537).map((_, index) => { const c = index / 65536; return Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)); });
function fromLinear(value: number): number { return FROM_LINEAR[Math.min(65536, Math.max(0, Math.round(value * 65536)))]; }

/** Normal, specular and single-channel maps hold numbers, not colours, so they are averaged as stored. */
export function textureKind(name: string, encoding: TextureEncoding): TextureKind {
    return encoding === 'BC4' || encoding === 'BC5' || encoding === 'R8' || encoding === 'A8' || /_(n|nm|nrm|normal|bump|s|spec|specular)$/i.test(name) ? 'data' : 'colour';
}
/** Levels stop at four pixels, the smallest size a compressed block describes exactly. */
export function mipLevels(width: number, height: number): number {
    let levels = 1;
    while (Math.min(width, height) >> levels >= 4) { levels++; }
    return levels;
}
function powerOfTwo(value: number): number { return Math.min(MAX_IMAGE_SIDE, 2 ** Math.round(Math.log2(value))); }

function plan(from: number, to: number): { size: number; start: Int32Array; weights: Float32Array } {
    const scale = from / to, size = to < from ? Math.ceil(scale) + 1 : 2, start = new Int32Array(to), weights = new Float32Array(to * size);
    for (let index = 0; index < to; index++) {
        if (to < from) {
            const low = index * scale, high = low + scale;
            start[index] = Math.floor(low);
            for (let tap = 0; tap < size; tap++) { const at = start[index] + tap; weights[index * size + tap] = Math.max(0, Math.min(at + 1, high) - Math.max(at, low)) / scale; }
        } else {
            const centre = (index + 0.5) * scale - 0.5, base = Math.floor(centre);
            start[index] = base; weights[index * size] = 1 - (centre - base); weights[index * size + 1] = centre - base;
        }
    }
    return { size, start, weights };
}
function resampleAxis(source: Uint8Array, target: Uint8Array, lines: number, from: number, to: number, line: number, pixel: number, targetLine: number, targetPixel: number, kind: TextureKind): void {
    const { size, start, weights } = plan(from, to), colour = kind === 'colour';
    for (let index = 0; index < lines; index++) {
        const read = index * line, write = index * targetLine;
        for (let output = 0; output < to; output++) {
            let red = 0, green = 0, blue = 0, alpha = 0, plainRed = 0, plainGreen = 0, plainBlue = 0;
            for (let tap = 0; tap < size; tap++) {
                const weight = weights[output * size + tap];
                if (!weight) { continue; }
                const at = read + Math.min(from - 1, Math.max(0, start[output] + tap)) * pixel;
                if (colour) {
                    const coverage = source[at + 3] * weight, r = TO_LINEAR[source[at]], g = TO_LINEAR[source[at + 1]], b = TO_LINEAR[source[at + 2]];
                    red += r * coverage; green += g * coverage; blue += b * coverage; alpha += coverage;
                    plainRed += r * weight; plainGreen += g * weight; plainBlue += b * weight;
                } else { red += source[at] * weight; green += source[at + 1] * weight; blue += source[at + 2] * weight; alpha += source[at + 3] * weight; }
            }
            const to4 = write + output * targetPixel;
            if (colour) {
                // Colour is weighted by opacity so that hidden pixels do not darken the edges of what is visible.
                target[to4] = fromLinear(alpha > 0 ? red / alpha : plainRed); target[to4 + 1] = fromLinear(alpha > 0 ? green / alpha : plainGreen);
                target[to4 + 2] = fromLinear(alpha > 0 ? blue / alpha : plainBlue);
            } else { target[to4] = Math.round(red); target[to4 + 1] = Math.round(green); target[to4 + 2] = Math.round(blue); }
            target[to4 + 3] = Math.min(255, Math.round(alpha));
        }
    }
}
export function resize(image: Image, width: number, height: number, kind: TextureKind): Image {
    if (width === image.width && height === image.height) { return image; }
    let wide = image.rgba;
    if (width !== image.width) {
        wide = new Uint8Array(width * image.height * 4);
        resampleAxis(image.rgba, wide, image.height, image.width, width, image.width * 4, 4, width * 4, 4, kind);
    }
    if (height === image.height) { return { width, height, rgba: wide }; }
    const rgba = new Uint8Array(width * height * 4);
    resampleAxis(wide, rgba, width, image.height, height, 4, width * 4, 4, width * 4, kind);
    return { width, height, rgba };
}

const EXPAND5 = new Uint8Array(32).map((_, value) => (value << 3) | (value >> 2)), EXPAND6 = new Uint8Array(64).map((_, value) => (value << 2) | (value >> 4));
/** For every 8-bit value, the endpoint pair whose two-thirds blend lands closest to it. */
function matches(expand: Uint8Array): Uint8Array {
    const table = new Uint8Array(512);
    for (let value = 0; value < 256; value++) {
        let best = Infinity;
        for (let low = 0; low < expand.length; low++) {
            for (let high = 0; high < expand.length; high++) {
                const error = Math.abs(Math.floor((2 * expand[high] + expand[low]) / 3) - value) * 100 + Math.abs(expand[high] - expand[low]) * 3;
                if (error < best) { best = error; table[value * 2] = high; table[value * 2 + 1] = low; }
            }
        }
    }
    return table;
}
const MATCH5 = matches(EXPAND5), MATCH6 = matches(EXPAND6);
const block = new Uint8Array(64), mask = new Uint8Array(16), palette = new Int32Array(12), picks = new Uint8Array(16);
const LEFT = [3, 0, 2, 1];

function loadBlock(image: Image, x: number, y: number): void {
    for (let row = 0; row < 4; row++) {
        for (let column = 0; column < 4; column++) {
            const from = (Math.min(y + row, image.height - 1) * image.width + Math.min(x + column, image.width - 1)) * 4, to = (row * 4 + column) * 4;
            block[to] = image.rgba[from]; block[to + 1] = image.rgba[from + 1]; block[to + 2] = image.rgba[from + 2]; block[to + 3] = image.rgba[from + 3];
        }
    }
}
function pack(red: number, green: number, blue: number): number { return (Math.floor((red * 31 + 127) / 255) << 11) | (Math.floor((green * 63 + 127) / 255) << 5) | Math.floor((blue * 31 + 127) / 255); }
function clamp(value: number): number { return value < 0 ? 0 : value > 255 ? 255 : value; }
/** Fills `picks` with the nearest of the four colours two endpoints give and returns them as index bits. */
function choose(first: number, second: number): number {
    const red = EXPAND5[first >> 11], green = EXPAND6[(first >> 5) & 63], blue = EXPAND5[first & 31], otherRed = EXPAND5[second >> 11], otherGreen = EXPAND6[(second >> 5) & 63], otherBlue = EXPAND5[second & 31];
    for (let entry = 0; entry < 4; entry++) {
        const a = LEFT[entry], b = 3 - a;
        palette[entry * 3] = Math.floor((a * red + b * otherRed) / 3); palette[entry * 3 + 1] = Math.floor((a * green + b * otherGreen) / 3); palette[entry * 3 + 2] = Math.floor((a * blue + b * otherBlue) / 3);
    }
    let bits = 0;
    for (let pixel = 0; pixel < 16; pixel++) {
        let best = Infinity, pick = 0;
        for (let entry = 0; entry < 4; entry++) {
            const red = block[pixel * 4] - palette[entry * 3], green = block[pixel * 4 + 1] - palette[entry * 3 + 1], blue = block[pixel * 4 + 2] - palette[entry * 3 + 2];
            const error = red * red + green * green + blue * blue;
            if (error < best) { best = error; pick = entry; }
        }
        picks[pixel] = pick; bits |= pick << (pixel * 2);
    }
    return bits >>> 0;
}
function solidBlock(out: Buffer, at: number, red: number, green: number, blue: number): void {
    const first = (MATCH5[red * 2] << 11) | (MATCH6[green * 2] << 5) | MATCH5[blue * 2], second = (MATCH5[red * 2 + 1] << 11) | (MATCH6[green * 2 + 1] << 5) | MATCH5[blue * 2 + 1];
    out.writeUInt16LE(first, at); out.writeUInt16LE(second, at + 2); out.writeUInt32LE(first === second ? 0 : 0xaaaaaaaa, at + 4);
}
/** Writes the eight-byte colour block shared by BC1 and BC3; pixels outside `mask` do not steer the fit. */
function colourBlock(out: Buffer, at: number): void {
    let count = 0, red = 0, green = 0, blue = 0, lowRed = 255, lowGreen = 255, lowBlue = 255, highRed = 0, highGreen = 0, highBlue = 0;
    for (let pixel = 0; pixel < 16; pixel++) {
        if (!mask[pixel]) { continue; }
        const r = block[pixel * 4], g = block[pixel * 4 + 1], b = block[pixel * 4 + 2];
        count++; red += r; green += g; blue += b;
        if (r < lowRed) { lowRed = r; } if (r > highRed) { highRed = r; } if (g < lowGreen) { lowGreen = g; } if (g > highGreen) { highGreen = g; } if (b < lowBlue) { lowBlue = b; } if (b > highBlue) { highBlue = b; }
    }
    if (lowRed === highRed && lowGreen === highGreen && lowBlue === highBlue) { solidBlock(out, at, lowRed, lowGreen, lowBlue); return; }
    red /= count; green /= count; blue /= count;
    let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
    for (let pixel = 0; pixel < 16; pixel++) {
        if (!mask[pixel]) { continue; }
        const r = block[pixel * 4] - red, g = block[pixel * 4 + 1] - green, b = block[pixel * 4 + 2] - blue;
        xx += r * r; xy += r * g; xz += r * b; yy += g * g; yz += g * b; zz += b * b;
    }
    let axisRed = highRed - lowRed, axisGreen = highGreen - lowGreen, axisBlue = highBlue - lowBlue;
    for (let pass = 0; pass < 4; pass++) {
        const r = axisRed * xx + axisGreen * xy + axisBlue * xz, g = axisRed * xy + axisGreen * yy + axisBlue * yz, b = axisRed * xz + axisGreen * yz + axisBlue * zz;
        const length = Math.max(Math.abs(r), Math.abs(g), Math.abs(b));
        if (length < 1e-6) { break; }
        axisRed = r / length; axisGreen = g / length; axisBlue = b / length;
    }
    let low = Infinity, high = -Infinity, lowPixel = 0, highPixel = 0;
    for (let pixel = 0; pixel < 16; pixel++) {
        if (!mask[pixel]) { continue; }
        const along = block[pixel * 4] * axisRed + block[pixel * 4 + 1] * axisGreen + block[pixel * 4 + 2] * axisBlue;
        if (along < low) { low = along; lowPixel = pixel; } if (along > high) { high = along; highPixel = pixel; }
    }
    let first = pack(block[highPixel * 4], block[highPixel * 4 + 1], block[highPixel * 4 + 2]), second = pack(block[lowPixel * 4], block[lowPixel * 4 + 1], block[lowPixel * 4 + 2]);
    let bits = choose(first, second);
    for (let pass = 0; pass < 2; pass++) {
        let aa = 0, ab = 0, bb = 0, firstRed = 0, firstGreen = 0, firstBlue = 0, secondRed = 0, secondGreen = 0, secondBlue = 0;
        for (let pixel = 0; pixel < 16; pixel++) {
            if (!mask[pixel]) { continue; }
            const a = LEFT[picks[pixel]], b = 3 - a, r = block[pixel * 4], g = block[pixel * 4 + 1], bl = block[pixel * 4 + 2];
            aa += a * a; ab += a * b; bb += b * b;
            firstRed += a * r; firstGreen += a * g; firstBlue += a * bl; secondRed += b * r; secondGreen += b * g; secondBlue += b * bl;
        }
        const determinant = aa * bb - ab * ab;
        if (!determinant) { break; }
        const factor = 3 / determinant;
        const nextFirst = pack(clamp((firstRed * bb - secondRed * ab) * factor), clamp((firstGreen * bb - secondGreen * ab) * factor), clamp((firstBlue * bb - secondBlue * ab) * factor));
        const nextSecond = pack(clamp((secondRed * aa - firstRed * ab) * factor), clamp((secondGreen * aa - firstGreen * ab) * factor), clamp((secondBlue * aa - firstBlue * ab) * factor));
        if (nextFirst === first && nextSecond === second) { break; }
        first = nextFirst; second = nextSecond; bits = choose(first, second);
    }
    if (first === second) { solidBlock(out, at, Math.round(red), Math.round(green), Math.round(blue)); return; }
    // The four-colour mode needs the larger endpoint first; swapping endpoints flips the low bit of every index.
    if (first < second) { [first, second] = [second, first]; bits = (bits ^ 0x55555555) >>> 0; }
    out.writeUInt16LE(first, at); out.writeUInt16LE(second, at + 2); out.writeUInt32LE(bits, at + 4);
}
/** Writes the eight-byte single-channel block of BC4, BC5 and the alpha half of BC3. */
function channelBlock(out: Buffer, at: number, channel: number): void {
    let low = 255, high = 0;
    for (let pixel = 0; pixel < 16; pixel++) { const value = block[pixel * 4 + channel]; if (value < low) { low = value; } if (value > high) { high = value; } }
    out[at] = high; out[at + 1] = low; out.fill(0, at + 2, at + 8);
    if (high === low) { return; }
    for (let half = 0; half < 2; half++) {
        let bits = 0;
        for (let pixel = 0; pixel < 8; pixel++) {
            const step = Math.round((high - block[(half * 8 + pixel) * 4 + channel]) * 7 / (high - low));
            bits |= (step === 0 ? 0 : step === 7 ? 1 : step + 1) << (pixel * 3);
        }
        out.writeUIntLE(bits, at + 2 + half * 3, 3);
    }
}

const WEIGHTS = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];
const ends = new Float64Array(8), fitted = new Float64Array(8), quantised = new Uint8Array(8), bestQuantised = new Uint8Array(8), bestPicks = new Uint8Array(16), bit = new Uint8Array(2), bestBit = new Uint8Array(2);
const mean = new Float64Array(4), lowest = new Float64Array(4), highest = new Float64Array(4), covariance = new Float64Array(16), axis = new Float64Array(4), next = new Float64Array(4);
let cursor = 0;
function writeBits(out: Buffer, at: number, value: number, bits: number): void {
    for (let index = 0; index < bits; index++, cursor++) { if ((value >> index) & 1) { out[at + (cursor >> 3)] |= 1 << (cursor & 7); } }
}
/** Rounds both endpoints to seven bits plus the shared low bit, fills `picks` and returns the squared error. */
function settle(source: Float64Array, opaque: boolean, clear: boolean): number {
    for (let end = 0; end < 2; end++) {
        let best = Infinity;
        for (let low = opaque ? 1 : 0; low <= (clear ? 0 : 1); low++) {
            let error = 0;
            for (let channel = 0; channel < 4; channel++) { const value = Math.min(127, Math.max(0, Math.round((source[end * 4 + channel] - low) / 2))) * 2 + low; error += (value - source[end * 4 + channel]) ** 2; }
            if (error < best) { best = error; bit[end] = low; }
        }
        for (let channel = 0; channel < 4; channel++) { quantised[end * 4 + channel] = Math.min(127, Math.max(0, Math.round((source[end * 4 + channel] - bit[end]) / 2))) * 2 + bit[end]; }
    }
    let length = 0, total = 0;
    for (let channel = 0; channel < 4; channel++) { length += (quantised[4 + channel] - quantised[channel]) ** 2; }
    for (let pixel = 0; pixel < 16; pixel++) {
        let along = 0;
        for (let channel = 0; channel < 4; channel++) { along += (block[pixel * 4 + channel] - quantised[channel]) * (quantised[4 + channel] - quantised[channel]); }
        const pick = length ? Math.min(15, Math.max(0, Math.round(along / length * 15))) : 0;
        picks[pixel] = pick;
        for (let channel = 0; channel < 4; channel++) { total += ((((64 - WEIGHTS[pick]) * quantised[channel] + WEIGHTS[pick] * quantised[4 + channel] + 32) >> 6) - block[pixel * 4 + channel]) ** 2; }
    }
    return total;
}
/** Writes a BC7 block in mode 6: one colour line with alpha, sixteen steps along it. */
function modeSixBlock(out: Buffer, at: number): void {
    const low = lowest, high = highest;
    mean.fill(0); low.fill(255); high.fill(0); covariance.fill(0);
    for (let pixel = 0; pixel < 16; pixel++) {
        for (let channel = 0; channel < 4; channel++) { const value = block[pixel * 4 + channel]; mean[channel] += value / 16; if (value < low[channel]) { low[channel] = value; } if (value > high[channel]) { high[channel] = value; } }
    }
    for (let pixel = 0; pixel < 16; pixel++) {
        for (let row = 0; row < 4; row++) { for (let column = 0; column < 4; column++) { covariance[row * 4 + column] += (block[pixel * 4 + row] - mean[row]) * (block[pixel * 4 + column] - mean[column]); } }
    }
    for (let channel = 0; channel < 4; channel++) { axis[channel] = high[channel] - low[channel]; }
    for (let pass = 0; pass < 6; pass++) {
        let length = 0;
        for (let row = 0; row < 4; row++) { next[row] = 0; for (let column = 0; column < 4; column++) { next[row] += covariance[row * 4 + column] * axis[column]; } length = Math.max(length, Math.abs(next[row])); }
        if (length < 1e-6) { break; }
        for (let channel = 0; channel < 4; channel++) { axis[channel] = next[channel] / length; }
    }
    const span = Math.hypot(axis[0], axis[1], axis[2], axis[3]) || 1;
    let near = Infinity, far = -Infinity;
    for (let pixel = 0; pixel < 16; pixel++) {
        let along = 0;
        for (let channel = 0; channel < 4; channel++) { along += (block[pixel * 4 + channel] - mean[channel]) * axis[channel] / span; }
        if (along < near) { near = along; } if (along > far) { far = along; }
    }
    for (let channel = 0; channel < 4; channel++) { ends[channel] = clamp(mean[channel] + axis[channel] / span * near); ends[4 + channel] = clamp(mean[channel] + axis[channel] / span * far); }
    const opaque = low[3] === 255, clear = high[3] === 0;
    let error = settle(ends, opaque, clear);
    bestQuantised.set(quantised); bestPicks.set(picks); bestBit.set(bit);
    let aa = 0, ab = 0, bb = 0;
    fitted.fill(0);
    for (let pixel = 0; pixel < 16; pixel++) {
        const b = WEIGHTS[picks[pixel]] / 64, a = 1 - b;
        aa += a * a; ab += a * b; bb += b * b;
        for (let channel = 0; channel < 4; channel++) { fitted[channel] += a * block[pixel * 4 + channel]; fitted[4 + channel] += b * block[pixel * 4 + channel]; }
    }
    const determinant = aa * bb - ab * ab;
    if (Math.abs(determinant) > 1e-9) {
        for (let channel = 0; channel < 4; channel++) {
            const first = fitted[channel], second = fitted[4 + channel];
            fitted[channel] = clamp((first * bb - second * ab) / determinant); fitted[4 + channel] = clamp((second * aa - first * ab) / determinant);
        }
        const refined = settle(fitted, opaque, clear);
        if (refined < error) { error = refined; bestQuantised.set(quantised); bestPicks.set(picks); bestBit.set(bit); }
    }
    // The first index is stored without its top bit, so the endpoints are ordered to keep it in the lower half.
    const flip = bestPicks[0] > 7;
    cursor = 0; out.fill(0, at, at + 16); writeBits(out, at, 0x40, 7);
    for (let channel = 0; channel < 4; channel++) { writeBits(out, at, bestQuantised[(flip ? 4 : 0) + channel] >> 1, 7); writeBits(out, at, bestQuantised[(flip ? 0 : 4) + channel] >> 1, 7); }
    writeBits(out, at, bestBit[flip ? 1 : 0], 1); writeBits(out, at, bestBit[flip ? 0 : 1], 1);
    for (let pixel = 0; pixel < 16; pixel++) { writeBits(out, at, flip ? 15 - bestPicks[pixel] : bestPicks[pixel], pixel ? 4 : 3); }
}

/** One mip level in `encoding`; `pause` lets the caller stay responsive and cancel between rows of blocks. */
export async function encodeLevel(image: Image, encoding: TextureEncoding, pause: () => Promise<void> = async () => undefined): Promise<Buffer> {
    const { width, height, rgba } = image, out = Buffer.alloc(textureLevelSize(width, height, encoding));
    if (!encoding.startsWith('BC')) {
        for (let pixel = 0; pixel < width * height; pixel++) {
            const from = pixel * 4;
            if (encoding === 'A8' || encoding === 'R8') { out[pixel] = rgba[from + (encoding === 'A8' ? 3 : 0)]; continue; }
            out[from] = rgba[from + (encoding === 'RGBA8' ? 0 : 2)]; out[from + 1] = rgba[from + 1]; out[from + 2] = rgba[from + (encoding === 'RGBA8' ? 2 : 0)]; out[from + 3] = rgba[from + 3];
        }
        return out;
    }
    const size = encoding === 'BC1' || encoding === 'BC4' ? 8 : 16;
    let at = 0, paused = Date.now();
    for (let y = 0; y < height; y += 4) {
        if (Date.now() - paused > 12) { await pause(); paused = Date.now(); }
        for (let x = 0; x < width; x += 4, at += size) {
            loadBlock(image, x, y);
            if (encoding === 'BC7') { modeSixBlock(out, at); continue; }
            if (encoding === 'BC4') { channelBlock(out, at, 0); continue; }
            if (encoding === 'BC5') { channelBlock(out, at, 0); channelBlock(out, at + 8, 1); continue; }
            let visible = 0;
            for (let pixel = 0; pixel < 16; pixel++) { mask[pixel] = encoding === 'BC1' || block[pixel * 4 + 3] ? 1 : 0; visible += mask[pixel]; }
            if (!visible) { mask.fill(1); }
            if (encoding === 'BC3') { channelBlock(out, at, 3); colourBlock(out, at + 8); } else { colourBlock(out, at); }
        }
    }
    return out;
}

/**
 * Turns an image into a stored texture: power-of-two size, mip levels and the chosen encoding.
 * `previous` is the texture being replaced, whose encoding and single-level choice the automatic settings keep.
 */
export async function encodeTexture(image: Image, name: string, options: EncodeOptions, previous?: { encoding?: TextureEncoding; mipCount: number }, pause?: () => Promise<void>): Promise<EncodedTexture> {
    const notes: string[] = [], rgba = image.rgba;
    let opaque = true;
    for (let at = 3; at < rgba.length && opaque; at += 4) { opaque = rgba[at] === 255; }
    const width = powerOfTwo(image.width), height = powerOfTwo(image.height);
    let encoding: TextureEncoding = options.compression !== 'auto' ? options.compression : opaque ? 'BC1' : 'BC3';
    if (options.compression === 'auto' && previous?.encoding) {
        const kept = previous.encoding === 'BC2' ? 'BC3' : previous.encoding === 'BGRX8' ? 'BGRA8' : previous.encoding;
        if (kept === 'BC1' && !opaque) { encoding = 'BC3'; notes.push('Stored as BC3 (DXT5): the image has transparency, which the replaced BC1 (DXT1) texture could not hold.'); }
        else if (WRITABLE.includes(kept)) { encoding = kept; }
    } else if (encoding === 'BC1' && !opaque) { notes.push('BC1 (DXT1) holds no transparency, so the image was stored opaque.'); }
    if (encoding.startsWith('BC') && Math.min(width, height) < 4) { encoding = 'BGRA8'; notes.push('Stored uncompressed: compressed blocks need at least four pixels each way.'); }
    const kind = textureKind(name, encoding);
    if (width !== image.width || height !== image.height) { notes.push(`Resized from ${image.width} × ${image.height} to ${width} × ${height}: texture sizes are powers of two.`); }
    const mipCount = options.mipmaps === 'none' || (options.mipmaps === 'auto' && previous?.mipCount === 1) ? 1 : mipLevels(width, height);
    const levels: Buffer[] = [];
    let level = resize(image, width, height, kind);
    for (let mip = 0; mip < mipCount; mip++) {
        if (mip) { level = resize(level, level.width >> 1, level.height >> 1, kind); }
        await pause?.();
        levels.push(await encodeLevel(level, encoding, pause));
    }
    return { width, height, mipCount, encoding, data: Buffer.concat(levels), notes };
}
