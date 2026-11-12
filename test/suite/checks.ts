import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkReportView, localeReportView } from '../../src/checkReport';
import { localeMatrix, readLocales } from '../../src/localeMatrix';
import { luaStringTable, luaTokens, manifestValues, parseManifest } from '../../src/manifestLite';
import { ReferenceCatalogs, withCatalogs, type CatalogData } from '../../src/referenceCatalogs';
import { MAX_REPORT_ROWS, boundedRows } from '../../src/reportTypes';
import { checkResources, similarDataFileType, type CheckFinding } from '../../src/resourceChecks';
import { logSeverity } from '../../src/runtimeLogParser';
import { CFG_ENTRIES, cfgPosition, checkCfg, looksLikeServerCfg, parseCfg, resourceDependencies } from '../../src/serverCfg';

type Test = [name: string, body: () => void | Promise<void>];

async function temporary(run: (root: string) => Promise<void>): Promise<void> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qbx-editor-checks-'));
    try { await run(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

async function write(root: string, files: Record<string, string | Buffer>): Promise<void> {
    for (const [relative, contents] of Object.entries(files)) {
        const file = path.join(root, ...relative.split('/'));
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, contents);
    }
}

/** The header of a resource container whose graphics pages need `graphicsFlags` worth of memory. */
function container(graphicsFlags: number): Buffer {
    const header = Buffer.alloc(32);
    header.write('RSC7', 0, 'latin1');
    header.writeUInt32LE(13, 4);
    header.writeUInt32LE(1 << 27, 8);
    header.writeUInt32LE(graphicsFlags, 12);
    return header;
}
const SMALL = 1 << 27;
/** 256 pages of 128 KiB: 32 MiB. */
const LARGE = 8 | (1 << 4);

function vehicles(...models: [model: string, txd: string, handling: string][]): string {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<CVehicleModelInfo__InitDataList>\n  <residentTxd>vehshare</residentTxd>\n  <InitDatas>\n${models.map(([model, txd, handling]) =>
        `    <Item>\n      <modelName>${model}</modelName>\n      <txdName>${txd}</txdName>\n      <handlingId>${handling}</handlingId>\n    </Item>`).join('\n')}\n  </InitDatas>\n</CVehicleModelInfo__InitDataList>\n`;
}

function carcols(kit: string, kitId: number, sirenId: number): string {
    return `<CVehicleModelInfoVarGlobal>\n  <Kits>\n    <Item>\n      <kitName>${kit}</kitName>\n      <id value="${kitId}" />\n    </Item>\n  </Kits>\n  <Sirens>\n    <Item>\n      <id value="${sirenId}" />\n      <name>police</name>\n    </Item>\n  </Sirens>\n</CVehicleModelInfoVarGlobal>\n`;
}

const tests: Test[] = [
    ['Lua tokens skip comments and long brackets and keep the lines of strings', () => {
        const tokens = luaTokens("-- first\n--[[ block\ncomment ]] name 'a\\'b' --[==[ x ]==]\n[[long\nstring]] 0x1F .. 'end'");
        assert.deepEqual(tokens.map((token) => `${token.kind}:${token.text}@${token.line}`), [
            'name:name@2', "string:a'b@2", 'string:long\nstring@3', 'number:0x1F@4', 'symbol:..@4', 'string:end@4',
        ]);
    }],
    ['manifest directives are read in their plain, table, called and curried forms', () => {
        const entries = parseManifest([
            "fx_version 'cerulean'",
            "local version = '1.0.0' -- not a directive",
            'files {',
            "    'data/*.meta', -- comment",
            "    \"html/index.html\",",
            '}',
            "data_file 'HANDLING_FILE' 'data/handling.meta'",
            "data_file('CARCOLS_FILE')('data/carcols.meta')",
            "dependencies { '/server:5181', ['key'] = 'ox_lib' }",
            "lua54 'yes'",
            "if GetConvar('x', '') == '' then print('ignored') end",
        ].join('\n'));
        assert.deepEqual(manifestValues(entries, 'fx_version').map((value) => value.text), ['cerulean']);
        assert.deepEqual(manifestValues(entries, 'file', 'files'), [{ text: 'data/*.meta', line: 3 }, { text: 'html/index.html', line: 4 }]);
        assert.deepEqual(entries.filter((entry) => entry.name === 'data_file').map((entry) => entry.values.map((value) => value.text)), [
            ['HANDLING_FILE', 'data/handling.meta'], ['CARCOLS_FILE', 'data/carcols.meta'],
        ]);
        assert.deepEqual(manifestValues(entries, 'dependencies').map((value) => value.text), ['/server:5181', 'ox_lib'], 'a key in brackets is not a value');
        assert.ok(!entries.some((entry) => entry.name === 'version'), 'a local is no directive');
    }],
    ['Lua locale tables flatten nested keys and keep only string literals', () => {
        const table = luaStringTable([
            "local Translations = {",
            "    error = { not_found = 'Not found', ['with space'] = \"Spaced\" },",
            "    count = 3,",
            "    joined = 'first' .. tostring(2),",
            "    nested = { deep = { value = [[long]] } },",
            "    callback = function() return { ignored = 'x' } end,",
            '}',
            "Locales['de'] = { greeting = 'Hallo' }",
        ].join('\n'));
        assert.deepEqual([...table.keys()].sort(), ['error.not_found', 'error.with space', 'greeting', 'joined', 'nested.deep.value']);
        assert.equal(table.get('joined')?.value, 'first');
        assert.equal(table.get('error.not_found')?.line, 1);
    }],
    ['data file types written almost right are recognized; right and unknown ones are left alone', () => {
        assert.equal(similarDataFileType('VEHICLE_LAYOUT_FILE'), 'VEHICLE_LAYOUTS_FILE');
        assert.equal(similarDataFileType('HANDLING_FILES'), 'HANDLING_FILE');
        assert.equal(similarDataFileType('handling_file'), undefined);
        assert.equal(similarDataFileType('MY_OWN_RESOURCE_DATA'), undefined);
    }],
    ['vehicle metadata is checked against itself, the streamed files and the other resources', () => temporary(async (root) => {
        await write(root, {
            'addon_car/fxmanifest.lua': [
                "fx_version 'cerulean'", "game 'gta5'",
                "files { 'data/vehicles.meta', 'data/carvariations.meta', 'data/carcols.meta' }",
                "data_file 'HANDLING_FILE' 'data/handling.meta'",
                "data_file 'VEHICLE_METADATA_FILE' 'data/vehicles.meta'",
                "data_file 'CARCOLS_FILE' 'data/carcols.meta'",
                "data_file 'VEHICLE_VARIATION_FILE' 'data/carvariations.meta'",
                "data_file 'VEHICLE_LAYOUT_FILE' 'data/missing.meta'",
                "escrow_ignore { 'config.lua', 'nothing/*.lua' }",
            ].join('\n'),
            'addon_car/config.lua': 'return {}\n',
            'addon_car/data/vehicles.meta': vehicles(['mycar', 'mycar', 'MYCAR'], ['ghost', 'ghost', 'NOPE']),
            'addon_car/data/handling.meta': '<CHandlingDataMgr><HandlingData><Item type="CHandlingData"><handlingName>MYCAR</handlingName></Item></HandlingData></CHandlingDataMgr>',
            'addon_car/data/carvariations.meta': '<CVehicleModelInfoVariation><variationData>'
                + '<Item><modelName>mycar</modelName><kits><Item>500_mycar_modkit</Item><Item>999_missing_modkit</Item></kits></Item>'
                + '<Item><modelName>stray</modelName><kits><Item>0_default_modkit</Item></kits></Item></variationData></CVehicleModelInfoVariation>',
            'addon_car/data/carcols.meta': carcols('500_mycar_modkit', 500, 77),
            'addon_car/stream/mycar.yft': container(SMALL),
            'addon_car/stream/mycar.ytd': container(SMALL),
            'addon_car/stream/Shared.ytd': container(LARGE),
            'other_car/fxmanifest.lua': "fx_version 'cerulean'\ngame 'gta5'\nlua54 'yes'\nfiles { 'vehicles.meta', 'carcols.meta' }\ndata_file 'VEHICLE_METADATA_FILE' 'vehicles.meta'\ndata_file 'CARCOLS_FILE' 'carcols.meta'\n",
            'other_car/vehicles.meta': vehicles(['MyCar', 'mycar', 'MYCAR']),
            'other_car/carcols.meta': carcols('500_other_modkit', 500, 77),
            'other_car/stream/nested/shared.ytd': container(SMALL),
            'broken/fxmanifest.lua': "fx_version 'cerulean'\nfiles { 'handling.meta' }\ndata_file 'HANDLING_FILE' 'handling.meta'\n",
            'broken/handling.meta': '<CHandlingDataMgr><HandlingData></CHandlingDataMgr>',
        });
        const targets = ['addon_car', 'other_car', 'broken'].map((name) => ({ name, root: path.join(root, name), manifest: path.join(root, name, 'fxmanifest.lua') }));
        const progress: number[] = [];
        const { findings, facts } = await checkResources(targets, () => true, (done) => progress.push(done));
        assert.deepEqual(progress, [1, 2, 3]);
        const has = (resource: string, pattern: RegExp, severity?: CheckFinding['severity']): CheckFinding => {
            const found = findings.find((finding) => finding.resource.includes(resource) && pattern.test(finding.message) && (!severity || finding.severity === severity));
            assert.ok(found, `${resource}: ${pattern} not in\n${findings.map((finding) => `${finding.severity} ${finding.resource}: ${finding.message}`).join('\n')}`);
            return found;
        };
        const unsent = has('addon_car', /data\/handling\.meta' is a data_file but no files entry sends it/, 'warning');
        assert.equal(unsent.file, targets[0].manifest);
        assert.equal(unsent.line, 3, 'the finding sits on the line of the declaration');
        has('addon_car', /'VEHICLE_LAYOUT_FILE' is not one the game reads\. Did you mean 'VEHICLE_LAYOUTS_FILE'/);
        has('addon_car', /'data\/missing\.meta', which matches no file/);
        const ghost = has('addon_car', /lists ghost, but this resource streams no ghost\.yft/);
        assert.equal(ghost.file, path.join(root, 'addon_car', 'data', 'vehicles.meta'));
        assert.equal(ghost.line, 10, 'the line of the second modelName');
        has('addon_car', /ghost uses the texture dictionary ghost/);
        has('addon_car', /ghost uses handling NOPE, which no handling\.meta of this resource defines/);
        has('addon_car', /ghost has no entry in carvariations\.meta/);
        has('addon_car', /entry for stray, which vehicles\.meta of this resource does not list/, 'info');
        has('addon_car', /mycar uses the mod kit 999_missing_modkit/);
        has('addon_car', /escrow_ignore 'nothing\/\*\.lua' matches no file/);
        has('addon_car', /Asset Escrow needs lua54 'yes'/);
        assert.ok(!findings.some((finding) => /lists mycar, but/.test(finding.message)), 'a model that is streamed is fine');
        assert.ok(!findings.some((finding) => /escrow_ignore 'config\.lua'/.test(finding.message)));
        has('broken', /not well-formed XML/, 'error');

        has('addon_car, other_car', /shared\.ytd is streamed by 2 resources/);
        has('addon_car, other_car', /vehicle model mycar is defined by addon_car, other_car/);
        has('addon_car, other_car', /Mod kit id 500 is used by addon_car, other_car \(500_mycar_modkit, 500_other_modkit\)/);
        has('addon_car, other_car', /Siren id 77/);
        has('addon_car', /shared\.ytd needs 32\.0 MiB of physical memory/, 'warning');
        assert.deepEqual(findings.map((finding) => finding.severity), [...findings.map((finding) => finding.severity)].sort((a, b) => 'ewi'.indexOf(a[0]) - 'ewi'.indexOf(b[0])), 'errors first');
        assert.deepEqual(facts.map((resource) => resource.name), ['addon_car', 'broken', 'other_car']);
        assert.equal(facts[0].stream.length, 3);

        const links: string[] = [];
        const view = checkReportView({ findings, facts }, 'three resources', (file, line) => { links.push(`${path.basename(file)}:${line ?? ''}`); return { id: String(links.length), label: path.basename(file) }; });
        assert.equal(view.stats[0].label, 'Errors');
        assert.equal(view.stats[0].value, '1');
        assert.equal(view.sections[0].rows.length, findings.length);
        assert.equal(view.sections[1].title, 'Largest streamed assets');
        assert.equal(view.sections[1].rows[0].cells[0], 'shared.ytd');
        assert.ok(links.includes('vehicles.meta:10'));
    })],
    ['weapon metadata is checked against the streamed models, and escrowed resources are counted', () => temporary(async (root) => {
        await write(root, {
            'gun/fxmanifest.lua': "fx_version 'cerulean'\ngame 'gta5'\nlua54 'yes'\nfiles { 'meta/*.meta' }\ndata_file 'WEAPON_METADATA_FILE' 'meta/weaponarchetypes.meta'\ndata_file 'WEAPONINFO_FILE' 'meta/weapons.meta'\nescrow_ignore 'config.lua'\n",
            'gun/config.lua': 'return {}\n',
            'gun/meta/weaponarchetypes.meta': '<CWeaponModelInfo__InitDataList><InitDatas><Item><modelName>w_pi_real</modelName><txdName>w_pi_real</txdName></Item>'
                + '<Item><modelName>w_pi_gone</modelName><txdName>w_pi_gone</txdName></Item></InitDatas></CWeaponModelInfo__InitDataList>',
            'gun/meta/weapons.meta': '<CWeaponInfoBlob><Infos><Item><Infos>'
                + '<Item type="CWeaponInfo"><Name>WEAPON_REAL</Name><Model>w_pi_real</Model></Item>'
                + '<Item type="CWeaponInfo"><Name>WEAPON_LOST</Name><Model>w_pi_nowhere</Model></Item>'
                + '<Item type="CAmmoInfo"><Name>AMMO_X</Name><Model>w_pi_nowhere</Model></Item></Infos></Item></Infos></CWeaponInfoBlob>',
            'gun/stream/w_pi_real.ydr': container(SMALL),
            'gun/stream/w_pi_real.ytd': container(SMALL),
            'locked/fxmanifest.lua': "fx_version 'cerulean'\ngame 'gta5'\nlua54 'yes'\nserver_script 'server.lua'\nescrow_ignore 'config.lua'\n",
            'locked/.fxap': 'x',
            'locked/config.lua': 'return {}\n',
            'locked/server.lua': Buffer.concat([Buffer.from('FXAP', 'latin1'), Buffer.from([1, 0, 0, 138, 145])]),
        });
        const targets = ['gun', 'locked'].map((name) => ({ name, root: path.join(root, name), manifest: path.join(root, name, 'fxmanifest.lua') }));
        const { findings, facts } = await checkResources(targets);
        const messages = findings.map((finding) => `${finding.resource}: ${finding.message}`);
        assert.ok(messages.some((message) => /gun: weaponarchetypes\.meta lists w_pi_gone, but this resource streams no w_pi_gone\.ydr/.test(message)), messages.join('\n'));
        assert.ok(messages.some((message) => /gun: WEAPON_LOST uses the model w_pi_nowhere/.test(message)), messages.join('\n'));
        assert.ok(!messages.some((message) => /WEAPON_REAL|AMMO_X|w_pi_real/.test(message)), messages.join('\n'));
        assert.ok(messages.some((message) => /locked: Protected by Asset Escrow: 1 encrypted Lua file cannot/.test(message)), messages.join('\n'));
        assert.deepEqual(facts.map((resource) => [resource.name, resource.escrowed, resource.encryptedFiles]), [['gun', false, 0], ['locked', true, 1]]);
        assert.ok(checkReportView({ findings, facts }, 'two', () => undefined).sections.some((section) => section.title === 'Asset Escrow'));
    })],
    ['an abandoned check stops before the remaining resources', () => temporary(async (root) => {
        await write(root, { 'a/fxmanifest.lua': "fx_version 'cerulean'\n", 'b/fxmanifest.lua': "fx_version 'cerulean'\n" });
        const targets = ['a', 'b'].map((name) => ({ name, root: path.join(root, name), manifest: path.join(root, name, 'fxmanifest.lua') }));
        const { facts } = await checkResources(targets, () => false);
        assert.equal(facts.length, 0);
    })],
    ['the locale matrix compares JSON and Lua languages with the base language', () => temporary(async (root) => {
        await write(root, {
            'locales/en.json': '{\n  "greeting": "Hello %s",\n  "menu": {\n    "open": "Open",\n    "close": "Close"\n  }\n}\n',
            'locales/fr.json': '{ "greeting": "Bonjour", "menu": { "open": "Ouvrir" }, "extra": "x" }',
            'locales/de.lua': "Locales['de'] = {\n    ['greeting'] = 'Hallo %s',\n    menu = { open = 'Oeffnen', close = \"Schliessen\" },\n}\n",
            'locales/bad.json': '{ "greeting": ',
            'locales/readme.txt': 'ignored',
        });
        const files = await readLocales(root);
        assert.deepEqual(files.map((file) => file.language), ['bad', 'de', 'en', 'fr']);
        assert.ok(files[0].problem, 'a file that is not JSON says so');
        const matrix = localeMatrix(files);
        assert.equal(matrix.base?.language, 'en');
        assert.deepEqual(matrix.missing.map((gap) => [gap.key, gap.languages, gap.line]), [['menu.close', ['fr'], 4]]);
        assert.deepEqual(matrix.placeholders.map((gap) => [gap.key, gap.languages]), [['greeting', ['fr']]]);
        assert.deepEqual([...matrix.extra], [['fr', ['extra']]]);
        const view = localeReportView([{ name: 'shop', matrix }], 'shop', (file, line) => ({ id: `${path.basename(file)}:${line ?? ''}`, label: path.basename(file) }));
        assert.equal(view.stats.find((stat) => stat.label === 'Missing translations')?.value, '1');
        const coverage = view.sections[0].rows.map((row) => row.cells.map((value) => (typeof value === 'string' ? value : value.text)));
        assert.deepEqual(coverage, [['shop', 'de', '3', '0', '0', '100%'], ['shop', 'en (base)', '3', '0', '0', '100%'], ['shop', 'fr', '3', '1', '1', '67%']]);
        assert.equal(view.sections[1].rows[0].link?.id, 'en.json:4');
        assert.ok(view.sections.some((section) => section.title === 'Files that could not be read'));
        assert.equal(localeMatrix([]).base, undefined);
    })],
    ['report tables are cut to their row limit and say how much they left out', () => {
        const rows = Array.from({ length: MAX_REPORT_ROWS + 5 }, (_, index) => ({ cells: [String(index)] }));
        assert.deepEqual(boundedRows(rows.slice(0, 3)), { rows: rows.slice(0, 3) });
        const cut = boundedRows(rows);
        assert.equal(cut.rows.length, MAX_REPORT_ROWS);
        assert.equal(cut.omitted, 5);
    }],
    ['server.cfg lines split into commands, with comments, quotes and semicolons', () => {
        const commands = parseCfg([
            '# a comment',
            'sv_hostname "My ^1Server; with # signs"  // trailing',
            'ensure ox_lib; ensure [qbx] # two commands',
            '   ',
            'set mysql_connection_string "mysql://u:p@localhost/db"',
        ].join('\n'));
        assert.deepEqual(commands.map((command) => [command.line, command.tokens.map((token) => token.text)]), [
            [1, ['sv_hostname', 'My ^1Server; with # signs']],
            [2, ['ensure', 'ox_lib']], [2, ['ensure', '[qbx]']],
            [4, ['set', 'mysql_connection_string', 'mysql://u:p@localhost/db']],
        ]);
        assert.deepEqual([commands[1].tokens[1].start, commands[1].tokens[1].end], [7, 13]);
        assert.ok(looksLikeServerCfg('endpoint_add_tcp "0.0.0.0:30120"\nensure chat\n'));
        assert.ok(!looksLikeServerCfg('[section]\nkey=value\nstart=1\n'), 'another kind of .cfg file is left alone');
        assert.deepEqual(resourceDependencies(['/server:5181', 'ox_lib', '/onesync', 'ox_lib', 'qbx_core']), ['ox_lib', 'qbx_core']);
    }],
    ['server.cfg checks compare what is started with the resources next to the file', () => {
        const resources = [
            { name: 'ox_lib', categories: ['[ox]'], dependencies: [] },
            { name: 'qbx_core', categories: ['[qbx]'], dependencies: ['ox_lib', 'oxmysql'] },
            { name: 'garage', categories: ['[local]'], dependencies: ['qbx_core', 'ox_target'] },
            { name: 'ox_target', categories: ['[ox]'], dependencies: [] },
            { name: 'doors', categories: ['[local]'], dependencies: ['ox_target'] },
        ];
        const commands = parseCfg(['exec permissions.cfg', 'exec missing.cfg', 'ensure garage', 'ensure qbx_core', 'ensure garage', 'ensure nope', 'ensure [missing]', 'ensure [ox]', 'stop whatever', 'ensure doors'].join('\n'));
        const problems = checkCfg(commands, { resources, fileExists: (relative) => relative === 'permissions.cfg' }).map((problem) => `${problem.line}:${problem.severity}:${problem.message}`);
        const expect = (pattern: RegExp): void => assert.ok(problems.some((problem) => pattern.test(problem)), `${pattern} not in\n${problems.join('\n')}`);
        expect(/^1:warning:missing\.cfg does not exist/);
        expect(/^2:info:garage depends on qbx_core, which is started later, on line 4/);
        expect(/^2:info:garage depends on ox_target, which is started later, on line 8/);
        expect(/^3:warning:qbx_core depends on oxmysql, which is not among the resources/);
        expect(/^4:info:garage is already started on line 3/);
        expect(/^5:warning:No resource named nope/);
        expect(/^6:warning:No resource folder is in a category named \[missing\]/);
        expect(/^3:info:qbx_core depends on ox_lib, which is started later, on line 8/);
        assert.ok(!problems.some((problem) => /permissions\.cfg|whatever|doors/.test(problem)), `a dependency that a category started earlier is fine\n${problems.join('\n')}`);
        assert.equal(problems.filter((problem) => /garage depends on ox_target/.test(problem)).length, 1, 'a second ensure of a resource repeats nothing');
        assert.deepEqual(checkCfg(commands, {}).map((problem) => problem.message).filter((message) => /No resource/.test(message)), [], 'without resources next to the file no name is doubted');
    }],
    ['server.cfg completion knows what each position of a line takes', () => {
        assert.deepEqual(cfgPosition('ens', 3), { kind: 'command', prefix: 'ens' });
        assert.deepEqual(cfgPosition('ensure ', 7), { kind: 'resource', prefix: '' });
        assert.deepEqual(cfgPosition('sv_hostname "x"; ensure qbx', 27), { kind: 'resource', prefix: 'qbx' });
        assert.deepEqual(cfgPosition('exec per', 8), { kind: 'file', prefix: 'per' });
        assert.deepEqual(cfgPosition('sets ', 5), { kind: 'variable', prefix: '' });
        assert.deepEqual(cfgPosition('set onesync o', 13), { kind: 'value', name: 'onesync', prefix: 'o' });
        assert.deepEqual(cfgPosition('sv_enforceGameBuild ', 20), { kind: 'value', name: 'sv_enforceGameBuild', prefix: '' });
        assert.deepEqual(cfgPosition('# ensure ', 9), { kind: 'none' });
        assert.deepEqual(cfgPosition('ensure garage extra', 19), { kind: 'none' });
        assert.ok(Object.values(CFG_ENTRIES).every((entry) => entry.summary.length > 20 && entry.summary.endsWith('.')));
    }],
    ['the bundled catalogs answer searches and details, and join the results of the language server', async () => {
        const data = JSON.parse(await fs.readFile(path.resolve(__dirname, '..', '..', '..', 'data', 'reference-catalogs.json'), 'utf8')) as CatalogData;
        assert.match(data.source.revision, /^[0-9a-f]{40}$/);
        const catalogs = new ReferenceCatalogs(data);
        assert.ok(catalogs.matches('', 'blip').length >= 900 && catalogs.matches('', 'vehicle').length >= 700 && catalogs.matches('', 'marker').length >= 40);
        assert.deepEqual(catalogs.matches('1', 'blip')[0], { id: 'blip:1', kind: 'blip', name: 'radar_level', side: 'client', numericId: 1 }, 'an exact ID leads');
        assert.equal(catalogs.matches('adder', 'all')[0].id, 'vehicle:adder');
        assert.ok(catalogs.matches('pistol', 'weapon').some((item) => item.id === 'weapon:WEAPON_PISTOL'));
        assert.equal(catalogs.matches('super adder', 'vehicle').length, 1, 'every word has to match, also the class');
        assert.deepEqual(catalogs.matches('zzzz-nothing', 'all'), []);
        const adder = catalogs.detail('vehicle:adder');
        assert.equal(adder?.insertText, '`adder`');
        assert.equal(adder?.copyText, 'adder');
        assert.match(adder?.documentation ?? '', /0xB779A091/, 'the documented hash of adder');
        assert.match(adder?.sourceUrl ?? '', /^https:\/\/docs\.fivem\.net\//);
        assert.equal(catalogs.detail('blip:1')?.insertText, '1');
        assert.equal(catalogs.detail('vehicle:not_a_model'), undefined);

        const natives = Array.from({ length: 60 }, (_, index) => ({ id: `native:Native${index}`, kind: 'native' as const, name: `Native${index}`, side: 'shared' as const }));
        const calls: string[] = [];
        const server = async <T>(method: string, params: unknown): Promise<T> => {
            calls.push(method);
            const { offset = 0, limit = 50 } = params as { offset?: number; limit?: number };
            return (method === 'qbx/referenceSearch' ? { items: natives.slice(offset, offset + limit), total: natives.length, offset, limit, namespaces: ['CFX'] } : { id: 'native:Native0' }) as T;
        };
        const request = withCatalogs(server, async () => catalogs);
        const local = catalogs.matches('', 'all').length;
        const first = await request<{ items: { id: string }[]; total: number }>('qbx/referenceSearch', { query: '', kind: 'all', side: 'all', namespace: '', offset: 0, limit: 50 });
        assert.equal(first.total, 60 + local);
        assert.ok(first.items.length === 50 && first.items.every((item) => item.id.startsWith('native:')), 'a full page of the server stays as it is');
        const second = await request<{ items: { id: string }[] }>('qbx/referenceSearch', { query: '', kind: 'all', side: 'all', namespace: '', offset: 50, limit: 50 });
        assert.deepEqual(second.items.slice(8, 12).map((item) => item.id), ['native:Native58', 'native:Native59', 'blip:0', 'blip:1'], 'the catalogs follow the last entries of the server');
        const third = await request<{ items: { id: string }[] }>('qbx/referenceSearch', { query: '', kind: 'all', side: 'all', namespace: '', offset: 100, limit: 50 });
        assert.equal(third.items[0].id, 'blip:40', 'later pages continue where the page before stopped');
        const sided = await request<{ total: number }>('qbx/referenceSearch', { query: '', kind: 'all', side: 'server', namespace: '', offset: 0, limit: 50 });
        assert.equal(sided.total, 60, 'a side filter is a question about natives only');
        calls.length = 0;
        const markers = await request<{ items: { id: string }[]; total: number }>('qbx/referenceSearch', { query: 'cylinder', kind: 'marker', offset: 0, limit: 50 });
        assert.ok(markers.items.some((item) => item.id === 'marker:1'));
        assert.equal((await request<{ id: string }>('qbx/referenceDetail', { id: 'marker:1' })).id, 'marker:1');
        assert.deepEqual(calls, [], 'a catalog of the extension needs no language server');
        assert.equal((await request<{ id: string }>('qbx/referenceDetail', { id: 'native:Native0' })).id, 'native:Native0');
        assert.equal(await request('qbx/referenceDetail', { id: 'vehicle:not_a_model' }), null);
    }],
    ['log lines are marked as errors or warnings by what the server prints', () => {
        for (const line of [
            '[    script:garage] SCRIPT ERROR: @garage/server/main.lua:12: attempt to index a nil value',
            "[    c-scripting-core] Error loading script server/main.lua in resource garage: garage/server/main.lua:3: unexpected symbol",
            "[             resources] Couldn't start resource garage.",
            '[    script:garage] > handler (@garage/server/main.lua:40)',
            'Error: could not connect to the database',
        ]) { assert.equal(logSeverity(line), 'error', line); }
        for (const line of ['[ citizen-server-impl] Warning: The players.json endpoint has been modified', '[resources] fx_version adamant is deprecated']) {
            assert.equal(logSeverity(line), 'warning', line);
        }
        for (const line of ['[    script:garage] Started resource garage', '[ script:monitor] no errors found', 'Authenticating server license key...']) {
            assert.equal(logSeverity(line), undefined, line);
        }
    }],
];

/** Temporary folders only; nothing here needs an editor or a language server. */
export async function runCheckTests(): Promise<void> {
    const failures: string[] = [];
    for (const [name, body] of tests) {
        try {
            await body();
            console.log(`  ok   ${name}`);
        } catch (error) {
            failures.push(name);
            console.error(`  FAIL ${name}\n${error instanceof Error ? error.stack : String(error)}`);
        }
    }
    if (failures.length > 0) {
        throw new Error(`${failures.length} check test(s) failed: ${failures.join(', ')}`);
    }
}
