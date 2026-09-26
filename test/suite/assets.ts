import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { inspectResourceHeader, parseDds, parseYtd, resourcePageSize, textureMip } from '../../src/assetFormats';
import { assetContained, assetGlobMatches, assetHash, declarationTargets, inventoryAssets, readAssetBytes, referenceIdsForAsset, referenceTargets, type IndexedAssetReference } from '../../src/assetInventory';
import type { AssetDeclaration, AssetEntry, AssetReference, TextureEncoding } from '../../src/assetTypes';

type Test = [string, () => void | Promise<void>];
// Independently constructed format fixtures. BC1 endpoint 0 = RGB565 red, all indices = 0.
export const RED_BC1 = Buffer.from('00f8000000000000', 'hex');
export function syntheticDds(width = 4, height = 4, mipCount = 1): Buffer {
    let size = 0;
    for (let mip = 0; mip < mipCount; mip++) { size += Math.ceil(Math.max(1, width >> mip) / 4) * Math.ceil(Math.max(1, height >> mip) / 4) * 8; }
    const data = Buffer.alloc(128 + size);
    data.write('DDS '); data.writeUInt32LE(124, 4); data.writeUInt32LE(0x21007, 8);
    data.writeUInt32LE(height, 12); data.writeUInt32LE(width, 16); data.writeUInt32LE(mipCount, 28);
    data.writeUInt32LE(32, 76); data.writeUInt32LE(4, 80); data.write('DXT1', 84); data.writeUInt32LE(0x1000, 108);
    for (let offset = 128; offset < data.length; offset += 8) { RED_BC1.copy(data, offset); }
    return data;
}
export function syntheticYtd(version: 5 | 13 = 13, compressed = true, mutate?: (pages: Buffer) => void): Buffer {
    const header = Buffer.alloc(16); header.write('RSC7'); header.writeUInt32LE(version, 4);
    header.writeUInt32LE(0x08000000, 8); header.writeUInt32LE(0x08000000, 12); // one 512-byte page per region
    const pages = Buffer.alloc(1024);
    pages.writeBigUInt64LE(0x50000040n, 0x30); pages.writeUInt16LE(1, 0x38); pages.writeUInt16LE(1, 0x3a);
    pages.writeBigUInt64LE(0x50000080n, 0x40);
    const at = 0x80;
    pages.writeBigUInt64LE(0x50000180n, at + 0x28); pages.write('test_diffuse\0', 0x180);
    if (version === 13) {
        pages.writeUInt16LE(4, at + 0x50); pages.writeUInt16LE(4, at + 0x52); pages.writeUInt16LE(1, at + 0x54);
        pages.writeUInt32LE(0x31545844, at + 0x58); pages[at + 0x5d] = 1; pages.writeBigUInt64LE(0x60000000n, at + 0x70);
    } else {
        pages.writeUInt16LE(4, at + 0x18); pages.writeUInt16LE(4, at + 0x1a); pages.writeUInt16LE(1, at + 0x1c);
        pages[at + 0x1e] = 1; pages[at + 0x1f] = 71; pages[at + 0x20] = 255; pages[at + 0x22] = 1;
        pages.writeBigUInt64LE(0x60000000n, at + 0x38);
    }
    RED_BC1.copy(pages, 512); mutate?.(pages);
    return Buffer.concat([header, compressed ? deflateRawSync(pages) : pages]);
}
async function temporary(body: (root: string) => Promise<void>): Promise<void> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qbx-assets-tests-'));
    try { await body(root); }
    finally {
        assert.ok(assetContained(path.resolve(os.tmpdir()), path.resolve(root)) && path.resolve(root) !== path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('qbx-assets-tests-'));
        await fs.rm(root, { recursive: true, force: true });
    }
}
const location = { uri: 'file:///asset-test/fxmanifest.lua', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
const declaration = (value: string, dataType?: string): AssetDeclaration => ({ kind: dataType ? 'data_file' : 'file', value, dataType, location });
const tests: Test[] = [
    ['DDS BC1 fixture decodes exact red pixels and non-multiple-of-four dimensions', async () => {
        const { decodeAssetTexture } = await import('../../src/assetTextureDecode.mjs');
        for (const size of [1, 4, 5]) {
            const file = parseDds(syntheticDds(size, size));
            const mip = textureMip(file, 0, 0);
            assert.equal(mip.encoding, 'BC1'); assert.equal(mip.width, size);
            const pixels = decodeAssetTexture(mip.data, mip.width, mip.height, mip.encoding);
            assert.equal(pixels.length, size * size * 4);
            for (let at = 0; at < pixels.length; at += 4) { assert.deepEqual([...pixels.subarray(at, at + 4)], [255, 0, 0, 255]); }
        }
    }],
    ['synthetic Legacy and Gen9 YTDs share the expected texture, name and payload', async () => {
        for (const version of [13, 5] as const) {
            for (const compressed of [true, false]) {
                const file = await parseYtd(syntheticYtd(version, compressed));
                assert.equal(file.header.container, 'RSC7'); assert.equal(file.header.version, version);
                assert.equal(file.textures.length, 1); assert.equal(file.textures[0].name, 'test_diffuse');
                assert.equal(file.textures[0].encoding, 'BC1'); assert.equal(file.textures[0].previewMip, 0);
                assert.deepEqual(textureMip(file, 0, 0).data, RED_BC1);
            }
        }
    }],
    ['binary magic uses exact bytes and RSC8 remains honest header-only metadata', async () => {
        const falseRsc = Buffer.from([0xd2, 0xd3, 0xc3, 0x37, ...new Array<number>(12).fill(0)]);
        assert.equal(inspectResourceHeader(falseRsc).container, 'Unrecognized');
        const falseDds = syntheticDds(); Buffer.from([0xc4, 0xc4, 0xd3, 0xa0]).copy(falseDds);
        assert.throws(() => parseDds(falseDds), /magic/);
        const rsc8 = Buffer.alloc(16); rsc8.write('RSC8'); rsc8.writeUInt32LE(0x01001f05, 4); rsc8.writeUInt32LE(1024, 8);
        const header = inspectResourceHeader(rsc8);
        assert.equal(header.version, 5); assert.equal(header.systemBytes, 1024); assert.match(header.notes.join(' '), /header only.*unsupported.*uncompressed/);
        assert.match(header.notes.join(' '), /not proof of GTA V Enhanced/);
        await assert.rejects(parseYtd(rsc8), /unsupported/);
        assert.match(inspectResourceHeader(Buffer.from('FXAP')).notes.join(' '), /escrow/);
        assert.throws(() => inspectResourceHeader(Buffer.from('RSC7')), /Truncated/);
        assert.equal(resourcePageSize(0x08000000), 512); assert.equal(resourcePageSize(0x04000000), 1024);
    }],
    ['DDS rejects malformed dimensions, mip chains and headers before decoding', () => {
        assert.throws(() => parseDds(Buffer.alloc(127)), /Truncated/);
        const zero = syntheticDds(); zero.writeUInt32LE(0, 16); assert.throws(() => parseDds(zero), /dimensions/);
        const large = syntheticDds(); large.writeUInt32LE(0xffffffff, 12); assert.throws(() => parseDds(large), /dimensions/);
        const levels = syntheticDds(); levels.writeUInt32LE(32, 28); assert.throws(() => parseDds(levels), /mip count/);
        assert.throws(() => parseDds(syntheticDds().subarray(0, 135)), /Truncated/);
        const cube = syntheticDds(); cube.writeUInt32LE(0x200, 112);
        assert.equal(parseDds(cube).textures[0].encoding, undefined);
        assert.throws(() => textureMip(parseDds(cube), 0, 0), /supported/);
    }],
    ['mips select bounded previews and retain exact payload offsets', () => {
        const file = parseDds(syntheticDds(2048, 1024, 3));
        assert.equal(file.textures[0].previewMip, 1);
        assert.throws(() => textureMip(file, 0, 0), /one megapixel/);
        const mip = textureMip(file, 0, 2); assert.equal(mip.width, 512); assert.equal(mip.height, 256);
        assert.equal(mip.data.length, 65536); assert.deepEqual(mip.data.subarray(0, 8), RED_BC1);
        assert.throws(() => textureMip(file, 0, 3), /mip/); assert.throws(() => textureMip(file, 5, 0), /texture/);
    }],
    ['YTD rejects bad pointers, names, dictionary counts and decompression size mismatches', async () => {
        await assert.rejects(parseYtd(syntheticYtd(13, true, (pages) => pages.writeBigUInt64LE(0x70000000n, 0x40))), /pointer/);
        await assert.rejects(parseYtd(syntheticYtd(13, true, (pages) => pages.writeUInt16LE(2049, 0x38))), /count/);
        await assert.rejects(parseYtd(syntheticYtd(13, true, (pages) => pages.writeBigUInt64LE(0x600001ffn, 0x80 + 0x70))), /pointer/);
        await assert.rejects(parseYtd(syntheticYtd(13, true, (pages) => { pages.writeBigUInt64LE(0x500001ffn, 0x80 + 0x28); pages[511] = 65; })), /name/);
        const unsupported = syntheticYtd(); unsupported.writeUInt32LE(99, 4); await assert.rejects(parseYtd(unsupported), /unsupported/);
        const oversized = syntheticYtd(); oversized.writeUInt32LE(0x0800000f, 8); oversized.writeUInt32LE(0x0800000f, 12);
        // Declared 32 MiB cannot accept this fixture's 1 KiB expanded payload.
        await assert.rejects(parseYtd(oversized), /length/);
        const bomb = Buffer.concat([syntheticYtd().subarray(0, 16), deflateRawSync(Buffer.alloc(1025))]);
        await assert.rejects(parseYtd(bomb), /declared pages/);
    }],
    ['unsupported Gen9 tiling and padded DDS or Legacy rows do not produce scrambled previews', async () => {
        const tiled = await parseYtd(syntheticYtd(5, true, (pages) => { pages[0xa0] = 1; }));
        assert.equal(tiled.textures[0].encoding, undefined); assert.match(tiled.textures[0].notes.join(' '), /tiled/);
        const padded = await parseYtd(syntheticYtd(13, true, (pages) => { pages.writeUInt32LE(21, 0xd8); pages.writeUInt16LE(20, 0xd6); }));
        assert.equal(padded.textures[0].encoding, undefined); assert.match(padded.textures[0].notes.join(' '), /strides/);
        const dds = Buffer.alloc(128 + 80); syntheticDds().copy(dds, 0, 0, 128);
        dds.fill(0, 84, 108); dds.writeUInt32LE(0x100f, 8); dds.writeUInt32LE(20, 20); dds.writeUInt32LE(0x41, 80);
        dds.writeUInt32LE(32, 88); dds.writeUInt32LE(0xff, 92); dds.writeUInt32LE(0xff00, 96); dds.writeUInt32LE(0xff0000, 100); dds.writeUInt32LE(0xff000000, 104);
        assert.equal(parseDds(dds).textures[0].encoding, undefined); assert.match(parseDds(dds).textures[0].notes.join(' '), /pitches/);
        dds.writeUInt32LE(16, 20); assert.equal(parseDds(dds).textures[0].encoding, 'RGBA8');
    }],
    ['DX10 BC7 valid mode-six zero endpoint block decodes transparent black', async () => {
        const { decodeAssetTexture } = await import('../../src/assetTextureDecode.mjs');
        const data = Buffer.alloc(164); syntheticDds().copy(data, 0, 0, 128); data.write('DX10', 84);
        data.writeUInt32LE(98, 128); data.writeUInt32LE(3, 132); data.writeUInt32LE(1, 140); data[148] = 0x40;
        const file = parseDds(data); assert.equal(file.textures[0].encoding, 'BC7');
        const mip = textureMip(file, 0, 0);
        assert.deepEqual(decodeAssetTexture(mip.data, 4, 4, mip.encoding), new Uint8Array(64));
        data.writeUInt32LE(2, 140); assert.equal(parseDds(data).textures[0].encoding, undefined);
    }],
    ['browser decoder validates memory bounds and channel layouts independently', async () => {
        const { decodeAssetTexture: decode } = await import('../../src/assetTextureDecode.mjs');
        assert.deepEqual([...decode(Uint8Array.of(10, 20, 30, 40), 1, 1, 'BGRA8')], [30, 20, 10, 40]);
        assert.deepEqual([...decode(Uint8Array.of(10, 20, 30, 0), 1, 1, 'BGRX8')], [30, 20, 10, 255]);
        assert.deepEqual([...decode(Uint8Array.of(100), 1, 1, 'R8')], [100, 100, 100, 255]);
        assert.deepEqual([...decode(Uint8Array.of(100), 1, 1, 'A8')], [255, 255, 255, 100]);
        assert.throws(() => decode(RED_BC1, 32768, 32768, 'BC1'), /megapixel/);
        assert.throws(() => decode(RED_BC1, Infinity, 4, 'BC1'), /megapixel/);
        assert.throws(() => decode(new Uint8Array(7), 4, 4, 'BC1'), /length/);
        assert.throws(() => decode(new Uint8Array(), 1, 1, 'injected' as TextureEncoding), /Unsupported/);
        const backing = Buffer.concat([Buffer.alloc(3), RED_BC1, Buffer.alloc(3)]);
        assert.deepEqual([...decode(backing.subarray(3, 11), 1, 1, 'BC1')], [255, 0, 0, 255]);
    }],
    ['glob matching is bounded and treats bracket category names literally', () => {
        for (const [pattern, filename] of [['**/*.ytd', 'a.ytd'], ['**/*.ytd', '[cars]/nested/a.ytd'], ['[cars]/*.ytd', '[cars]/a.ytd'], ['stream/?.ytd', 'stream/a.ytd']]) {
            assert.equal(assetGlobMatches(pattern, filename), true, `${pattern}: ${filename}`);
        }
        for (const [pattern, filename] of [['*.ytd', 'nested/a.ytd'], ['[cars]/*.ytd', 'c/a.ytd'], ['stream/?.ytd', 'stream/ab.ytd'], ['**/cars/*.ytd', 'cars/a.dds']]) {
            assert.equal(assetGlobMatches(pattern, filename), false, `${pattern}: ${filename}`);
        }
        assert.equal(assetGlobMatches('*a'.repeat(32) + 'b', 'a'.repeat(64)), false);
        assert.equal(assetGlobMatches('*'.repeat(4097), 'a'), false);
    }],
    ['resource inventory covers bracket directories, uppercase names, duplicates and header problems', async () => temporary(async (root) => {
        const resource = path.join(root, '[local]', 'asset_resource');
        await fs.mkdir(path.join(resource, 'stream', 'nested'), { recursive: true });
        await fs.writeFile(path.join(resource, 'stream', 'Foo.YTD'), syntheticYtd());
        await fs.writeFile(path.join(resource, 'stream', 'nested', 'foo.ytd'), syntheticYtd(5));
        await fs.writeFile(path.join(resource, 'stream', 'bad.dds'), 'bad');
        await fs.writeFile(path.join(resource, 'stream', 'café.ytd'), syntheticYtd());
        await fs.writeFile(path.join(resource, 'client.lua'), '');
        const inventory = await inventoryAssets(resource);
        const upper = inventory.entries.find((entry) => entry.path === 'stream/Foo.YTD')!;
        assert.equal(upper.name, 'Foo'); assert.equal(upper.hash, assetHash('foo')); assert.equal(upper.format, 'RSC7 v13');
        assert.equal(inventory.entries.find((entry) => entry.name === 'café')!.hash, undefined);
        assert.ok(inventory.files.has('client.lua')); assert.equal(inventory.entries.length, 4);
        assert.ok(inventory.issues.some((issue) => issue.message.includes('Duplicate streamed')));
        assert.ok(inventory.issues.some((issue) => issue.message.includes('Invalid or truncated DDS')));
        const reference = { kind: 'textureDictionary', hash: assetHash('FOO'), location } as AssetReference;
        assert.equal(referenceTargets(reference, inventory.entries).length, 2);
        assert.equal(referenceTargets({ kind: 'model', value: 'foo', location }, inventory.entries).length, 0);
        assert.equal(referenceTargets({ kind: 'texture', value: 'test_diffuse', dictionary: 'Foo', location }, inventory.entries).length, 2);
        assert.throws(() => assetHash('café'), /ASCII/);
    })],
    ['manifest health distinguishes files, audio directories, excluded coverage and missing paths', async () => temporary(async (root) => {
        await fs.mkdir(path.join(root, 'audio', 'mywaves'), { recursive: true });
        await fs.mkdir(path.join(root, '.assets')); await fs.mkdir(path.join(root, 'node_modules')); await fs.mkdir(path.join(root, 'images'));
        await fs.writeFile(path.join(root, '.assets', 'hidden.png'), 'x'); await fs.writeFile(path.join(root, 'images', 'Icon.PNG'), 'x');
        const inventory = await inventoryAssets(root);
        assert.deepEqual(declarationTargets(declaration('audio/mywaves', 'AUDIO_WAVEPACK'), inventory).matches, ['audio/mywaves']);
        assert.equal(declarationTargets(declaration('audio/mywaves'), inventory).missing, true);
        assert.equal(declarationTargets(declaration('missing.png'), inventory).missing, true);
        for (const value of ['.assets/hidden.png', 'node_modules/app/image.png', '**/*.png', '@another/image.png', 'https://example.invalid/icon.png']) {
            const target = declarationTargets(declaration(value), inventory); assert.ok(!target.missing, value);
        }
        const caseVariant = declarationTargets(declaration('images/icon.png'), inventory);
        if (process.platform === 'win32') { assert.deepEqual(caseVariant.matches, ['images/Icon.PNG']); assert.match(caseVariant.note!, /casing/); }
        else { assert.equal(caseVariant.missing, true); }
        assert.equal(declarationTargets(declaration('../outside.png'), inventory).missing, true);
        inventory.matchingBudget = 0;
        assert.match(declarationTargets(declaration('images/*.not-found'), inventory).note!, /budget/);
    })],
    ['asset reads stay bounded and reject escapes while inventory skips symbolic links', async () => temporary(async (root) => {
        const resource = path.join(root, 'resource'), outside = path.join(root, 'outside');
        await fs.mkdir(resource); await fs.mkdir(outside); await fs.writeFile(path.join(resource, 'image.png'), '12345678');
        await fs.writeFile(path.join(outside, 'secret.png'), 'not an asset');
        assert.deepEqual(await readAssetBytes(resource, 'image.png', 4, true), Buffer.from('1234'));
        await assert.rejects(readAssetBytes(resource, 'image.png', 4), /limit/);
        await assert.rejects(readAssetBytes(resource, '../outside/secret.png', 100), /inside/);
        try { await fs.symlink(outside, path.join(resource, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { return; } throw error; }
        const inventory = await inventoryAssets(resource); assert.ok(inventory.incomplete); assert.ok(!inventory.files.has('linked/secret.png'));
        await assert.rejects(readAssetBytes(resource, 'linked/secret.png', 100), /outside/);
        await assert.rejects(inventoryAssets(resource, () => false), /superseded/);
    })],
    ['reverse source lookup finds the sixtieth asset beyond a broad glob row link limit', () => {
        const assets: AssetEntry[] = Array.from({ length: 60 }, (_, index) => ({ id: `asset:${index}`, path: `stream/file${index}.ytd`, name: `file${index}`,
            category: 'texture', extension: '.ytd', hash: assetHash(`file${index}`), size: 128, format: 'RSC7 v13', issues: [] }));
        const selected = assets[59];
        assert.ok(!assets.slice(0, 50).some((entry) => entry.id === selected.id), 'the selected asset is absent from displayed row links');
        const rows: IndexedAssetReference[] = [
            { id: 'broad', declaration: declaration('stream/**/*.ytd') },
            { id: 'exact', declaration: declaration('stream/file59.ytd') },
            { id: 'other', declaration: declaration('stream/file0.ytd') },
            { id: 'remote', declaration: declaration('@other/stream/file59.ytd') },
            { id: 'directory', declaration: declaration('audio', 'AUDIO_WAVEPACK') },
            { id: 'native-name', reference: { kind: 'textureDictionary', value: 'file59', location } },
            { id: 'native-hash', reference: { kind: 'textureDictionary', hash: selected.hash, location } },
            { id: 'other-family', reference: { kind: 'model', value: 'file59', location } },
        ];
        assert.deepEqual(referenceIdsForAsset(selected, rows), { ids: ['broad', 'exact', 'native-name', 'native-hash'], incomplete: false });
        assert.deepEqual(referenceIdsForAsset(assets[0], rows).ids, ['broad', 'other']);
        const wave: AssetEntry = { ...selected, path: 'sfx/dlc_custom/bank.awc', name: 'bank', extension: '.awc', category: 'audio' };
        const waveRows: IndexedAssetReference[] = [
            { id: 'pack', declaration: declaration('sfx/dlc_custom', 'AUDIO_WAVEPACK') },
            { id: 'pack-glob', declaration: declaration('sfx/*', 'AUDIO_WAVEPACK') },
            { id: 'other-pack', declaration: declaration('sfx/dlc_custom2', 'AUDIO_WAVEPACK') },
            { id: 'file-declaration', declaration: declaration('sfx/dlc_custom') },
        ];
        assert.deepEqual(referenceIdsForAsset(wave, waveRows), { ids: ['pack', 'pack-glob'], incomplete: false });
    }],
];
export async function runAssetTests(): Promise<void> {
    const failures: string[] = [];
    for (const [name, body] of tests) {
        try { await body(); console.log(`  ok   ${name}`); }
        catch (error) { failures.push(name); console.error(`  FAIL ${name}\n${error instanceof Error ? error.stack : String(error)}`); }
    }
    if (failures.length) { throw new Error(`${failures.length} asset test(s) failed: ${failures.join(', ')}`); }
}
