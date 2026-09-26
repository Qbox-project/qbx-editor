import { decodeBC1, decodeBC2, decodeBC3, decodeBC4, decodeBC5, decodeBC7 } from '@bis-toolkit/bcn';
import type { TextureEncoding } from './assetTypes.js';

/** Validate independently at the browser boundary before the decoder can allocate RGBA memory. */
export function decodeAssetTexture(data: Uint8Array, width: number, height: number, encoding: TextureEncoding): Uint8Array {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 1024 * 1024) {
        throw new Error('Texture preview dimensions exceed the one-megapixel limit.');
    }
    const formats: TextureEncoding[] = ['BC1', 'BC2', 'BC3', 'BC4', 'BC5', 'BC7', 'RGBA8', 'BGRA8', 'BGRX8', 'R8', 'A8'];
    if (!formats.includes(encoding)) { throw new Error('Unsupported preview encoding.'); }
    const expected = encoding.startsWith('BC') ? Math.ceil(width / 4) * Math.ceil(height / 4) * (encoding === 'BC1' || encoding === 'BC4' ? 8 : 16)
        : width * height * (encoding === 'R8' || encoding === 'A8' ? 1 : 4);
    if (data.length !== expected) { throw new Error('Texture preview byte length is invalid.'); }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (encoding === 'BC1') { return decodeBC1(view, width, height, true); }
    if (encoding === 'BC2') { return decodeBC2(view, width, height); }
    if (encoding === 'BC3') { return decodeBC3(view, width, height); }
    if (encoding === 'BC4') { return decodeBC4(view, width, height); }
    if (encoding === 'BC5') { return decodeBC5(view, width, height); }
    if (encoding === 'BC7') { return decodeBC7(view, width, height); }
    const result = new Uint8Array(width * height * 4);
    for (let pixel = 0; pixel < width * height; pixel++) {
        const to = pixel * 4;
        if (encoding === 'R8' || encoding === 'A8') {
            result[to] = result[to + 1] = result[to + 2] = encoding === 'R8' ? data[pixel] : 255;
            result[to + 3] = encoding === 'A8' ? data[pixel] : 255;
        } else {
            result[to] = data[to + (encoding === 'RGBA8' ? 0 : 2)]; result[to + 1] = data[to + 1];
            result[to + 2] = data[to + (encoding === 'RGBA8' ? 2 : 0)]; result[to + 3] = encoding === 'BGRX8' ? 255 : data[to + 3];
        }
    }
    return result;
}
