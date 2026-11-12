import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { inspectResourceHeader } from './assetFormats';
import { assetGlobMatches } from './assetInventory';
import { manifestValues, parseManifest, type ManifestEntry, type ManifestValue } from './manifestLite';
import { parseXml, type XmlElement } from './xmlLite';

export type CheckSeverity = 'error' | 'warning' | 'info';
export type CheckCategory = 'vehicle' | 'weapon' | 'data file' | 'stream' | 'escrow';

export interface CheckFinding {
    severity: CheckSeverity;
    category: CheckCategory;
    resource: string;
    message: string;
    /** Absolute path of the file the finding is about, with a zero-based line where one is known. */
    file?: string;
    line?: number;
}

export interface StreamedAsset { resource: string; name: string; file: string; size: number; physical?: number }
export interface IdentifiedItem { resource: string; id: string; name: string; file: string; line?: number }

/** What one resource contributes to the checks that compare resources. */
export interface ResourceFacts {
    name: string;
    root: string;
    stream: StreamedAsset[];
    vehicleModels: IdentifiedItem[];
    modKits: IdentifiedItem[];
    sirens: IdentifiedItem[];
    escrowed: boolean;
    encryptedFiles: number;
    incomplete: boolean;
}

export interface CheckTarget { name: string; root: string; manifest: string }
export interface CheckResult { findings: CheckFinding[]; facts: ResourceFacts[] }

export const MAX_CHECK_FILES = 20_000;
const MAX_META_BYTES = 8 * 1024 * 1024;
const EXCLUDED = new Set(['.git', 'node_modules', 'vendor', '.vscode-test', '.svn']);
/** The FiveM client warns about a streamed asset from this much physical memory. */
export const OVERSIZED_ASSET_BYTES = 16 * 1024 * 1024;
export const HUGE_ASSET_BYTES = 64 * 1024 * 1024;
const RESOURCE_CONTAINERS = new Set(['.ytd', '.ydr', '.ydd', '.yft', '.ybn', '.ymap', '.ytyp', '.ycd', '.ynv', '.ynd', '.ypt', '.ymt', '.yld']);

/** The data file types the checks read, and others that are common, to catch a type written wrong. */
export const DATA_FILE_TYPES = [
    'AMBIENT_PED_MODEL_SET_FILE', 'AMBIENT_SCENARIO_FILE', 'AUDIO_DYNAMIXDATA', 'AUDIO_GAMEDATA', 'AUDIO_SOUNDDATA', 'AUDIO_SPEECHDATA',
    'AUDIO_SYNTHDATA', 'AUDIO_WAVEPACK', 'CARCOLS_FILE', 'CARCONTENTUNLOCKS_FILE', 'CARMODCOLS_FILE', 'CLIP_SETS_FILE', 'CONTENT_UNLOCKING_META_FILE',
    'DLC_ITYP_REQUEST', 'DLC_POP_GROUPS', 'DLC_SCRIPT_METAFILE', 'DLC_TEXT_FILE', 'DLC_WEAPON_PICKUPS', 'EXPLOSION_INFO_FILE', 'EXPRESSION_SETS_FILE',
    'EXTRA_FOLDER_MOUNT_DATA', 'EXTRA_TITLE_UPDATE_DATA', 'FIVEM_LOVES_YOU_4B38E96CC036038F', 'FIVEM_LOVES_YOU_341B23A2F0E0F131', 'GTXD_PARENTING_DATA',
    'HANDLING_FILE', 'INTERIOR_PROXY_ORDER_FILE', 'LOADOUTS_FILE', 'MAPZOOM_FILE', 'PED_BOUNDS_FILE', 'PED_COMPONENT_SETS_FILE', 'PED_DAMAGE_APPEND_FILE',
    'PED_DAMAGE_OVERRIDE_FILE', 'PED_FIRST_PERSON_ALTERNATE_DATA', 'PED_METADATA_FILE', 'PED_OVERLAY_FILE', 'PED_PERSONALITY_FILE', 'PED_TASK_DATA_FILE',
    'PEDSTREAM_FILE', 'POPGRP_FILE', 'POPSCHED_FILE', 'RPF_FILE', 'SCENARIO_INFO_FILE', 'SCENARIO_INFO_OVERRIDE_FILE', 'SCENARIO_POINTS_FILE',
    'SCENARIO_POINTS_OVERRIDE_FILE', 'SCENARIO_POINTS_PSO_FILE', 'SCENARIO_POINTS_OVERRIDE_PSO_FILE', 'SHOP_PED_APPAREL_META_FILE', 'TATTOO_SHOP_DLC_FILE',
    'TEXTFILE_METAFILE', 'TIMECYCLEMOD_FILE', 'VEHICLE_LAYOUTS_FILE', 'VEHICLE_METADATA_FILE', 'VEHICLE_POPULATION_FILE', 'VEHICLE_SHOP_DLC_FILE',
    'VEHICLE_VARIATION_FILE', 'VFX_SETTINGS_FILE', 'VFXFOGVOLUMEINFO_FILE', 'VFXINTERIORINFO_FILE', 'VFXPEDINFO_FILE', 'VFXREGIONINFO_FILE',
    'VFXVEHICLEINFO_FILE', 'VFXWEAPONINFO_FILE', 'WEAPON_ANIMATIONS_FILE', 'WEAPON_METADATA_FILE', 'WEAPON_SHOP_INFO', 'WEAPONCOMPONENTSINFO_FILE',
    'WEAPONFX_FILE', 'WEAPONINFO_FILE', 'ZONEBIND_FILE',
];
const AUDIO_SUFFIXES: Record<string, string> = { AUDIO_GAMEDATA: '151.rel', AUDIO_SOUNDDATA: '54.rel', AUDIO_SYNTHDATA: '10.rel', AUDIO_DYNAMIXDATA: '15.rel', AUDIO_SPEECHDATA: '4.rel' };

interface ResourceFile { path: string; size: number }

function editDistance(a: string, b: string, limit: number): number {
    if (Math.abs(a.length - b.length) > limit) { return limit + 1; }
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i++) {
        const next = [i];
        for (let j = 1; j <= b.length; j++) {
            next[j] = Math.min(previous[j] + 1, next[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        previous = next;
    }
    return previous[b.length];
}

/** A known data file type that `type` is at most two edits away from, when `type` itself is not known. */
export function similarDataFileType(type: string): string | undefined {
    const wanted = type.toUpperCase();
    if (DATA_FILE_TYPES.includes(wanted)) { return undefined; }
    return DATA_FILE_TYPES.find((known) => editDistance(wanted, known, 2) <= 2);
}

/** The files of a resource by forward-slash path, without symbolic links and tool folders. */
async function listFiles(root: string): Promise<{ files: ResourceFile[]; incomplete: boolean }> {
    const files: ResourceFile[] = [], pending = [''];
    for (let folder = pending.pop(); folder !== undefined; folder = pending.pop()) {
        const entries = await fs.readdir(path.join(root, folder), { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            const relative = folder ? `${folder}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                if (!EXCLUDED.has(entry.name.toLowerCase())) { pending.push(relative); }
            } else if (entry.isFile()) {
                if (files.length >= MAX_CHECK_FILES) { return { files, incomplete: true }; }
                files.push({ path: relative, size: -1 });
            }
        }
    }
    return { files, incomplete: false };
}

function child(element: XmlElement | undefined, name: string): XmlElement | undefined {
    return element?.children.find((candidate) => candidate.name === name);
}

function childText(element: XmlElement | undefined, name: string): string {
    return child(element, name)?.text.trim() ?? '';
}

function items(element: XmlElement | undefined): XmlElement[] {
    return element?.children.filter((candidate) => candidate.name === 'Item') ?? [];
}

function descendants(element: XmlElement, visit: (element: XmlElement) => void): void {
    const pending = [element];
    for (let current = pending.pop(); current; current = pending.pop()) {
        visit(current);
        pending.push(...current.children);
    }
}

/** The zero-based line where `<tag>value</tag>`, or else `value`, first appears in `source`. */
function lineOf(source: string, value: string, tag?: string): number | undefined {
    const tagged = tag ? source.search(new RegExp(`<${tag}(?:\\s[^>]*)?>\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*<`, 'i')) : -1;
    const at = tagged >= 0 ? tagged : source.toLowerCase().indexOf(value.toLowerCase());
    return at < 0 ? undefined : source.slice(0, at).split('\n').length - 1;
}

interface MetaFile { file: string; source: string; root: XmlElement }

/**
 * Checks one resource: its data file declarations against the files on disk, its vehicle and
 * weapon metadata against each other and against what it streams, and its use of Asset Escrow.
 */
export async function checkResource(target: CheckTarget): Promise<{ findings: CheckFinding[]; facts: ResourceFacts }> {
    const findings: CheckFinding[] = [];
    const report = (severity: CheckSeverity, category: CheckCategory, message: string, file?: string, line?: number): void => {
        findings.push({ severity, category, resource: target.name, message, file, line });
    };
    const { files, incomplete } = await listFiles(target.root);
    const paths = files.map((file) => file.path);
    const lowerPaths = new Set(paths.map((file) => file.toLowerCase()));
    const absolute = (relative: string) => path.join(target.root, ...relative.split('/'));
    const facts: ResourceFacts = { name: target.name, root: target.root, stream: [], vehicleModels: [], modKits: [], sirens: [], escrowed: lowerPaths.has('.fxap'), encryptedFiles: 0, incomplete };
    if (incomplete) {
        report('info', 'stream', `Only the first ${MAX_CHECK_FILES.toLocaleString()} files of this resource were checked.`, target.manifest);
    }

    let manifest: ManifestEntry[] = [];
    try {
        manifest = parseManifest(await fs.readFile(target.manifest, 'utf8'));
    } catch (error) {
        report('error', 'data file', `The manifest could not be read: ${error instanceof Error ? error.message : String(error)}`, target.manifest);
    }
    const matching = (pattern: string): string[] => {
        const clean = pattern.replace(/^\.?\//, '');
        return /[*?]/.test(clean) ? paths.filter((file) => assetGlobMatches(clean, file)) : lowerPaths.has(clean.toLowerCase()) ? [paths.find((file) => file.toLowerCase() === clean.toLowerCase())!] : [];
    };

    // Streamed files, with the memory the game reserves for each resource container.
    const streamed = files.filter((file) => /^stream\//i.test(file.path));
    await inBatches(streamed, 16, async (file) => {
        const full = absolute(file.path), extension = path.extname(file.path).toLowerCase();
        const asset: StreamedAsset = { resource: target.name, name: path.basename(file.path).toLowerCase(), file: full, size: 0 };
        try {
            asset.size = (await fs.stat(full)).size;
            if (RESOURCE_CONTAINERS.has(extension)) {
                const header = await readHead(full, 16);
                const inspected = header.length >= 16 ? inspectResourceHeader(header) : undefined;
                asset.physical = inspected?.graphicsBytes;
            }
        } catch { /* A file that vanished or cannot be read still counts by name. */ }
        facts.stream.push(asset);
    });
    const streamNames = new Set(facts.stream.map((asset) => asset.name));
    const streams = (extension: string) => facts.stream.some((asset) => asset.name.endsWith(extension));

    // Data file declarations.
    const fileGlobs = manifestValues(manifest, 'file', 'files').map((value) => value.text.replace(/^\.?\//, ''));
    const metas = new Map<string, MetaFile[]>();
    for (const entry of manifest.filter((candidate) => candidate.name === 'data_file' || candidate.name === 'data_files')) {
        const [type, ...targets] = entry.values;
        if (!type) { continue; }
        const similar = similarDataFileType(type.text);
        if (similar) {
            report('warning', 'data file', `data_file type '${type.text}' is not one the game reads. Did you mean '${similar}'?`, target.manifest, type.line);
        }
        if (targets.length === 0) {
            report('warning', 'data file', `data_file '${type.text}' names no file.`, target.manifest, type.line);
        }
        for (const declared of targets) {
            const matched = dataFileMatches(type.text.toUpperCase(), declared, paths, matching);
            if (matched === undefined) { continue; }
            if (matched.length === 0) {
                report('warning', 'data file', `data_file '${type.text}' points at '${declared.text}', which matches no file in this resource.`, target.manifest, declared.line);
                continue;
            }
            const unsent = matched.filter((file) => !/^stream\//i.test(file) && !fileGlobs.some((glob) => assetGlobMatches(glob, file) || glob.toLowerCase() === file.toLowerCase()));
            if (unsent.length > 0) {
                report('warning', 'data file', `'${unsent[0]}' is a data_file but no files entry sends it to clients, so the game never loads it.`, target.manifest, declared.line);
            }
            if (!/\.(meta|xml)$/i.test(declared.text)) { continue; }
            for (const file of matched.slice(0, 64)) {
                const meta = await readMeta(absolute(file), (message) => report('error', 'data file', message, absolute(file)));
                if (meta) { metas.set(type.text.toUpperCase(), [...(metas.get(type.text.toUpperCase()) ?? []), meta]); }
            }
        }
    }

    checkVehicles(metas, { report, facts, streamNames, streams, target });
    checkWeapons(metas, { report, streamNames, streams });

    // Asset Escrow.
    const ignored = manifestValues(manifest, 'escrow_ignore');
    for (const pattern of ignored) {
        if (matching(pattern.text).length === 0) {
            report('warning', 'escrow', `escrow_ignore '${pattern.text}' matches no file, so nothing is left readable by it.`, target.manifest, pattern.line);
        }
    }
    if (ignored.length > 0 && !manifestValues(manifest, 'lua54').some((value) => value.text === 'yes')) {
        report('warning', 'escrow', "Asset Escrow needs lua54 'yes' in the manifest.", target.manifest, ignored[0].line);
    }
    if (facts.escrowed) {
        const lua = files.filter((file) => /\.lua$/i.test(file.path)).slice(0, 2000);
        await inBatches(lua, 16, async (file) => {
            if ((await readHead(absolute(file.path), 4).catch(() => Buffer.alloc(0))).toString('latin1') === 'FXAP') { facts.encryptedFiles++; }
        });
        report('info', 'escrow', `Protected by Asset Escrow: ${facts.encryptedFiles} encrypted Lua ${facts.encryptedFiles === 1 ? 'file' : 'files'} cannot be read, checked or edited.`, target.manifest);
    }
    return { findings, facts };
}

/**
 * The files a data file declaration resolves to, or nothing where that cannot be told. Audio
 * declarations name a bank without the suffix of its file, or a folder of wave packs.
 */
function dataFileMatches(type: string, declared: ManifestValue, paths: readonly string[], matching: (pattern: string) => string[]): string[] | undefined {
    const clean = declared.text.replace(/^\.?\//, '').toLowerCase();
    if (type === 'AUDIO_WAVEPACK') {
        return paths.filter((file) => file.toLowerCase().startsWith(`${clean.replace(/\/$/, '')}/`)).slice(0, 1);
    }
    if (type.startsWith('AUDIO_')) {
        const suffix = AUDIO_SUFFIXES[type];
        return paths.filter((file) => file.toLowerCase() === clean || (suffix !== undefined && file.toLowerCase() === clean + suffix) || file.toLowerCase().startsWith(`${clean}.`) || (suffix === undefined && file.toLowerCase().startsWith(clean)));
    }
    return type === 'RPF_FILE' ? undefined : matching(declared.text);
}

async function readHead(file: string, length: number): Promise<Buffer> {
    const handle = await fs.open(file, 'r');
    try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, 0);
        return buffer.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

async function readMeta(file: string, problem: (message: string) => void): Promise<MetaFile | undefined> {
    try {
        const stat = await fs.stat(file);
        if (stat.size > MAX_META_BYTES) {
            problem(`This metadata file is larger than ${MAX_META_BYTES / 1024 / 1024} MiB and was not checked.`);
            return undefined;
        }
        const source = await fs.readFile(file, 'utf8');
        return { file, source, root: parseXml(source) };
    } catch (error) {
        problem(`This metadata file is not well-formed XML, so the game ignores it: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
}

async function inBatches<T>(values: readonly T[], size: number, run: (value: T) => Promise<void>): Promise<void> {
    for (let at = 0; at < values.length; at += size) {
        await Promise.all(values.slice(at, at + size).map(run));
    }
}

interface CheckContext {
    report: (severity: CheckSeverity, category: CheckCategory, message: string, file?: string, line?: number) => void;
    streamNames: Set<string>;
    streams: (extension: string) => boolean;
}

function checkVehicles(metas: Map<string, MetaFile[]>, context: CheckContext & { facts: ResourceFacts; target: CheckTarget }): void {
    const { report, facts, streamNames, streams, target } = context;
    const handling = new Set<string>(), variations = new Map<string, { meta: MetaFile; kits: string[] }>(), kits = new Set<string>();
    for (const meta of metas.get('HANDLING_FILE') ?? []) {
        for (const item of items(child(meta.root, 'HandlingData'))) {
            const name = childText(item, 'handlingName');
            if (name) { handling.add(name.toLowerCase()); }
        }
    }
    for (const meta of metas.get('CARCOLS_FILE') ?? []) {
        for (const item of items(child(meta.root, 'Kits'))) {
            const name = childText(item, 'kitName'), id = child(item, 'id')?.attributes.value?.trim();
            if (name) { kits.add(name.toLowerCase()); }
            if (id && name.toLowerCase() !== '0_default_modkit') {
                facts.modKits.push({ resource: target.name, id, name, file: meta.file, line: lineOf(meta.source, name, 'kitName') });
            }
        }
        for (const item of items(child(meta.root, 'Sirens'))) {
            const id = child(item, 'id')?.attributes.value?.trim(), name = childText(item, 'name');
            if (id && id !== '0') {
                facts.sirens.push({ resource: target.name, id, name: name || `siren ${id}`, file: meta.file, line: name ? lineOf(meta.source, name, 'name') : undefined });
            }
        }
    }
    for (const meta of metas.get('VEHICLE_VARIATION_FILE') ?? []) {
        for (const item of items(child(meta.root, 'variationData'))) {
            const model = childText(item, 'modelName');
            if (model) { variations.set(model.toLowerCase(), { meta, kits: items(child(item, 'kits')).map((kit) => kit.text.trim()).filter(Boolean) }); }
        }
    }
    const vehicles = metas.get('VEHICLE_METADATA_FILE') ?? [];
    const models = new Set<string>();
    for (const meta of vehicles) {
        for (const item of items(child(meta.root, 'InitDatas'))) {
            const model = childText(item, 'modelName');
            if (!model) { continue; }
            const line = lineOf(meta.source, model, 'modelName'), key = model.toLowerCase();
            models.add(key);
            facts.vehicleModels.push({ resource: target.name, id: key, name: model, file: meta.file, line });
            if (streams('.yft') && !streamNames.has(`${key}.yft`)) {
                report('warning', 'vehicle', `vehicles.meta lists ${model}, but this resource streams no ${key}.yft.`, meta.file, line);
            }
            const txd = childText(item, 'txdName').toLowerCase();
            if (txd && streams('.ytd') && streams('.yft') && !streamNames.has(`${txd}.ytd`) && !/^veh(?:share|icles)/.test(txd)) {
                report('warning', 'vehicle', `${model} uses the texture dictionary ${txd}, but this resource streams no ${txd}.ytd.`, meta.file, lineOf(meta.source, txd, 'txdName') ?? line);
            }
            const handlingId = childText(item, 'handlingId');
            if (handlingId && handling.size > 0 && !handling.has(handlingId.toLowerCase())) {
                report('warning', 'vehicle', `${model} uses handling ${handlingId}, which no handling.meta of this resource defines. Unless the game has handling of that name, the vehicle does not spawn.`, meta.file, lineOf(meta.source, handlingId, 'handlingId') ?? line);
            }
            if (variations.size > 0 && !variations.has(key)) {
                report('warning', 'vehicle', `${model} has no entry in carvariations.meta, so it spawns without its colours, liveries and mod kit.`, meta.file, line);
            }
        }
    }
    for (const [model, { meta, kits: used }] of variations) {
        if (vehicles.length > 0 && !models.has(model)) {
            report('info', 'vehicle', `carvariations.meta has an entry for ${model}, which vehicles.meta of this resource does not list.`, meta.file, lineOf(meta.source, model, 'modelName'));
        }
        for (const kit of used) {
            if (kits.size > 0 && kit.toLowerCase() !== '0_default_modkit' && !kits.has(kit.toLowerCase())) {
                report('warning', 'vehicle', `${model} uses the mod kit ${kit}, which no carcols.meta of this resource defines.`, meta.file, lineOf(meta.source, kit));
            }
        }
    }
}

function checkWeapons(metas: Map<string, MetaFile[]>, context: CheckContext): void {
    const { report, streamNames, streams } = context;
    const archetypes = new Set<string>();
    for (const meta of metas.get('WEAPON_METADATA_FILE') ?? []) {
        for (const item of items(child(meta.root, 'InitDatas'))) {
            const model = childText(item, 'modelName');
            if (!model) { continue; }
            const key = model.toLowerCase(), line = lineOf(meta.source, model, 'modelName');
            archetypes.add(key);
            if (streams('.ydr') && !streamNames.has(`${key}.ydr`)) {
                report('warning', 'weapon', `weaponarchetypes.meta lists ${model}, but this resource streams no ${key}.ydr.`, meta.file, line);
            }
            const txd = childText(item, 'txdName').toLowerCase();
            if (txd && streams('.ytd') && streams('.ydr') && !streamNames.has(`${txd}.ytd`)) {
                report('warning', 'weapon', `${model} uses the texture dictionary ${txd}, but this resource streams no ${txd}.ytd.`, meta.file, lineOf(meta.source, txd, 'txdName') ?? line);
            }
        }
    }
    for (const type of ['WEAPONINFO_FILE', 'WEAPONCOMPONENTSINFO_FILE']) {
        for (const meta of metas.get(type) ?? []) {
            descendants(meta.root, (element) => {
                const kind = element.attributes.type ?? '';
                if (element.name !== 'Item' || !/^CWeapon(?:Info|Component)/.test(kind)) { return; }
                const name = childText(element, 'Name'), model = childText(element, 'Model').toLowerCase();
                if (name && model && archetypes.size > 0 && !archetypes.has(model) && !streamNames.has(`${model}.ydr`)) {
                    report('warning', 'weapon', `${name} uses the model ${model}, which this resource neither streams nor lists in weaponarchetypes.meta.`, meta.file, lineOf(meta.source, model, 'Model'));
                }
            });
        }
    }
}

function megabytes(bytes: number): string {
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/**
 * The checks that compare resources: files that two resources stream under one name, vehicle
 * models, mod kit and siren identifiers that two resources define, and assets too large to stream
 * reliably.
 */
export function crossResourceFindings(facts: readonly ResourceFacts[]): CheckFinding[] {
    const findings: CheckFinding[] = [];
    const byName = new Map<string, StreamedAsset[]>();
    for (const asset of facts.flatMap((resource) => resource.stream)) {
        byName.set(asset.name, [...(byName.get(asset.name) ?? []), asset]);
        const memory = asset.physical ?? 0;
        if (memory >= OVERSIZED_ASSET_BYTES) {
            findings.push({ severity: memory >= HUGE_ASSET_BYTES ? 'error' : 'warning', category: 'stream', resource: asset.resource, file: asset.file,
                message: `${asset.name} needs ${megabytes(memory)} of physical memory. The game warns from ${megabytes(OVERSIZED_ASSET_BYTES)}: such assets load late or not at all. Use smaller textures or split the file.` });
        }
    }
    for (const [name, assets] of byName) {
        const resources = [...new Set(assets.map((asset) => asset.resource))];
        if (assets.length > 1) {
            findings.push({ severity: 'warning', category: 'stream', resource: resources.join(', '), file: assets[0].file,
                message: resources.length > 1
                    ? `${name} is streamed by ${resources.length} resources (${resources.slice(0, 5).join(', ')}). Only one of them is used, and which one depends on the start order.`
                    : `${name} is streamed ${assets.length} times by this resource. Only one of the files is used.` });
        }
    }
    const duplicates = (items: IdentifiedItem[], describe: (id: string, owners: IdentifiedItem[]) => string, category: CheckCategory): void => {
        const byId = new Map<string, IdentifiedItem[]>();
        for (const item of items) { byId.set(item.id, [...(byId.get(item.id) ?? []), item]); }
        for (const [id, owners] of byId) {
            if (new Set(owners.map((owner) => owner.resource)).size > 1) {
                findings.push({ severity: 'warning', category, resource: [...new Set(owners.map((owner) => owner.resource))].join(', '), file: owners[0].file, line: owners[0].line, message: describe(id, owners) });
            }
        }
    };
    const owners = (items: IdentifiedItem[]) => [...new Set(items.map((item) => item.resource))].slice(0, 5).join(', ');
    duplicates(facts.flatMap((resource) => resource.vehicleModels), (id, items) => `The vehicle model ${id} is defined by ${owners(items)}. Only one definition is used.`, 'vehicle');
    duplicates(facts.flatMap((resource) => resource.modKits), (id, items) => `Mod kit id ${id} is used by ${owners(items)} (${items.slice(0, 3).map((item) => item.name).join(', ')}). Vehicles that share an id get each other's parts; give each kit an id of its own.`, 'vehicle');
    duplicates(facts.flatMap((resource) => resource.sirens), (id, items) => `Siren id ${id} is used by ${owners(items)}. Vehicles that share an id get the same siren lights; give each setting an id of its own.`, 'vehicle');
    return findings;
}

/** Checks `targets` a few at a time, then compares them. `isCurrent` turning false ends the run early. */
export async function checkResources(targets: readonly CheckTarget[], isCurrent: () => boolean = () => true, progress?: (done: number) => void): Promise<CheckResult> {
    const findings: CheckFinding[] = [], facts: ResourceFacts[] = [];
    let done = 0;
    await inBatches(targets, 4, async (target) => {
        if (!isCurrent()) { return; }
        try {
            const result = await checkResource(target);
            findings.push(...result.findings);
            facts.push(result.facts);
        } catch (error) {
            findings.push({ severity: 'error', category: 'data file', resource: target.name, file: target.manifest, message: `This resource could not be checked: ${error instanceof Error ? error.message : String(error)}` });
        }
        progress?.(++done);
    });
    facts.sort((a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root));
    findings.push(...crossResourceFindings(facts));
    const order: Record<CheckSeverity, number> = { error: 0, warning: 1, info: 2 };
    findings.sort((a, b) => order[a.severity] - order[b.severity] || a.resource.localeCompare(b.resource) || a.message.localeCompare(b.message));
    return { findings, facts };
}
