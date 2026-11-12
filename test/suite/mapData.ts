import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { assetContained, assetHash } from '../../src/assetInventory';
import { loadNameLists, parseNameList } from '../../src/assetNames';
import { loadResourcePages } from '../../src/assetResource';
import { parseBounds } from '../../src/boundsFormat';
import { appendTriangles, SurfaceIndex } from '../../src/mapCollision';
import { findScopeRoot, scanAssetScope, scopeNames } from '../../src/assetScope';
import { isXml, nameRef, readMapFile, type MapDocument, type MapFile, type TypesDocument } from '../../src/mapFormat';
import { luaBoxZone, luaCoords, luaEntity, luaEntitySet, luaInteriorLookup, luaModel, luaNumber, luaPlayAnim, luaPoints, luaString } from '../../src/mapLua';
import { conjugate, heading, multiply, normalize, rotate, tilt, type Quat, type Vec3 } from '../../src/mapMath';
import { buildMapView, hexHash, MAX_MAP_ROWS } from '../../src/mapView';
import { metaHash } from '../../src/metaFormat';
import { metaNames } from '../../src/metaNames';
import { floatText, hashText, metaToXml } from '../../src/metaXml';
import { parseXml } from '../../src/xmlLite';
import { DOOR_NAME, INTERIOR_NAME, mapFixture, SHELL_NAME, syntheticFloorYbn, syntheticMeta, typesFixture, type MetaObject } from './mapFixtures';

type Test = [string, () => void | Promise<void>];
const HALF = Math.SQRT1_2;
function close(actual: readonly number[], expected: readonly number[], message?: string): void {
    assert.equal(actual.length, expected.length, message);
    actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-4, `${message ?? 'vector'} [${index}]: ${value} is not ${expected[index]}`));
}
async function temporary(body: (root: string) => Promise<void>): Promise<void> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qbx-map-tests-'));
    try { await body(root); }
    finally {
        assert.ok(assetContained(path.resolve(os.tmpdir()), path.resolve(root)) && path.basename(root).startsWith('qbx-map-tests-'));
        await fs.rm(root, { recursive: true, force: true });
    }
}
async function both(object: MetaObject): Promise<{ binary: MapFile; xml: MapFile; text: string }> {
    const parsed = await readMapFile(syntheticMeta(object));
    assert.ok(parsed.meta, 'binary files keep their Meta data for XML export');
    const text = metaToXml(parsed.meta);
    return { binary: parsed.document, xml: (await readMapFile(Buffer.from(text, 'utf8'))).document, text };
}

const tests: Test[] = [
    ['Meta names hash case-sensitively and resolve through the schema dictionary', () => {
        assert.equal(metaHash('archetypeName'), 0xa023a02c); assert.equal(metaHash('CEntityDef'), 0xce501483); assert.equal(metaHash('position'), assetHash('position'));
        assert.notEqual(metaHash('archetypeName'), assetHash('archetypeName'));
        const names = metaNames();
        for (const name of ['CMapData', 'CMloInstanceDef', 'entities', 'streamingExtentsMin', 'LODTYPES_DEPTH_HD', 'secondaryTimecycleName']) { assert.equal(names.get(metaHash(name)), name); }
    }],
    ['headings follow the game: zero faces north and grows counter-clockwise', () => {
        const quarter: Quat = [0, 0, HALF, HALF];
        close([heading([0, 0, 0, 1])], [0]); close([heading(quarter)], [90]); close([heading(conjugate(quarter))], [270]); close([heading([0, 0, 1, 0])], [180]);
        close(rotate(quarter, [1, 0, 0]), [0, 1, 0]); close(rotate(quarter, [0, 1, 0]), [-1, 0, 0]); close(rotate(multiply(quarter, quarter), [1, 2, 3]), [-1, -2, 3]);
        close(normalize([0, 0, 0, 0]), [0, 0, 0, 1]); close(normalize([0, 0, 2, 0]), [0, 0, 1, 0]);
        close([tilt([0, 0, HALF, HALF])], [0]); close([tilt([HALF, 0, 0, HALF])], [90]);
    }],
    ['Lua snippets round numbers, keep float literals and choose model spellings', () => {
        assert.equal(luaNumber(441.2, 2), '441.2'); assert.equal(luaNumber(30, 2), '30.0'); assert.equal(luaNumber(-0.001, 2), '0.0'); assert.equal(luaNumber(-982.126, 2), '-982.13');
        assert.equal(luaNumber(Number.NaN, 2), '0.0'); assert.equal(luaNumber(1.23456, 4), '1.2346');
        const position: Vec3 = [441.2, -982.126, 30];
        assert.equal(luaCoords(position, 'vec', 2), 'vec3(441.2, -982.13, 30.0)'); assert.equal(luaCoords(position, 'vec', 2, 90), 'vec4(441.2, -982.13, 30.0, 90.0)');
        assert.equal(luaCoords(position, 'vector', 1), 'vector3(441.2, -982.1, 30.0)'); assert.equal(luaCoords(position, 'plain', 2, 270.5), '441.2, -982.13, 30.0, 270.5');
        assert.equal(luaCoords(position, 'table', 2, 90), '{ x = 441.2, y = -982.13, z = 30.0, w = 90.0 }');
        assert.equal(luaModel('prop_bench_01a', 1), '`prop_bench_01a`'); assert.equal(luaModel('0x0000ABCD', 0xabcd), '0x0000ABCD'); assert.equal(luaModel('bad`name', 0xffffffff), '0xFFFFFFFF');
        assert.equal(luaString("it's\\"), "'it\\'s\\\\'");
        assert.equal(luaEntity('test_door', 5, position, 90, 'vec', 2), '{ model = `test_door`, coords = vec4(441.2, -982.13, 30.0, 90.0) }');
        assert.equal(luaBoxZone([1, 2, 3], [4, 5, 6], 90, 'vec', 1), 'lib.zones.box({\n    coords = vec3(1.0, 2.0, 3.0),\n    size = vec3(4.0, 5.0, 6.0),\n    rotation = 90.0,\n})');
        assert.equal(luaPoints([[1, 2, 3], [4, 5, 6]], 'vector', 1), '{\n    vector3(1.0, 2.0, 3.0),\n    vector3(4.0, 5.0, 6.0),\n}');
        assert.equal(luaInteriorLookup([1, 2, 3], 1), 'local interior = GetInteriorAtCoords(1.0, 2.0, 3.0)');
        assert.equal(luaPlayAnim('anim@test', "it's", 'ox'), "lib.playAnim(cache.ped, 'anim@test', 'it\\'s')");
        assert.equal(luaPlayAnim('d', 'c', 'natives'), "RequestAnimDict('d')\nwhile not HasAnimDictLoaded('d') do Wait(0) end\nTaskPlayAnim(PlayerPedId(), 'd', 'c', 8.0, -8.0, -1, 0, 0.0, false, false, false)\nRemoveAnimDict('d')");
        assert.equal(luaEntitySet([1, 2, 3], 'set_a', 1), "local interior = GetInteriorAtCoords(1.0, 2.0, 3.0)\nActivateInteriorEntitySet(interior, 'set_a')\nRefreshInterior(interior)");
    }],
    ['the XML reader keeps elements, attributes, entities and CDATA, and rejects broken documents', () => {
        const root = parseXml('﻿<?xml version="1.0"?><!-- note --><a x="1" y=\'&lt;2&gt;\'><b/><c>t&amp;u&#65;&#x42;<![CDATA[<raw>]]></c></a>');
        assert.equal(root.name, 'a'); assert.deepEqual(root.attributes, { x: '1', y: '<2>' }); assert.equal(root.children.length, 2);
        assert.equal(root.children[0].name, 'b'); assert.equal(root.children[1].text, 't&uAB<raw>');
        for (const broken of ['<a>', '<a></b>', '<a><b></a></b>', '<a/><b/>', 'text', '<a><!-- open', '<a x=1/>', `${'<a>'.repeat(70)}${'</a>'.repeat(70)}`]) { assert.throws(() => parseXml(broken), /XML/); }
    }],
    ['float and hash text match the XML that CodeWalker reads', () => {
        assert.equal(floatText(Math.fround(0.1)), '0.1'); assert.equal(floatText(1), '1'); assert.equal(floatText(Math.fround(473.598)), '473.598'); assert.equal(floatText(-0), '0');
        assert.equal(floatText(Number.NaN), 'NaN'); assert.equal(floatText(Math.fround(1e-7)), '1e-7');
        assert.equal(Math.fround(Number(floatText(Math.fround(1 / 3)))), Math.fround(1 / 3));
        assert.equal(hashText(0xb27a38a3), 'hash_B27A38A3'); assert.equal(hexHash(0xab), '0x000000AB');
        assert.deepEqual(nameRef('hash_B27A38A3'), { hash: 0xb27a38a3 }); assert.deepEqual(nameRef(' 0xAB '), { hash: 0xab }); assert.deepEqual(nameRef(''), { hash: 0 });
        assert.deepEqual(nameRef('Prop_A'), { hash: assetHash('prop_a'), name: 'Prop_A' }); assert.deepEqual(nameRef('пропс'), { hash: 0, name: 'пропс' });
    }],
    ['a binary map file decodes entities, interior placements, car generators and its export block', async () => {
        const map = (await readMapFile(syntheticMeta(mapFixture()))).document as MapDocument;
        assert.equal(map.kind, 'ymap'); assert.equal(map.source, 'binary'); assert.equal(map.name.hash, assetHash('test_map')); assert.equal(map.contentFlags, 9);
        assert.deepEqual(map.entitiesExtents, [[90, 190, 28], [110, 210, 36]]); assert.deepEqual(map.physicsDictionaries, [{ hash: assetHash(SHELL_NAME) }]);
        assert.equal(map.entities.length, 2);
        const [interior, prop] = map.entities;
        assert.equal(interior.archetype.hash, assetHash(INTERIOR_NAME)); assert.deepEqual(interior.position, [100, 200, 30]); close(interior.rotation, [0, 0, HALF, HALF]);
        assert.deepEqual(interior.mlo, { groupId: 0, floorId: 0, defaultEntitySets: [{ hash: assetHash('set_default') }], numExitPortals: 1, flags: 0 });
        assert.equal(interior.lodLevel, 'LODTYPES_DEPTH_ORPHANHD'); assert.equal(interior.priorityLevel, 'PRI_REQUIRED'); assert.equal(interior.parentIndex, -1); assert.equal(interior.lodDist, 60);
        assert.equal(prop.mlo, undefined); assert.equal(prop.archetype.hash, 0x12345678); assert.deepEqual(prop.position, [95.5, 190.25, 28.5]);
        assert.equal(map.carGenerators.length, 1); assert.equal(map.carGenerators[0].model.hash, assetHash('adder')); assert.deepEqual(map.carGenerators[0].bodyColors, [-1, -1, -1, -1]);
        assert.deepEqual(map.block, { name: 'test_map', exportedBy: 'synthetic', owner: '', time: '' });
        const uncompressed = (await readMapFile(syntheticMeta(mapFixture(), { compressed: false }))).document;
        assert.deepEqual(uncompressed, map);
    }],
    ['a binary archetype file decodes rooms, portals, entity sets and archetype kinds', async () => {
        const types = (await readMapFile(syntheticMeta(typesFixture()))).document as TypesDocument;
        assert.equal(types.kind, 'ytyp'); assert.deepEqual(types.archetypes.map((archetype) => archetype.kind), ['base', 'time', 'mlo']);
        assert.equal(types.archetypes[0].assetType, 'ASSET_TYPE_DRAWABLE'); assert.deepEqual(types.archetypes[0].bbMax, [4, 3, 3]); assert.equal(types.archetypes[1].timeFlags, 0x00ffffff);
        const interior = types.archetypes[2].mlo!;
        assert.equal(interior.entities.length, 3); assert.deepEqual(interior.rooms.map((room) => room.name), ['limbo', 'Office']); assert.deepEqual(interior.rooms[1].attachedObjects, [0, 2]);
        assert.equal(interior.rooms[1].timecycle.hash, assetHash('int_office')); assert.equal(interior.rooms[1].flags, 96);
        assert.deepEqual(interior.portals[0].corners, [[4, -1, 0.5], [4, -1, 2.5], [4, 1, 2.5], [4, 1, 0.5]]); assert.deepEqual(interior.portals[0].attachedObjects, [1]);
        assert.deepEqual(interior.entitySets.map((set) => [set.name.hash, set.entities.length, set.locations]), [[assetHash('set_default'), 1, [1]], [assetHash('set_extra'), 2, [1, 1]]]);
    }],
    ['XML export of binary files reads back as the same map data', async () => {
        for (const fixture of [mapFixture(), typesFixture()]) {
            const { binary, xml, text } = await both(fixture);
            assert.equal(xml.source, 'xml');
            assert.deepEqual({ ...xml, source: 'binary' }, binary);
            assert.match(text, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<CMap(Data|Types)>\n/);
        }
        const { text } = await both(mapFixture());
        assert.match(text, /\n  <Item type="CMloInstanceDef">\n   <archetypeName>hash_[0-9A-F]{8}<\/archetypeName>\n   <flags value="32" \/>/);
        assert.match(text, /\n   <position x="100" y="200" z="30" \/>\n   <rotation x="0" y="0" z="0\.70710677" w="0\.70710677" \/>/);
        assert.match(text, /\n   <lodLevel>LODTYPES_DEPTH_ORPHANHD<\/lodLevel>/); assert.match(text, /\n <carGenerators itemType="CCarGen">\n  <Item>\n   <position x="90" y="195" z="28" \/>/);
        assert.match(text, /\n  <exportedBy>synthetic<\/exportedBy>\n  <owner \/>/);
        const named = metaToXml((await readMapFile(syntheticMeta(mapFixture()))).meta!, (hash) => hash === assetHash(INTERIOR_NAME) ? INTERIOR_NAME : undefined);
        assert.match(named, /<archetypeName>test_interior<\/archetypeName>/);
        const types = (await both(typesFixture())).text;
        assert.match(types, /\n     <corners>\n      <Item>4, -1, 0\.5, 0<\/Item>/); assert.match(types, /\n     <attachedObjects>0 2<\/attachedObjects>/); assert.match(types, /\n   <rooms itemType="CMloRoomDef">\n    <Item>\n     <name>limbo<\/name>/);
    }],
    ['structure arrays that continue into following data blocks are read whole', async () => {
        const fixture = typesFixture(), interior = (fixture.archetypes as MetaObject[])[2];
        interior.rooms = Array.from({ length: 7 }, (_unused, index) => ({ $type: 'CMloRoomDef', name: `room_${index}`, bbMin: [index, 0, 0], bbMax: [index + 1, 1, 1], blend: 1, timecycleName: 0,
            secondaryTimecycleName: 0, flags: 0, portalCount: 0, floorId: 0, attachedObjects: [index] }));
        const whole = (await readMapFile(syntheticMeta(fixture))).document as TypesDocument, split = await readMapFile(syntheticMeta(fixture, { chunk: 3 }));
        assert.deepEqual(split.document, whole);
        assert.deepEqual((split.document as TypesDocument).archetypes[2].mlo!.rooms.map((room) => room.name), ['room_0', 'room_1', 'room_2', 'room_3', 'room_4', 'room_5', 'room_6']);
        assert.match(metaToXml(split.meta!), /<name>room_6<\/name>/);
    }],
    ['XML map files with names, raw number lists and hex values build the same model', async () => {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CMapTypes><extensions/><archetypes>
 <Item type="CBaseArchetypeDef"><lodDist value="250.5"/><flags value="0x20"/><bbMin x="-1" y="-2" z="0"/><bbMax x="1" y="2" z="3"/><name>Prop_Thing</name><textureDictionary>thing_txd</textureDictionary><assetType>ASSET_TYPE_DRAWABLE</assetType><assetName>prop_thing</assetName></Item>
 <Item type="CMloArchetypeDef"><name>hash_0000ABCD</name><entities><Item type="CEntityDef"><archetypeName>prop_thing</archetypeName><position x="1" y="2" z="3"/><rotation x="0" y="0" z="0" w="1"/><lodLevel>LODTYPES_DEPTH_HD</lodLevel></Item></entities>
  <rooms itemType="CMloRoomDef"><Item><name>Hall &amp; Stairs</name><bbMin x="0" y="0" z="0"/><bbMax x="2" y="2" z="2"/><portalCount value="1"/><attachedObjects>
   0
   1
  </attachedObjects></Item></rooms>
  <portals itemType="CMloPortalDef"><Item><roomFrom value="1"/><roomTo value="0"/><corners content="vector3_array">
   1.0 2.0 3.0
   4.0 5.0 6.0
  </corners><attachedObjects/></Item></portals>
  <entitySets itemType="CMloEntitySet"><Item><name>set_a</name><locations>0 0</locations><entities/></Item></entitySets></Item>
</archetypes><name>props</name><dependencies><Item>dep_one</Item></dependencies></CMapTypes>`;
        assert.equal(isXml(Buffer.from(xml)), true); assert.equal(isXml(Buffer.from('﻿  <a/>')), true); assert.equal(isXml(Buffer.from('RSC7')), false);
        const types = (await readMapFile(Buffer.from(xml))).document as TypesDocument;
        assert.equal(types.source, 'xml'); assert.deepEqual(types.name, { hash: assetHash('props'), name: 'props' }); assert.deepEqual(types.dependencies, [{ hash: assetHash('dep_one'), name: 'dep_one' }]);
        const [prop, interior] = types.archetypes;
        assert.deepEqual(prop.name, { hash: assetHash('prop_thing'), name: 'Prop_Thing' }); assert.equal(prop.lodDist, 250.5); assert.equal(prop.flags, 32); assert.deepEqual(prop.bbMin, [-1, -2, 0]);
        assert.deepEqual(interior.name, { hash: 0xabcd }); assert.equal(interior.mlo!.rooms[0].name, 'Hall & Stairs'); assert.deepEqual(interior.mlo!.rooms[0].attachedObjects, [0, 1]);
        assert.deepEqual(interior.mlo!.portals[0].corners, [[1, 2, 3], [4, 5, 6]]); assert.deepEqual(interior.mlo!.entitySets[0].locations, [0, 0]);
        assert.equal(interior.mlo!.entities[0].lodLevel, 'LODTYPES_DEPTH_HD'); assert.deepEqual(interior.mlo!.entities[0].position, [1, 2, 3]);
        await assert.rejects(readMapFile(Buffer.from('<CScenarioPointRegion/>')), /CScenarioPointRegion data; the map viewer reads/);
        await assert.rejects(readMapFile(Buffer.from('<CMapData><entities>')), /XML element <entities> is not closed/);
    }],
    ['malformed or oversized Meta containers are rejected without reading out of bounds', async () => {
        const invalid: [string, (pages: Buffer) => void, RegExp][] = [
            ['negative structure count', (pages) => pages.writeInt16LE(-1, 0x48), /valid Meta header/], ['no data blocks', (pages) => pages.writeInt16LE(0, 0x4c), /valid Meta header/],
            ['structure table outside the pages', (pages) => pages.writeBigUInt64LE(0x5fffff00n, 0x20), /invalid resource pointer/],
            ['graphics pointer without graphics pages', (pages) => pages.writeBigUInt64LE(0x60000000n, 0x30), /invalid resource pointer/],
            ['missing block table', (pages) => pages.writeBigUInt64LE(0n, 0x30), /required resource pointer/],
            ['root block out of range', (pages) => pages.writeInt32LE(900, 0x1c), /root data block/],
        ];
        for (const [label, mutate, expected] of invalid) { await assert.rejects(readMapFile(syntheticMeta(mapFixture(), { mutate })), expected, label); }
        const good = syntheticMeta(mapFixture(), { compressed: false });
        for (const length of [0, 3, 16, 17, 200, good.length - 0x30000]) { await assert.rejects(readMapFile(good.subarray(0, length)), /./, `truncated at ${length}`); }
        const wrongVersion = Buffer.from(good); wrongVersion.writeUInt32LE(13, 4);
        await assert.rejects(readMapFile(wrongVersion), /resource version 13 is unsupported; expected 2/);
        await assert.rejects(readMapFile(Buffer.from('RSC8' + '\0'.repeat(60), 'latin1')), /RSC8/);
        const shortRoot = (pages: Buffer): void => { pages.writeInt32LE(8, Number(pages.readBigUInt64LE(0x30) & 0xfffffffn) + 4); };
        await assert.rejects(readMapFile(syntheticMeta(mapFixture(), { mutate: shortRoot })), /structure extends past the end of its data block/);
    }],
    ['resource pages accept exporters that write more than they declare, never less', async () => {
        const fixture = syntheticMeta(mapFixture(), { compressed: false, mutate: (pages) => pages.fill(0x41, 0x3fff0) }), declared = Buffer.from(fixture);
        declared.writeUInt32LE(0x08000008, 8);
        const pages = await loadResourcePages(declared, 'Test', [2]);
        assert.equal(pages.system, 0x20000); assert.equal(pages.bytes.length, 0x40000);
        assert.throws(() => pages.address(0x50020000n, 1), /invalid resource pointer/); assert.equal(pages.address(0x5001fff0n, 16), 0x1fff0); assert.equal(pages.address(0n, 8), undefined);
        await assert.rejects(loadResourcePages(fixture.subarray(0, 16 + 0x1000), 'Test', [2]), /shorter than its declared system pages|invalid/);
        assert.throws(() => pages.text(0x3fff8), /unterminated string/);
    }],
    ['a map view places interior rooms, portals and entities in world space', async () => {
        const map = (await readMapFile(syntheticMeta(mapFixture()))).document, types = (await readMapFile(syntheticMeta(typesFixture()))).document;
        const names = new Map([INTERIOR_NAME, SHELL_NAME, DOOR_NAME, 'test_crate', 'set_default', 'set_extra', 'test_map', 'adder', 'int_office'].map((name) => [assetHash(name), name]));
        const view = buildMapView(map, 'test.ymap', '/maps/test.ymap', { names, files: [{ id: '0', label: 'stream/test.ytyp', document: types }] });
        assert.deepEqual(view.groups.map((group) => [group.label, group.kind, group.enabled]), [['Map entities', 'map', true], ['Interior · test_interior', 'interior', true],
            ['Entity set · set_default', 'entitySet', true], ['Entity set · set_extra', 'entitySet', false]]);
        assert.equal(view.entities.length, 8); assert.deepEqual(view.related, [{ id: '0', label: 'stream/test.ytyp', role: 'defines interior' }]);
        const [placement, prop, shell, door, loose, crate] = view.entities;
        assert.equal(placement.kind, 'interior'); close([placement.heading], [90]); assert.deepEqual(placement.size, [8, 6, 3]);
        assert.equal(prop.name, '0x12345678'); close([prop.heading], [90], 'plain entities store the inverse rotation');
        assert.equal(shell.name, SHELL_NAME); close(shell.position, [100, 200, 30]); close([shell.heading], [90]); assert.equal(shell.room, 1); assert.equal(shell.portal, undefined);
        assert.equal(door.name, DOOR_NAME); close(door.position, [100, 204, 30.5], 'local +X becomes world +Y after a quarter turn'); assert.equal(door.portal, 0); assert.equal(door.room, undefined);
        close(loose.position, [99, 198, 30.25]); close([loose.heading], [0], 'a child turned back by its stored inverse rotation'); assert.equal(loose.room, 1);
        close(crate.position, [99, 201, 30.5]); assert.equal(crate.group, 2); assert.equal(crate.room, 1);
        const interior = view.interiors[0];
        assert.equal(interior.placed, true); assert.equal(interior.name, INTERIOR_NAME); close([interior.heading], [90]); assert.equal(interior.placedIn, 'test.ymap'); assert.equal(interior.definedIn, 'stream/test.ytyp');
        const office = interior.rooms[1];
        assert.equal(office.name, 'Office'); close(office.center, [100, 200, 31.75]); close(office.size, [8, 6, 2.5], 'a room with swapped corners is normalised'); close([office.floor, office.ceiling], [30.5, 33]);
        close(office.corners.flat(), [103, 196, 103, 204, 97, 204, 97, 196]); assert.equal(office.entityCount, 2); assert.equal(office.timecycle, 'int_office');
        close(interior.portals[0].center, [100, 204, 31.5]); assert.equal(interior.portals[0].attached, 1);
        assert.deepEqual(interior.entitySets.map((set) => [set.name, set.entityCount, set.enabledByDefault, set.group]), [['set_default', 1, true, 2], ['set_extra', 2, false, 3]]);
        assert.equal(view.carGenerators.length, 1); close([view.carGenerators[0].heading, view.carGenerators[0].length], [0, 5]); assert.equal(view.carGenerators[0].model, 'adder');
        assert.ok(view.facts.some((fact) => fact.name === 'Content flags' && fact.value === '9 (HD entities, interiors)'));
        assert.ok(view.facts.some((fact) => fact.name === 'Entities' && fact.value === '2 (1 interior placement)'));
        assert.ok(view.notes.some((note) => /^2 of 8 model names are shown as hashes/.test(note)));
    }],
    ['an archetype view borrows the placement from a map and says so when there is none', async () => {
        const map = (await readMapFile(syntheticMeta(mapFixture()))).document, types = (await readMapFile(syntheticMeta(typesFixture()))).document;
        const placed = buildMapView(types, 'test.ytyp', '/maps/test.ytyp', { names: new Map(), files: [{ id: 'm', label: 'stream/test.ymap', document: map }] });
        assert.deepEqual(placed.archetypes.map((row) => [row.kind, row.placements]), [['base', 0], ['time', 0], ['mlo', 1]]); assert.deepEqual(placed.archetypes[0].size, [8, 6, 3]);
        assert.equal(placed.interiors[0].placed, true); close(placed.interiors[0].position, [100, 200, 30]); assert.equal(placed.interiors[0].placedIn, 'stream/test.ymap');
        assert.deepEqual(placed.related, [{ id: 'm', label: 'stream/test.ymap', role: 'places interior' }]); assert.equal(placed.groups[0].kind, 'interior');
        close(placed.entities[1].position, [100, 204, 30.5]);
        const loose = buildMapView(types, 'test.ytyp', '/maps/test.ytyp', { names: new Map(), files: [] });
        assert.equal(loose.interiors[0].placed, false); close(loose.entities[1].position, [4, 0, 0.5]); close([loose.interiors[0].heading], [0]);
        assert.ok(loose.notes.some((note) => /No map file \(\.ymap\) in this resource places interior/.test(note)));
        assert.ok(loose.facts.some((fact) => fact.name === 'Archetypes' && fact.value === '3 (1 base, 1 time, 1 interior)'));
        const orphan = buildMapView(map, 'test.ymap', '/maps/test.ymap', { names: new Map(), files: [] });
        assert.equal(orphan.interiors.length, 0); assert.ok(orphan.notes.some((note) => /no archetype file \(\.ytyp\) in this resource defines it/.test(note)));
    }],
    ['a map view lists at most the row limit and says what it left out', () => {
        const entity = { archetype: { hash: 1 }, position: [0, 0, 0] as Vec3, rotation: [0, 0, 0, 1] as Quat, scaleXY: 1, scaleZ: 1, flags: 0, guid: 0, parentIndex: -1, lodDist: 0, childLodDist: 0,
            lodLevel: '', priorityLevel: '', numChildren: 0, extensions: 0 };
        const document: MapDocument = { kind: 'ymap', source: 'binary', name: { hash: 0 }, parent: { hash: 0 }, flags: 0, contentFlags: 0, streamingExtents: [[0, 0, 0], [0, 0, 0]], entitiesExtents: [[0, 0, 0], [0, 0, 0]],
            entities: new Array(MAX_MAP_ROWS + 5).fill(entity), carGenerators: [], physicsDictionaries: [], counts: [] };
        const view = buildMapView(document, 'big.ymap', '/big.ymap', { names: new Map(), files: [] });
        assert.equal(view.entities.length, MAX_MAP_ROWS); assert.ok(view.notes.some((note) => note.includes('Only the first 60,000 entities are listed')));
    }],
    ['surface heights come from the collision triangles under a point', async () => {
        const floor = [0, 0, 1, 10, 0, 1, 10, 10, 1, 0, 0, 1, 10, 10, 1, 0, 10, 1], shelf = [2, 2, 3, 4, 2, 3, 2, 4, 3.5], wall = [5, 0, 0, 5, 10, 0, 5, 10, 4], twin = [2, 2, 3.01, 4, 2, 3.01, 2, 4, 3.51];
        const index = new SurfaceIndex(Float32Array.from([...floor, ...shelf, ...wall, ...twin]));
        assert.equal(index.count, 5);
        close(index.heights(2.5, 2.5), [3.135, 1], 'a shelf above the floor, with a duplicate two centimetres apart counted once');
        close(index.heights(8, 8), [1], 'floor only'); close(index.heights(5, 5), [1], 'a wall adds no height'); assert.deepEqual(index.heights(-1, 3), []); assert.deepEqual(index.heights(500, 500), []);
        const terrain = new SurfaceIndex(Float32Array.from([-6000, -6000, 5, 6000, -6000, 5, 0, 6000, 25]));
        close(terrain.heights(0, 0), [15], 'a triangle far larger than a grid cell is still found');
        const bounds = await parseBounds(syntheticFloorYbn([-4, -3], [4, 3], 0.75)), triangles: number[] = [];
        assert.equal(appendTriangles(bounds.mesh, (point) => [point[0] + 100, point[1] + 200, point[2] + 30], triangles), true); assert.equal(triangles.length, 18);
        const moved = new SurfaceIndex(Float32Array.from(triangles));
        close(moved.heights(100, 200), [30.75], 'collision moved to its world placement'); close(moved.heights(103.9, 202.9), [30.75], 'near a corner'); assert.deepEqual(moved.heights(104.5, 200), []);
    }],
    ['asset scopes stop at the resource manifest and recover names from file names', async () => {
        await temporary(async (root) => {
            const resource = path.join(root, '[maps]', 'my_map'), stream = path.join(resource, 'stream', 'interior');
            await fs.mkdir(stream, { recursive: true }); await fs.mkdir(path.join(resource, 'node_modules', 'x'), { recursive: true }); await fs.mkdir(path.join(resource, '.hidden'));
            await fs.writeFile(path.join(resource, 'fxmanifest.lua'), "fx_version 'cerulean'\n");
            for (const name of ['Shell_Main.ydr', 'door.ydr', 'my_map.ymap', 'my_map.ytyp', 'export.ytyp.xml', 'notes.txt']) { await fs.writeFile(path.join(stream, name), ''); }
            await fs.writeFile(path.join(resource, 'node_modules', 'x', 'skipped.ydr'), ''); await fs.writeFile(path.join(resource, '.hidden', 'skipped.ydr'), '');
            const file = path.join(stream, 'my_map.ymap');
            assert.deepEqual(await findScopeRoot(file), { root: resource, resource: true });
            const scope = await scanAssetScope(file);
            assert.deepEqual(scope.files.map((entry) => entry.relative).sort(), ['stream/interior/Shell_Main.ydr', 'stream/interior/door.ydr', 'stream/interior/export.ytyp.xml', 'stream/interior/my_map.ymap', 'stream/interior/my_map.ytyp']);
            assert.equal(scope.files.find((entry) => entry.extension === '.ytyp.xml')?.stem, 'export'); assert.equal(scope.incomplete, false);
            const names = scopeNames(scope);
            assert.equal(names.get(assetHash('shell_main')), 'shell_main'); assert.equal(names.get(assetHash('door')), 'door'); assert.equal(names.has(assetHash('skipped')), false);
            const loose = path.join(root, 'loose'); await fs.mkdir(loose); await fs.writeFile(path.join(loose, 'a.ymap'), '');
            assert.deepEqual(await findScopeRoot(path.join(loose, 'a.ymap')), { root: loose, resource: false });
        });
    }],
    ['name lists accept text, INI and JSON and report lists that cannot be read', async () => {
        const names = parseNameList('prop_bench_01a\r\nV_Ilev_Door = 1\n["adder", "zentorno"]\n12345 0x10 ok');
        for (const name of ['prop_bench_01a', 'v_ilev_door', 'adder', 'zentorno', 'ok', '0x10']) { assert.equal(names.get(assetHash(name)), name); }
        assert.equal(names.has(assetHash('12345')), false);
        await temporary(async (root) => {
            const list = path.join(root, 'objects.txt'); await fs.writeFile(list, 'first_prop\n');
            const loaded = await loadNameLists([list, path.join(root, 'missing.txt')]);
            assert.equal(loaded.names.get(assetHash('first_prop')), 'first_prop'); assert.equal(loaded.notes.length, 1); assert.match(loaded.notes[0], /missing\.txt was not used/);
            await fs.writeFile(list, 'second_prop with more text\n');
            assert.equal((await loadNameLists([list])).names.get(assetHash('second_prop')), 'second_prop', 'a changed list is parsed again');
        });
    }],
];
export async function runMapDataTests(): Promise<void> {
    const failures: string[] = [];
    for (const [name, body] of tests) {
        try { await body(); console.log(`  ok   ${name}`); }
        catch (error) { failures.push(name); console.error(`  FAIL ${name}\n${error instanceof Error ? error.stack : String(error)}`); }
    }
    if (failures.length) { throw new Error(`${failures.length} map data test(s) failed: ${failures.join(', ')}`); }
}
