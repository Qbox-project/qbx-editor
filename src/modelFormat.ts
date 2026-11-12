import { readTextureDictionary, type TextureData } from './assetFormats';
import { assetHash } from './assetInventory';
import { loadResourcePages, type ResourcePages } from './assetResource';

export const MAX_MODEL_VERTICES = 4_000_000, MAX_MODEL_INDICES = 12_000_000;
const MAX_DRAWABLES = 4096, MAX_MODELS = 256, MAX_GEOMETRIES = 4096, MAX_SHADERS = 1024, MAX_PARAMETERS = 96;
const VERSIONS: Record<string, readonly number[]> = { ydr: [165], ydd: [165], yft: [162] };
const GEN9_VERSIONS: Record<string, readonly number[]> = { ydr: [159], ydd: [159], yft: [171] };
const COMPONENT_BYTES = [0, 4, 4, 8, 0, 8, 12, 16, 4, 4, 4, 0, 0, 0, 0, 0];
const POSITION = 0, NORMAL = 3, COLOUR = 4, TEXCOORD = 6;
// Gen9 semantic slots, and Gen9 element formats as legacy component types.
const GEN9_POSITION = 0, GEN9_NORMAL = 4, GEN9_COLOUR = 24, GEN9_TEXCOORD = 28, GEN9_SLOTS = 52;
const GEN9_COMPONENT: Record<number, number> = { 2: 7, 6: 6, 10: 3, 16: 5, 28: 9, 30: 8, 34: 1 };
export const LOD_NAMES = ['High', 'Medium', 'Low', 'Very low'] as const;
const SHADERS = `default default_spec default_tnt default_detail default_terrain_wet default_um normal normal_spec normal_spec_tnt normal_tnt normal_detail normal_spec_detail
normal_decal normal_spec_decal normal_spec_decal_detail normal_decal_tnt normal_spec_decal_tnt normal_reflect normal_spec_reflect normal_spec_reflect_decal normal_cutout normal_spec_cutout
normal_cutout_tnt normal_spec_cutout_tnt normal_alpha normal_spec_alpha normal_screendooralpha normal_spec_screendooralpha normal_um normal_spec_um normal_pxm normal_spec_pxm normal_diffspec
normal_diffspec_detail normal_diffspec_tnt normal_spec_emissive normal_spec_dpm normal_spec_batch normal_terrain_wet spec spec_tnt spec_decal spec_reflect spec_reflect_decal spec_alpha
spec_screendooralpha spec_const emissive emissive_tnt emissive_alpha emissive_alpha_tnt emissive_additive_alpha emissive_additive_uv_alpha emissive_clip emissive_speclum emissivenight
emissivenight_alpha emissivestrong emissivestrong_alpha decal decal_tnt decal_dirt decal_glue decal_normal_only decal_emissive_only decal_emissivenight_only decal_amb_only decal_spec_only
decal_diff_only_um decal_shadow_only cutout cutout_tnt cutout_fence cutout_fence_normal cutout_hard cutout_um cutout_spec_tnt glass glass_pv glass_pv_env glass_env glass_spec glass_reflect
glass_emissive glass_emissivenight glass_emissive_alpha glass_emissivenight_alpha glass_breakable glass_breakable_screendooralpha glass_displacement glass_normal_spec_reflect mirror_default
mirror_decal mirror_crack reflect reflect_decal reflect_alpha parallax parallax_specmap parallax_steep water_fountain water_poolenv water_river water_riverlod water_riverocean water_rivershallow
water_riverfoam water_shallow water_terrainfoam water_decal trees trees_lod trees_lod2 trees_lod_tnt trees_normal trees_normal_diffspec trees_normal_diffspec_tnt trees_normal_spec trees_tnt
trees_shadow_proxy grass grass_batch grass_fur grass_fur_mask grass_fur_lod grass_cam_aligned_batch grass_camera_facing_batch terrain_cb_w_4lyr terrain_cb_w_4lyr_2tex terrain_cb_w_4lyr_2tex_blend
terrain_cb_w_4lyr_2tex_blend_lod terrain_cb_w_4lyr_2tex_blend_pxm terrain_cb_w_4lyr_2tex_blend_pxm_spm terrain_cb_w_4lyr_2tex_pxm terrain_cb_w_4lyr_cm terrain_cb_w_4lyr_cm_pxm terrain_cb_w_4lyr_cm_tnt
terrain_cb_w_4lyr_lod terrain_cb_w_4lyr_pxm terrain_cb_w_4lyr_pxm_spm terrain_cb_w_4lyr_spec terrain_cb_w_4lyr_spec_int terrain_cb_w_4lyr_spec_int_pxm terrain_cb_w_4lyr_spec_pxm terrain_cb_4lyr
terrain_cb_4lyr_2tex terrain_cb_4lyr_lod cloth_default cloth_normal_spec cloth_normal_spec_alpha cloth_normal_spec_cutout cloth_normal_spec_tnt cloth_spec_alpha cloth_spec_cutout ped ped_alpha
ped_cloth ped_cloth_enveff ped_decal ped_decal_decoration ped_decal_expensive ped_decal_nodiff ped_default ped_default_cutout ped_default_cloth ped_default_enveff ped_default_mp ped_default_palette
ped_emissive ped_enveff ped_fur ped_hair_cutout_alpha ped_hair_spiked ped_nopeddamagedecals ped_palette ped_wrinkle ped_wrinkle_cloth ped_wrinkle_cloth_enveff ped_wrinkle_cs ped_wrinkle_enveff
vehicle_basic vehicle_badges vehicle_blurredrotor vehicle_blurredrotor_emissive vehicle_cloth vehicle_cloth2 vehicle_cutout vehicle_dash_emissive vehicle_dash_emissive_opaque vehicle_decal
vehicle_decal2 vehicle_detail vehicle_detail2 vehicle_emissive_alpha vehicle_emissive_opaque vehicle_generic vehicle_interior vehicle_interior2 vehicle_licenseplate vehicle_lightsemissive
vehicle_mesh vehicle_mesh2_enveff vehicle_mesh_enveff vehicle_paint1 vehicle_paint1_enveff vehicle_paint2 vehicle_paint2_enveff vehicle_paint3 vehicle_paint3_enveff vehicle_paint3_lvr vehicle_paint4
vehicle_paint4_emissive vehicle_paint4_enveff vehicle_paint5_enveff vehicle_paint6 vehicle_paint6_enveff vehicle_paint7 vehicle_paint7_enveff vehicle_paint8 vehicle_paint9 vehicle_shuts vehicle_tire
vehicle_tire_emissive vehicle_track vehicle_track2 vehicle_track2_emissive vehicle_track_ammo vehicle_track_emissive vehicle_track_siren vehicle_vehglass vehicle_vehglass_inner vehicle_vehglass_crack
vehicle_lights vehicle_nosplash vehicle_nowater weapon_emissive_tnt weapon_emissivestrong_alpha weapon_normal_spec_alpha weapon_normal_spec_cutout_palette weapon_normal_spec_detail_palette
weapon_normal_spec_detail_tnt weapon_normal_spec_palette weapon_normal_spec_tnt blend_2lyr distance_map gta_default gta_normal gta_spec radar rope_default ptfx_model sky_system clouds_animsoft
clouds_altitude clouds_fast clouds_fog clouds_soft minimap cable albedo_alpha`;
let shaderNames: Map<number, string> | undefined;

export interface ModelTextureUse { parameter: number; name: string }
export interface ModelMaterial { shader: string; bucket: number; textures: ModelTextureUse[]; diffuse?: string }
/** One vertex attribute: `offset` of the first vertex's value in the vertex data, `step` bytes to the next vertex, `type` a legacy component type. */
export interface ModelVertexElement { offset: number; step: number; type: number }
export interface ModelVertexLayout { position?: ModelVertexElement; normal?: ModelVertexElement; colour?: ModelVertexElement; uv?: ModelVertexElement }
export interface ModelGeometry { material: number; vertexCount: number; indexCount: number; stride: number; layout: ModelVertexLayout; vertices: number; indices: number }
export interface ModelLod { level: number; distance: number; geometries: ModelGeometry[]; vertices: number; triangles: number }
export interface ModelDrawable {
    name: string; center: [number, number, number]; radius: number; min: [number, number, number]; max: [number, number, number];
    lods: ModelLod[]; materials: ModelMaterial[]; textures: TextureData[]; skeleton: boolean; lights: number; notes: string[];
}
export interface ModelFile { kind: 'ydr' | 'ydd' | 'yft'; gen9: boolean; pages: ResourcePages; drawables: ModelDrawable[]; notes: string[] }
export interface MeshRange { material: number; vertexCount: number; indexCount: number; positions: number; normals: number; uvs: number; colours: number; indices: number }
export interface LodMesh { buffer: Buffer; meshes: MeshRange[]; notes: string[] }

function shaderName(hash: number): string {
    shaderNames ??= new Map(SHADERS.split(/\s+/).map((name) => [assetHash(name), name]));
    return shaderNames.get(hash) ?? `0x${hash.toString(16).toUpperCase().padStart(8, '0')}`;
}
function vector(pages: ResourcePages, at: number): [number, number, number] { return [pages.f32(at), pages.f32(at + 4), pages.f32(at + 8)]; }

function legacyTextures(pages: ResourcePages, shader: number): ModelTextureUse[] {
    const parameterCount = pages.u8(shader + 0x10), textures: ModelTextureUse[] = [];
    if (parameterCount > MAX_PARAMETERS) { throw new Error('A material declares more than 96 parameters.'); }
    const parameters = parameterCount ? pages.optionalPointer(shader, parameterCount * 16) : undefined;
    if (parameters === undefined) { return textures; }
    let inline = 0;
    for (let parameter = 0; parameter < parameterCount; parameter++) { inline += pages.u8(parameters + parameter * 16) * 16; }
    const names = parameters + parameterCount * 16 + inline;
    for (let parameter = 0; parameter < parameterCount; parameter++) {
        const texture = pages.u8(parameters + parameter * 16) === 0 ? pages.optionalPointer(parameters + parameter * 16 + 8, 0x40) : undefined;
        const name = texture === undefined ? undefined : pages.optionalPointer(texture + 0x28, 1);
        if (name !== undefined) { textures.push({ parameter: pages.u32(names + parameter * 4), name: pages.text(name, 256) }); }
    }
    return textures;
}
/** Gen9 shaders describe parameters in a separate table; a texture parameter indexes the shader's texture pointer list. */
function gen9Textures(pages: ResourcePages, shader: number): ModelTextureUse[] {
    const table = pages.optionalPointer(shader + 0x20, 8), textures: ModelTextureUse[] = [];
    if (table === undefined) { return textures; }
    const textureCount = pages.u8(table + 1), parameterCount = pages.u8(table + 4);
    if (parameterCount > MAX_PARAMETERS) { throw new Error('A material declares more than 96 parameters.'); }
    pages.need(table + 8, parameterCount * 8);
    const references = textureCount ? pages.optionalPointer(shader + 0x10, textureCount * 8) : undefined;
    if (references === undefined) { return textures; }
    for (let parameter = 0; parameter < parameterCount; parameter++) {
        const entry = table + 8 + parameter * 8, data = pages.u32(entry + 4), index = (data >>> 2) & 0xff;
        if ((data & 3) !== 0 || index >= textureCount) { continue; }
        const texture = pages.optionalPointer(references + index * 8, 0x50), name = texture === undefined ? undefined : pages.optionalPointer(texture + 0x28, 1);
        if (name !== undefined) { textures.push({ parameter: pages.u32(entry), name: pages.text(name, 256) }); }
    }
    return textures;
}
function materials(pages: ResourcePages, group: number, gen9: boolean): ModelMaterial[] {
    const count = pages.u16(group + 0x18);
    if (count > MAX_SHADERS) { throw new Error('The model declares more than 1,024 materials.'); }
    const list = count ? pages.pointer(group + 0x10, count * 8) : 0, result: ModelMaterial[] = [];
    for (let index = 0; index < count; index++) {
        const shader = pages.pointer(list + index * 8, gen9 ? 0x40 : 0x30);
        const material: ModelMaterial = gen9 ? { shader: shaderName(pages.u32(shader)), bucket: pages.u8(shader + 0x39), textures: gen9Textures(pages, shader) }
            : { shader: shaderName(pages.u32(shader + 0x08)), bucket: pages.u8(shader + 0x11), textures: legacyTextures(pages, shader) };
        const preferred = (gen9 ? GEN9_DIFFUSE : LEGACY_DIFFUSE).map((parameter) => material.textures.find((use) => use.parameter === parameter)).find((use) => use !== undefined);
        material.diffuse = (preferred ?? material.textures[0])?.name;
        result.push(material);
    }
    return result;
}
// Gen9 renames texture parameters and lists a tint palette before the base colour, so the first texture is not a safe fallback there.
const LEGACY_DIFFUSE = [assetHash('DiffuseSampler')], GEN9_DIFFUSE = [assetHash('DiffuseTex'), assetHash('DiffuseTexture_layer0')];

function legacyLayout(flags: number, types: bigint, stride: number): ModelVertexLayout {
    const elements = new Map<number, ModelVertexElement>();
    let offset = 0;
    for (let semantic = 0; semantic < 16; semantic++) {
        if (!(flags & (1 << semantic))) { continue; }
        const type = Number((types >> BigInt(semantic * 4)) & 0xfn);
        elements.set(semantic, { offset, step: stride, type }); offset += COMPONENT_BYTES[type];
    }
    return offset > stride ? {} : { position: elements.get(POSITION), normal: elements.get(NORMAL), colour: elements.get(COLOUR), uv: elements.get(TEXCOORD) };
}
/** A Gen9 declaration is 52 offsets (u32), 52 steps (u8) and 52 element formats (u8), indexed by semantic slot. */
function gen9Layout(pages: ResourcePages, declaration: number, stride: number): ModelVertexLayout {
    const element = (slot: number): ModelVertexElement | undefined => {
        const type = GEN9_COMPONENT[pages.u8(declaration + GEN9_SLOTS * 5 + slot)];
        return type === undefined ? undefined : { offset: pages.u32(declaration + slot * 4), step: pages.u8(declaration + GEN9_SLOTS * 4 + slot) || stride, type };
    };
    return { position: element(GEN9_POSITION), normal: element(GEN9_NORMAL), colour: element(GEN9_COLOUR), uv: element(GEN9_TEXCOORD) };
}

function drawable(pages: ResourcePages, at: number, name: string, gen9: boolean): ModelDrawable {
    pages.need(at, 0xa8);
    const result: ModelDrawable = { name, center: vector(pages, at + 0x20), radius: pages.f32(at + 0x2c), min: vector(pages, at + 0x30), max: vector(pages, at + 0x40),
        lods: [], materials: [], textures: [], skeleton: pages.u64(at + 0x18) !== 0n, lights: 0, notes: [] };
    const group = pages.optionalPointer(at + 0x10, 0x40);
    if (group !== undefined) {
        result.materials = materials(pages, group, gen9);
        const dictionary = pages.optionalPointer(group + 0x08, 0x40);
        if (dictionary !== undefined) {
            try { result.textures = readTextureDictionary(pages.bytes, pages.system, pages.graphics, dictionary, gen9); }
            catch (error) { result.notes.push(`Embedded textures were not read: ${error instanceof Error ? error.message : String(error)}`); }
        }
    }
    let wideIndices = 0;
    for (let level = 0; level < 4; level++) {
        const header = pages.optionalPointer(at + 0x50 + level * 8, 16);
        if (header === undefined) { continue; }
        const modelCount = pages.u16(header + 8);
        if (modelCount > MAX_MODELS) { throw new Error('A detail level declares more than 256 models.'); }
        const models = modelCount ? pages.pointer(header, modelCount * 8) : 0;
        const lod: ModelLod = { level, distance: pages.f32(at + 0x70 + level * 4), geometries: [], vertices: 0, triangles: 0 };
        for (let model = 0; model < modelCount; model++) {
            const from = pages.pointer(models + model * 8, 0x30), geometryCount = pages.u16(from + 0x10);
            if (lod.geometries.length + geometryCount > MAX_GEOMETRIES) { throw new Error('A detail level declares more than 4,096 geometries.'); }
            const geometries = geometryCount ? pages.pointer(from + 0x08, geometryCount * 8) : 0, mapping = geometryCount ? pages.optionalPointer(from + 0x20, geometryCount * 2) : undefined;
            for (let index = 0; index < geometryCount; index++) {
                const geometry = pages.pointer(geometries + index * 8, 0x98);
                const vertexBuffer = pages.optionalPointer(geometry + 0x18, gen9 ? 0x40 : 0x80), indexBuffer = pages.optionalPointer(geometry + 0x38, gen9 ? 0x40 : 0x60);
                if (vertexBuffer === undefined || indexBuffer === undefined) { continue; }
                const declaration = pages.pointer(vertexBuffer + (gen9 ? 0x38 : 0x30), gen9 ? GEN9_SLOTS * 6 + 8 : 16);
                const stride = pages.u16(vertexBuffer + (gen9 ? 0x0c : 0x08)), vertexCount = pages.u32(vertexBuffer + (gen9 ? 0x08 : 0x18)), indexCount = pages.u32(indexBuffer + 0x08);
                if (!stride || !vertexCount || !indexCount) { continue; }
                if (gen9 && pages.u16(indexBuffer + 0x0c) !== 2) { wideIndices++; continue; }
                if (vertexCount > 0xffff || indexCount > MAX_MODEL_INDICES) { throw new Error('A geometry declares more vertices or indices than the format allows.'); }
                // Exporters fill either of the buffer's two data pointers, or only the geometry's own copy. A Gen9 buffer has one data pointer.
                const size = vertexCount * stride, vertices = gen9 ? pages.optionalPointer(vertexBuffer + 0x18, size) ?? pages.optionalPointer(geometry + 0x78, size)
                    : pages.optionalPointer(vertexBuffer + 0x10, size) ?? pages.optionalPointer(vertexBuffer + 0x20, size) ?? pages.optionalPointer(geometry + 0x78, size);
                if (vertices === undefined) { continue; }
                lod.geometries.push({ material: mapping === undefined ? 0 : pages.u16(mapping + index * 2), vertexCount, indexCount, stride,
                    layout: gen9 ? gen9Layout(pages, declaration, stride) : legacyLayout(pages.u32(declaration), pages.u64(declaration + 8), stride),
                    vertices, indices: pages.pointer(indexBuffer + (gen9 ? 0x18 : 0x10), indexCount * 2) });
                lod.vertices += vertexCount; lod.triangles += Math.floor(indexCount / 3);
            }
        }
        if (lod.geometries.length) { result.lods.push(lod); }
    }
    if (wideIndices) { result.notes.push(`${wideIndices} geometr${wideIndices === 1 ? 'y uses' : 'ies use'} indices wider than 16 bits, which are not shown.`); }
    return result;
}

/** Reads the drawables of a legacy or Gen9 YDR, YDD or YFT. Geometry bytes stay in the resource pages until `buildLodMesh` extracts a detail level. */
export async function parseModel(data: Buffer, extension: string): Promise<ModelFile> {
    const kind = extension.replace(/^\./, '').toLowerCase() as ModelFile['kind'];
    if (!VERSIONS[kind]) { throw new Error('The model viewer reads YDR, YDD and YFT files.'); }
    const pages = await loadResourcePages(data, kind.toUpperCase(), [...VERSIONS[kind], ...GEN9_VERSIONS[kind]]);
    const gen9 = GEN9_VERSIONS[kind].includes(pages.header.version!);
    const file: ModelFile = { kind, gen9, pages, drawables: [], notes: gen9 ? [`Gen9 (GTA V Enhanced) layout, resource version ${pages.header.version}.`] : [] };
    if (kind === 'ydr') {
        const name = pages.optionalPointer(0xa8, 1);
        const result = drawable(pages, 0, name === undefined ? '' : pages.text(name, 256), gen9);
        pages.need(0, 0xd0); result.lights = pages.u16(0xb8);
        file.drawables.push(result);
    } else if (kind === 'yft') {
        const main = pages.optionalPointer(0x30, 0xa8), name = pages.optionalPointer(0x58, 1);
        if (main === undefined) { throw new Error('This fragment has no main drawable.'); }
        file.drawables.push(drawable(pages, main, name === undefined ? '' : pages.text(name, 256), gen9));
        const extra = pages.u32(0x48);
        if (extra) { file.notes.push(`The fragment also holds ${extra} damaged or extra drawable${extra === 1 ? '' : 's'}, which are not shown.`); }
        file.notes.push('Fragment physics, glass and cloth data are not shown.');
    } else {
        pages.need(0, 0x40);
        const count = pages.u16(0x38), hashes = pages.u16(0x28);
        if (count > MAX_DRAWABLES) { throw new Error('The drawable dictionary declares more than 4,096 drawables.'); }
        const list = count ? pages.pointer(0x30, count * 8) : 0, names = hashes ? pages.optionalPointer(0x20, hashes * 4) : undefined;
        for (let index = 0; index < count; index++) {
            const at = pages.pointer(list + index * 8, 0xd0), name = pages.optionalPointer(at + 0xa8, 1);
            const hash = names !== undefined && index < hashes ? pages.u32(names + index * 4) : 0;
            file.drawables.push(drawable(pages, at, (name === undefined ? '' : pages.text(name, 256)) || `0x${hash.toString(16).toUpperCase().padStart(8, '0')}`, gen9));
        }
    }
    return file;
}

function half(value: number): number {
    const exponent = (value >> 10) & 0x1f, fraction = value & 0x3ff, sign = value & 0x8000 ? -1 : 1;
    return sign * (exponent === 0 ? fraction * 2 ** -24 : exponent === 31 ? (fraction ? NaN : Infinity) : (1 + fraction / 1024) * 2 ** (exponent - 15));
}
export function buildLodMesh(file: ModelFile, lod: ModelLod): LodMesh {
    if (lod.vertices > MAX_MODEL_VERTICES || lod.triangles * 3 > MAX_MODEL_INDICES) { throw new Error('This detail level exceeds the 4-million-vertex preview limit; choose a lower detail level.'); }
    const bytes = file.pages.bytes, notes: string[] = [], meshes: MeshRange[] = [];
    let size = 0;
    for (const geometry of lod.geometries) { size += geometry.vertexCount * 36 + Math.ceil(geometry.indexCount * 2 / 4) * 4; }
    const buffer = Buffer.alloc(size);
    let cursor = 0, skipped = 0;
    for (const geometry of lod.geometries) {
        const count = geometry.vertexCount, stride = geometry.stride, base = geometry.vertices;
        // An element is read only when its last vertex still ends inside the vertex data.
        const usable = (element: ModelVertexElement | undefined, types: readonly number[]): ModelVertexElement | undefined =>
            element && types.includes(element.type) && element.offset + (count - 1) * element.step + COMPONENT_BYTES[element.type] <= count * stride ? element : undefined;
        const position = usable(geometry.layout.position, [6, 7, 3]);
        if (!position) { skipped++; continue; }
        file.pages.need(base, count * stride); file.pages.need(geometry.indices, geometry.indexCount * 2);
        const range: MeshRange = { material: geometry.material, vertexCount: count, indexCount: geometry.indexCount, positions: cursor, normals: cursor + count * 12, uvs: cursor + count * 24, colours: cursor + count * 32, indices: cursor + count * 36 };
        const normal = usable(geometry.layout.normal, [6, 7, 10, 3]), uv = usable(geometry.layout.uv, [5, 1]), colour = usable(geometry.layout.colour, [9, 8]);
        let hasNormals = normal !== undefined;
        for (let vertex = 0; vertex < count; vertex++) {
            const from = base + position.offset + vertex * position.step;
            for (let axis = 0; axis < 3; axis++) { buffer.writeFloatLE(position.type === 3 ? half(bytes.readUInt16LE(from + axis * 2)) : bytes.readFloatLE(from + axis * 4), range.positions + vertex * 12 + axis * 4); }
            if (normal) {
                const at = base + normal.offset + vertex * normal.step;
                for (let axis = 0; axis < 3; axis++) {
                    buffer.writeFloatLE(normal.type === 10 ? Math.max(-1, bytes.readInt8(at + axis) / 127) : normal.type === 3 ? half(bytes.readUInt16LE(at + axis * 2)) : bytes.readFloatLE(at + axis * 4), range.normals + vertex * 12 + axis * 4);
                }
            }
            if (uv) {
                const at = base + uv.offset + vertex * uv.step;
                for (let axis = 0; axis < 2; axis++) { buffer.writeFloatLE(uv.type === 1 ? half(bytes.readUInt16LE(at + axis * 2)) : bytes.readFloatLE(at + axis * 4), range.uvs + vertex * 8 + axis * 4); }
            }
            if (colour) { const at = base + colour.offset + vertex * colour.step; bytes.copy(buffer, range.colours + vertex * 4, at, at + 4); }
            else { buffer.writeUInt32LE(0xffffffff, range.colours + vertex * 4); }
        }
        let valid = true;
        for (let index = 0; index < geometry.indexCount; index++) {
            const value = bytes.readUInt16LE(geometry.indices + index * 2);
            if (value >= count) { valid = false; break; }
            buffer.writeUInt16LE(value, range.indices + index * 2);
        }
        if (!valid) { skipped++; continue; }
        if (!hasNormals) { faceNormals(buffer, range); hasNormals = true; }
        meshes.push(range);
        cursor = range.indices + Math.ceil(geometry.indexCount * 2 / 4) * 4;
    }
    if (skipped) { notes.push(`${skipped} geometr${skipped === 1 ? 'y uses' : 'ies use'} a vertex layout or indices that cannot be shown.`); }
    return { buffer: buffer.subarray(0, cursor), meshes, notes };
}
function faceNormals(buffer: Buffer, range: MeshRange): void {
    const read = (vertex: number, axis: number): number => buffer.readFloatLE(range.positions + vertex * 12 + axis * 4);
    const sums = new Float32Array(range.vertexCount * 3);
    for (let index = 0; index + 2 < range.indexCount; index += 3) {
        const [a, b, c] = [0, 1, 2].map((corner) => buffer.readUInt16LE(range.indices + (index + corner) * 2));
        const u = [0, 1, 2].map((axis) => read(b, axis) - read(a, axis)), v = [0, 1, 2].map((axis) => read(c, axis) - read(a, axis));
        const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        for (const vertex of [a, b, c]) { for (let axis = 0; axis < 3; axis++) { sums[vertex * 3 + axis] += normal[axis]; } }
    }
    for (let vertex = 0; vertex < range.vertexCount; vertex++) {
        const length = Math.hypot(sums[vertex * 3], sums[vertex * 3 + 1], sums[vertex * 3 + 2]) || 1;
        for (let axis = 0; axis < 3; axis++) { buffer.writeFloatLE(sums[vertex * 3 + axis] / length, range.normals + vertex * 12 + axis * 4); }
    }
}
