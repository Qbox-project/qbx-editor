import { inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';
import type { AssetTexture, TextureEncoding } from './assetTypes';

const inflate = promisify(inflateRaw);
export const MAX_ASSET_BYTES = 64 * 1024 * 1024;
export const MAX_RESOURCE_BYTES = 128 * 1024 * 1024;
export const MAX_PREVIEW_PIXELS = 1024 * 1024;
export interface ResourceHeader { container: string; version?: number; systemBytes?: number; graphicsBytes?: number; notes: string[] }
export interface TextureData extends AssetTexture { offset: number; length: number; pitch?: number }
export interface TextureFile { header: ResourceHeader; bytes: Buffer; textures: TextureData[]; notes: string[] }

function need(data: Buffer, offset: number, length: number): void {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > data.length) {
        throw new Error('Truncated asset data or an invalid byte offset.');
    }
}
export function resourcePageSize(flags: number): number {
    const units = ((flags >>> 27) & 1) + ((flags >>> 26) & 1) * 2 + ((flags >>> 25) & 1) * 4
        + ((flags >>> 24) & 1) * 8 + ((flags >>> 17) & 127) * 16 + ((flags >>> 11) & 63) * 32
        + ((flags >>> 7) & 15) * 64 + ((flags >>> 5) & 3) * 128 + ((flags >>> 4) & 1) * 256;
    return 512 * 2 ** (flags & 15) * units;
}
export function inspectResourceHeader(data: Buffer): ResourceHeader {
    const container = data.subarray(0, 4).toString('latin1');
    if (container === 'FXAP') { return { container: 'FXAP (asset escrow)', notes: ['Encrypted asset escrow content cannot be inspected.'] }; }
    if (container === 'RSC7') {
        need(data, 0, 16);
        return { container, version: data.readUInt32LE(4), systemBytes: resourcePageSize(data.readUInt32LE(8)),
            graphicsBytes: resourcePageSize(data.readUInt32LE(12)), notes: [] };
    }
    if (container === 'RSC8') {
        need(data, 0, 16);
        const flags = data.readUInt32LE(4);
        const compression = (flags >>> 8) & 31;
        return { container, version: flags & 255, systemBytes: data.readUInt32LE(8) & 0x7ffffff0,
            graphicsBytes: data.readUInt32LE(12) & 0x7ffffff0,
            notes: [`RSC8 header only; payload decoding is unsupported (${compression === 0 ? 'zlib' : compression === 1 ? 'Oodle' : compression === 31 ? 'uncompressed' : `compression ${compression}`}).`,
                (flags & 0x01000000) ? 'The header marks the resource as unencrypted.' : 'The header marks the resource as encrypted.',
                'RSC8 is a container family, not proof of GTA V Enhanced compatibility.'] };
    }
    return { container: container === 'PSIN' ? 'PSO' : /^RBF/.test(container) ? 'RBF' : 'Unrecognized',
        notes: ['This binary layout is not decoded by the asset browser.'] };
}
const DXGI: Record<number, TextureEncoding> = {
    28: 'RGBA8', 29: 'RGBA8', 61: 'R8', 65: 'A8', 71: 'BC1', 72: 'BC1', 74: 'BC2', 75: 'BC2',
    77: 'BC3', 78: 'BC3', 80: 'BC4', 83: 'BC5', 87: 'BGRA8', 88: 'BGRX8', 91: 'BGRA8', 93: 'BGRX8', 98: 'BC7', 99: 'BC7',
};
const LEGACY: Record<number, TextureEncoding> = { 21: 'BGRA8', 22: 'BGRX8', 28: 'A8', 32: 'RGBA8', 50: 'R8',
    0x31545844: 'BC1', 0x33545844: 'BC2', 0x35545844: 'BC3', 0x31495441: 'BC4', 0x32495441: 'BC5', 0x20374342: 'BC7' };
export function textureLevelSize(width: number, height: number, encoding: TextureEncoding): number {
    if (encoding.startsWith('BC')) { return Math.ceil(width / 4) * Math.ceil(height / 4) * (encoding === 'BC1' || encoding === 'BC4' ? 8 : 16); }
    return width * height * (encoding === 'R8' || encoding === 'A8' ? 1 : 4);
}
function dimensions(width: number, height: number, mipCount: number): void {
    if (width < 1 || height < 1 || width > 32768 || height > 32768 || mipCount < 1
        || mipCount > 1 + Math.floor(Math.log2(Math.max(width, height)))) { throw new Error('Invalid texture dimensions or mip count.'); }
}
function bestMip(width: number, height: number, count: number): number | undefined {
    for (let mip = 0; mip < count; mip++) { if (Math.max(1, width >> mip) * Math.max(1, height >> mip) <= MAX_PREVIEW_PIXELS) { return mip; } }
    return undefined;
}
function textureBytes(width: number, height: number, mipCount: number, encoding: TextureEncoding): number {
    let size = 0;
    for (let mip = 0; mip < mipCount; mip++) { size += textureLevelSize(Math.max(1, width >> mip), Math.max(1, height >> mip), encoding); }
    return size;
}
export function parseDds(data: Buffer, name = 'DDS texture'): TextureFile {
    need(data, 0, 128);
    if (data.toString('latin1', 0, 4) !== 'DDS ' || data.readUInt32LE(4) !== 124 || data.readUInt32LE(76) !== 32) { throw new Error('Invalid DDS magic or header size.'); }
    const height = data.readUInt32LE(12), width = data.readUInt32LE(16), mipCount = Math.max(1, data.readUInt32LE(28));
    dimensions(width, height, mipCount);
    const fourcc = data.toString('latin1', 84, 88);
    let offset = 128;
    let encoding: TextureEncoding | undefined;
    let format = fourcc.replace(/\0/g, '') || 'Uncompressed';
    const notes: string[] = [];
    if (fourcc === 'DX10') {
        need(data, 128, 20); offset = 148;
        const dxgi = data.readUInt32LE(128);
        encoding = DXGI[dxgi]; format = encoding ? `${encoding} (DXGI ${dxgi})` : `DXGI ${dxgi}`;
        if (data.readUInt32LE(132) !== 3 || data.readUInt32LE(140) !== 1 || (data.readUInt32LE(136) & 4)) {
            encoding = undefined; notes.push('Arrays, cube maps and volume DDS textures are inspected without a 2D preview.');
        }
    } else if (data.readUInt32LE(80) & 4) { encoding = LEGACY[data.readUInt32LE(84)] ?? ({ BC4U: 'BC4', BC5U: 'BC5' } as const)[fourcc as 'BC4U' | 'BC5U']; }
    else {
        const bits = data.readUInt32LE(88), r = data.readUInt32LE(92), g = data.readUInt32LE(96), b = data.readUInt32LE(100), a = data.readUInt32LE(104);
        if (bits === 32 && g === 0xff00 && a === 0xff000000) { encoding = r === 0xff && b === 0xff0000 ? 'RGBA8' : r === 0xff0000 && b === 0xff ? 'BGRA8' : undefined; }
        else if (bits === 32 && r === 0xff0000 && g === 0xff00 && b === 0xff && !a) { encoding = 'BGRX8'; }
        else if (bits === 8 && r === 0xff) { encoding = 'R8'; }
        else if (bits === 8 && a === 0xff) { encoding = 'A8'; }
        format = encoding ?? `Uncompressed ${bits}-bit masks`;
    }
    if (data.readUInt32LE(112) & 0x20fe00 || data.readUInt32LE(24) > 1) { encoding = undefined; notes.push('Cube/volume DDS preview is unsupported.'); }
    if (encoding && !encoding.startsWith('BC') && (data.readUInt32LE(8) & 8) && data.readUInt32LE(20)
        && data.readUInt32LE(20) !== textureLevelSize(width, 1, encoding)) { encoding = undefined; notes.push('Padded DDS row pitches are inspected without a preview.'); }
    if (!encoding) { notes.push('This texture encoding is not supported for preview.'); }
    const length = encoding ? textureBytes(width, height, mipCount, encoding) : data.length - offset;
    need(data, offset, length);
    const previewMip = encoding ? bestMip(width, height, mipCount) : undefined;
    if (encoding && previewMip === undefined) { notes.push('No mip fits the one-megapixel preview limit.'); }
    return { header: { container: 'DDS', notes: [] }, bytes: data, textures: [{ id: 0, name, width, height, mipCount,
        format, encoding, offset, length, previewMip, notes }], notes: [] };
}
export async function parseYtd(data: Buffer): Promise<TextureFile> {
    const header = inspectResourceHeader(data);
    if (header.container !== 'RSC7') { throw new Error(header.notes.join(' ') || 'YTD preview requires an RSC7 resource.'); }
    if (header.version !== 13 && header.version !== 5) { throw new Error(`YTD resource version ${header.version} is unsupported; expected Legacy 13 or Gen9 5.`); }
    const system = header.systemBytes!, graphics = header.graphicsBytes!, total = system + graphics;
    if (system < 64 || total > MAX_RESOURCE_BYTES) { throw new Error('Invalid or oversized resource pages (maximum 128 MiB expanded).'); }
    let bytes: Buffer;
    try { bytes = await inflate(data.subarray(16), { maxOutputLength: total }); }
    catch {
        if (data.length - 16 !== total) { throw new Error('YTD compressed payload is invalid or exceeds its declared pages.'); }
        bytes = data.subarray(16);
    }
    if (bytes.length !== total) { throw new Error('YTD payload length does not match its declared resource pages.'); }
    function pointer(at: number, length: number): number {
        need(bytes, at, 8);
        const value = bytes.readBigUInt64LE(at);
        const base = value & 0xfffffffff0000000n;
        const offset = Number(value & 0xfffffffn);
        const region = base === 0x50000000n ? system : base === 0x60000000n ? graphics : -1;
        if (region < 0 || offset + length > region) { throw new Error('YTD contains an invalid resource pointer.'); }
        return offset + (base === 0x60000000n ? system : 0);
    }
    const count = bytes.readUInt16LE(0x38), capacity = bytes.readUInt16LE(0x3a);
    if (count > 2048 || capacity < count) { throw new Error('YTD dictionary count is invalid or exceeds 2,048 textures.'); }
    const list = count ? pointer(0x30, count * 8) : 0;
    const textures: TextureData[] = [];
    for (let id = 0; id < count; id++) {
        const gen9 = header.version === 5;
        const at = pointer(list + id * 8, gen9 ? 80 : 128);
        const nameAt = pointer(at + 0x28, 1);
        const nameLimit = Math.min(nameAt + 1025, nameAt < system ? system : total);
        const end = bytes.subarray(nameAt, nameLimit).indexOf(0) + nameAt;
        if (end < nameAt) { throw new Error('YTD contains an invalid texture name.'); }
        const name = bytes.toString('utf8', nameAt, end);
        const width = bytes.readUInt16LE(at + (gen9 ? 0x18 : 0x50)), height = bytes.readUInt16LE(at + (gen9 ? 0x1a : 0x52));
        const mipCount = bytes[at + (gen9 ? 0x22 : 0x5d)];
        dimensions(width, height, mipCount);
        const formatId = gen9 ? bytes[at + 0x1f] : bytes.readUInt32LE(at + 0x58);
        let encoding: TextureEncoding | undefined = gen9 ? DXGI[formatId] : LEGACY[formatId];
        const format = encoding ?? `${gen9 ? 'Gen9' : 'D3D'} format 0x${formatId.toString(16)}`;
        const notes: string[] = [];
        if (bytes.readUInt16LE(at + (gen9 ? 0x1c : 0x54)) > 1 || (gen9 && bytes[at + 0x1e] !== 1)) {
            encoding = undefined; notes.push('Only 2D textures are previewed.');
        }
        if (gen9 && bytes[at + 0x20] !== 255 && bytes[at + 0x20] !== 8) { encoding = undefined; notes.push('This Gen9 texture uses an unsupported tiled layout.'); }
        if (!gen9 && encoding && !encoding.startsWith('BC') && bytes.readUInt16LE(at + 0x56)
            && bytes.readUInt16LE(at + 0x56) !== textureLevelSize(width, 1, encoding)) { encoding = undefined; notes.push('Padded texture row strides are inspected without a preview.'); }
        if (!encoding) { notes.push('Texture metadata is available; this encoding/layout is not previewed.'); }
        const length = encoding ? textureBytes(width, height, mipCount, encoding) : 1;
        const offset = pointer(at + (gen9 ? 0x38 : 0x70), length);
        const previewMip = encoding ? bestMip(width, height, mipCount) : undefined;
        if (encoding && previewMip === undefined) { notes.push('No mip fits the one-megapixel preview limit.'); }
        textures.push({ id, name, width, height, mipCount, format, encoding, offset, length, previewMip, notes });
    }
    return { header, bytes, textures, notes: [header.version === 5 ? 'Gen9/Enhanced YTD layout (RSC7 version 5).' : 'Legacy YTD layout (RSC7 version 13).'] };
}
export function textureMip(file: TextureFile, textureId: number, mip: number): { width: number; height: number; encoding: TextureEncoding; data: Buffer } {
    const texture = file.textures[textureId];
    if (!texture || !texture.encoding || !Number.isInteger(mip) || mip < 0 || mip >= texture.mipCount) { throw new Error('Choose a supported texture and mip level.'); }
    const width = Math.max(1, texture.width >> mip), height = Math.max(1, texture.height >> mip);
    if (width * height > MAX_PREVIEW_PIXELS) { throw new Error('Choose a smaller mip; previews are limited to one megapixel.'); }
    let offset = texture.offset;
    for (let level = 0; level < mip; level++) { offset += textureLevelSize(Math.max(1, texture.width >> level), Math.max(1, texture.height >> level), texture.encoding); }
    const length = textureLevelSize(width, height, texture.encoding);
    need(file.bytes, offset, length);
    return { width, height, encoding: texture.encoding, data: file.bytes.subarray(offset, offset + length) };
}
