import { deflateSync, inflateSync } from 'node:zlib';

export interface Image { width: number; height: number; rgba: Uint8Array }
export const MAX_IMAGE_SIDE = 4096;

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const PASSES = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] as const;
const CRC = new Uint32Array(256).map((_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++) { value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; }
    return value >>> 0;
});
function crc(...parts: Uint8Array[]): number {
    let value = 0xffffffff;
    for (const part of parts) { for (let index = 0; index < part.length; index++) { value = CRC[(value ^ part[index]) & 0xff] ^ (value >>> 8); } }
    return (value ^ 0xffffffff) >>> 0;
}
function paeth(left: number, up: number, corner: number): number {
    const estimate = left + up - corner, a = Math.abs(estimate - left), b = Math.abs(estimate - up), c = Math.abs(estimate - corner);
    return a <= b && a <= c ? left : b <= c ? up : corner;
}
function unfilter(raw: Buffer, at: number, rows: number, rowBytes: number, step: number): void {
    for (let row = 0; row < rows; row++) {
        const filter = raw[at], line = at + 1, prior = row ? line - rowBytes - 1 : -1;
        if (filter > 4) { throw new Error('The PNG image uses an unknown row filter.'); }
        for (let index = 0; index < rowBytes; index++) {
            const left = index >= step ? raw[line + index - step] : 0, up = prior < 0 ? 0 : raw[prior + index], corner = prior < 0 || index < step ? 0 : raw[prior + index - step];
            const predicted = filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : filter === 4 ? paeth(left, up, corner) : 0;
            raw[line + index] = (raw[line + index] + predicted) & 0xff;
        }
        at += rowBytes + 1;
    }
}

/** Decodes any standard PNG to 8-bit RGBA; 16-bit samples keep their high byte. */
export function decodePng(data: Buffer): Image {
    if (data.length < 8 || !data.subarray(0, 8).equals(SIGNATURE)) { throw new Error('This file is not a PNG image.'); }
    let width = 0, height = 0, depth = 0, colour = -1, interlaced = false, palette: Buffer | undefined, transparency: Buffer | undefined, ended = false;
    const parts: Buffer[] = [];
    for (let at = 8; at + 12 <= data.length && !ended;) {
        const length = data.readUInt32BE(at), type = data.toString('latin1', at + 4, at + 8), body = at + 8;
        if (length > data.length - body - 4) { throw new Error('The PNG image is truncated.'); }
        const chunk = data.subarray(body, body + length);
        if (type === 'IHDR') {
            if (length !== 13 || chunk[10] || chunk[11] || chunk[12] > 1) { throw new Error('The PNG header is invalid.'); }
            width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4); depth = chunk[8]; colour = chunk[9]; interlaced = chunk[12] === 1;
        } else if (type === 'PLTE') { palette = chunk; }
        else if (type === 'tRNS') { transparency = chunk; }
        else if (type === 'IDAT') { parts.push(chunk); }
        else if (type === 'IEND') { ended = true; }
        at = body + length + 4;
    }
    if (!DEPTHS[colour]?.includes(depth) || width < 1 || height < 1) { throw new Error('The PNG header is invalid.'); }
    if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) {
        throw new Error(`The image is ${width} × ${height}; the largest supported texture is ${MAX_IMAGE_SIDE} × ${MAX_IMAGE_SIDE}. Scale it down first.`);
    }
    if (colour === 3 && (!palette || palette.length < 3)) { throw new Error('The PNG image has no palette.'); }
    const channels = CHANNELS[colour], bits = channels * depth, step = Math.max(1, bits >> 3);
    const passes = (interlaced ? PASSES : [[0, 0, 1, 1] as const]).map(([x, y, dx, dy]) => ({ x, y, dx, dy, columns: Math.ceil((width - x) / dx), rows: Math.ceil((height - y) / dy) }))
        .filter((pass) => pass.columns > 0 && pass.rows > 0);
    const expected = passes.reduce((sum, pass) => sum + pass.rows * (1 + Math.ceil(pass.columns * bits / 8)), 0);
    let raw: Buffer;
    try { raw = inflateSync(Buffer.concat(parts), { maxOutputLength: expected + 1 }); }
    catch { throw new Error('The PNG image data is corrupt.'); }
    if (raw.length < expected) { throw new Error('The PNG image data is truncated.'); }
    const rgba = new Uint8Array(width * height * 4), scale = depth < 8 ? 255 / ((1 << depth) - 1) : 1;
    const key = transparency && colour === 0 && transparency.length >= 2 ? transparency.readUInt16BE(0)
        : transparency && colour === 2 && transparency.length >= 6 ? [transparency.readUInt16BE(0), transparency.readUInt16BE(2), transparency.readUInt16BE(4)] : undefined;
    let at = 0;
    for (const pass of passes) {
        const rowBytes = Math.ceil(pass.columns * bits / 8);
        unfilter(raw, at, pass.rows, rowBytes, step);
        for (let row = 0; row < pass.rows; row++) {
            const line = at + 1 + row * (rowBytes + 1);
            const sample = (index: number): number => depth === 8 ? raw[line + index] : depth === 16 ? raw.readUInt16BE(line + index * 2)
                : (raw[line + ((index * depth) >> 3)] >> (8 - depth - ((index * depth) & 7))) & ((1 << depth) - 1);
            const byte = (value: number): number => depth === 16 ? value >> 8 : depth === 8 ? value : Math.round(value * scale);
            for (let column = 0; column < pass.columns; column++) {
                const to = ((pass.y + row * pass.dy) * width + pass.x + column * pass.dx) * 4, first = column * channels;
                if (colour === 3) {
                    const entry = sample(column);
                    if (entry * 3 + 2 >= palette!.length) { throw new Error('The PNG image refers to a colour outside its palette.'); }
                    rgba[to] = palette![entry * 3]; rgba[to + 1] = palette![entry * 3 + 1]; rgba[to + 2] = palette![entry * 3 + 2];
                    rgba[to + 3] = transparency && entry < transparency.length ? transparency[entry] : 255;
                } else if (colour === 0 || colour === 4) {
                    const grey = sample(first);
                    rgba[to] = rgba[to + 1] = rgba[to + 2] = byte(grey);
                    rgba[to + 3] = colour === 4 ? byte(sample(first + 1)) : grey === key ? 0 : 255;
                } else {
                    const red = sample(first), green = sample(first + 1), blue = sample(first + 2);
                    rgba[to] = byte(red); rgba[to + 1] = byte(green); rgba[to + 2] = byte(blue);
                    rgba[to + 3] = colour === 6 ? byte(sample(first + 3)) : Array.isArray(key) && red === key[0] && green === key[1] && blue === key[2] ? 0 : 255;
                }
            }
        }
        at += pass.rows * (rowBytes + 1);
    }
    return { width, height, rgba };
}

function chunk(type: string, body: Buffer): Buffer {
    const head = Buffer.alloc(8), tail = Buffer.alloc(4);
    head.writeUInt32BE(body.length, 0); head.write(type, 4, 'latin1');
    tail.writeUInt32BE(crc(head.subarray(4), body), 0);
    return Buffer.concat([head, body, tail]);
}
/** Writes 8-bit RGBA, choosing per row the filter with the smallest residual. */
export function encodePng(image: Image): Buffer {
    const { width, height, rgba } = image, rowBytes = width * 4, raw = Buffer.alloc((rowBytes + 1) * height), trial = new Uint8Array(rowBytes);
    for (let row = 0; row < height; row++) {
        const line = row * rowBytes, out = row * (rowBytes + 1);
        let best = Infinity;
        for (const filter of [0, 1, 2, 4]) {
            let cost = 0;
            for (let index = 0; index < rowBytes; index++) {
                const left = index >= 4 ? rgba[line + index - 4] : 0, up = row ? rgba[line + index - rowBytes] : 0, corner = row && index >= 4 ? rgba[line + index - rowBytes - 4] : 0;
                const value = (rgba[line + index] - (filter === 1 ? left : filter === 2 ? up : filter === 4 ? paeth(left, up, corner) : 0)) & 0xff;
                trial[index] = value; cost += value < 128 ? value : 256 - value;
            }
            if (cost < best) { best = cost; raw[out] = filter; raw.set(trial, out + 1); }
        }
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
    return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
