import { inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';
import { inspectResourceHeader, MAX_RESOURCE_BYTES, type ResourceHeader } from './assetFormats';

const inflate = promisify(inflateRaw);
const SYSTEM_BASE = 0x50000000n, GRAPHICS_BASE = 0x60000000n;

export class ResourcePages {
    constructor(readonly header: ResourceHeader, readonly bytes: Buffer, readonly system: number, readonly graphics: number, private readonly label: string) {}
    need(offset: number, length: number): void {
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > this.bytes.length) {
            throw new Error(`${this.label} data is truncated or contains an invalid offset.`);
        }
    }
    u8(at: number): number { this.need(at, 1); return this.bytes[at]; }
    u16(at: number): number { this.need(at, 2); return this.bytes.readUInt16LE(at); }
    i16(at: number): number { this.need(at, 2); return this.bytes.readInt16LE(at); }
    u32(at: number): number { this.need(at, 4); return this.bytes.readUInt32LE(at); }
    i32(at: number): number { this.need(at, 4); return this.bytes.readInt32LE(at); }
    f32(at: number): number { this.need(at, 4); return this.bytes.readFloatLE(at); }
    u64(at: number): bigint { this.need(at, 8); return this.bytes.readBigUInt64LE(at); }
    /** Offset of a virtual address, or undefined for a null pointer. */
    address(value: bigint, length: number): number | undefined {
        if (value === 0n) { return undefined; }
        const base = value & 0xfffffffff0000000n, offset = Number(value & 0xfffffffn);
        const region = base === SYSTEM_BASE ? this.system : base === GRAPHICS_BASE ? this.graphics : -1;
        if (region < 0 || !Number.isSafeInteger(length) || length < 0 || offset + length > region) { throw new Error(`${this.label} contains an invalid resource pointer.`); }
        return offset + (base === GRAPHICS_BASE ? this.system : 0);
    }
    optionalPointer(at: number, length: number): number | undefined { return this.address(this.u64(at), length); }
    pointer(at: number, length: number): number {
        const offset = this.optionalPointer(at, length);
        if (offset === undefined) { throw new Error(`${this.label} is missing a required resource pointer.`); }
        return offset;
    }
    /** A NUL-terminated string that stays inside the page region it starts in. */
    text(at: number, limit = 1024): string {
        this.need(at, 1);
        const region = at < this.system ? this.system : this.bytes.length;
        const end = this.bytes.subarray(at, Math.min(at + limit + 1, region)).indexOf(0);
        if (end < 0) { throw new Error(`${this.label} contains an unterminated string.`); }
        return this.bytes.toString('latin1', at, at + end);
    }
}

export async function loadResourcePages(data: Buffer, label: string, versions: readonly number[]): Promise<ResourcePages> {
    const header = inspectResourceHeader(data);
    if (header.container !== 'RSC7') { throw new Error(header.notes.join(' ') || `${label} inspection requires an RSC7 resource; this file is ${header.container}.`); }
    if (!versions.includes(header.version!)) { throw new Error(`${label} resource version ${header.version} is unsupported; expected ${versions.join(' or ')}.`); }
    const system = header.systemBytes!, graphics = header.graphicsBytes!, total = system + graphics;
    if (system < 16 || total > MAX_RESOURCE_BYTES) { throw new Error('Invalid or oversized resource pages (maximum 128 MiB expanded).'); }
    let bytes: Buffer;
    // Some exporters declare fewer pages than they write, so the declared total bounds pointers, not the payload.
    try { bytes = await inflate(data.subarray(16), { maxOutputLength: MAX_RESOURCE_BYTES }); }
    catch {
        if (data.length - 16 < system) { throw new Error(`${label} compressed payload is invalid or exceeds the 128 MiB inspection limit.`); }
        bytes = data.subarray(16);
    }
    if (bytes.length < system) { throw new Error(`${label} payload is shorter than its declared system pages.`); }
    return new ResourcePages(header, bytes, system, graphics, label);
}
