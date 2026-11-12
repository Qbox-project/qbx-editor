import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AnimEditor } from '../../src/animEditor';
import { getAnimHtml } from '../../src/animHtml';
import type { AnimView } from '../../src/animTypes';
import { assetContained, assetHash } from '../../src/assetInventory';
import { MapEditor } from '../../src/mapEditor';
import { getMapHtml } from '../../src/mapHtml';
import type { MapView } from '../../src/mapTypes';
import { ModelEditor, texturePreview } from '../../src/modelEditor';
import { getModelHtml } from '../../src/modelHtml';
import type { ModelView } from '../../src/modelTypes';
import { parseModel } from '../../src/modelFormat';
import { parseYtd, textureMip } from '../../src/assetFormats';
import { decodePng, encodePng } from '../../src/pngCodec';
import { TextureDocument, TextureEditor } from '../../src/textureEditor';
import { getTextureHtml } from '../../src/textureHtml';
import type { TextureView } from '../../src/textureTypes';
import { syntheticYtd } from './assets';
import { syntheticPedYcd } from './animData';
import { mapFixture, syntheticFloorYbn, syntheticMeta, typesFixture } from './mapFixtures';
import { syntheticYcd, syntheticYdr } from './modelData';
import { testImage } from './textureEdit';

type Test = [string, () => void | Promise<void>];
function extensionUri(): vscode.Uri {
    const extension = vscode.extensions.getExtension('qbox.qbx-lua');
    assert.ok(extension, 'extension must be installed in the test host'); return extension.extensionUri;
}
async function temporary(body: (root: string) => Promise<void>): Promise<void> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qbx-viewer-host-'));
    try { await body(root); }
    finally {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        assert.ok(assetContained(path.resolve(os.tmpdir()), path.resolve(root)) && path.basename(root).startsWith('qbx-viewer-host-'));
        // Closed editors release their file watchers a moment later, which keeps the folder locked on Windows.
        await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
}
function within<T>(what: string, event: vscode.Event<T>, action: () => Promise<unknown>, accept: (value: T) => boolean = () => true, milliseconds = 15_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timeout = setTimeout(() => { subscription.dispose(); reject(new Error(`${what} did not happen within ${milliseconds / 1000} seconds.`)); }, milliseconds);
        const subscription = event((value) => { if (accept(value)) { clearTimeout(timeout); subscription.dispose(); resolve(value); } });
        action().catch((error) => { clearTimeout(timeout); subscription.dispose(); reject(error); });
    });
}
function tabs(): vscode.Tab[] { return vscode.window.tabGroups.all.flatMap((group) => group.tabs); }
async function waitFor(what: string, probe: () => boolean, milliseconds = 15_000): Promise<void> {
    const started = Date.now();
    while (!probe()) {
        if (Date.now() - started > milliseconds) { throw new Error(`timed out waiting for ${what}`); }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}
function panel(viewType: string): vscode.WebviewPanel { return vscode.window.createWebviewPanel(viewType, 'Viewer test', vscode.ViewColumn.One); }
async function resource(root: string): Promise<{ map: vscode.Uri; types: vscode.Uri; model: vscode.Uri; xml: vscode.Uri; clips: vscode.Uri; textures: vscode.Uri }> {
    const stream = path.join(root, 'test_resource', 'stream');
    await fs.mkdir(stream, { recursive: true });
    await fs.writeFile(path.join(root, 'test_resource', 'fxmanifest.lua'), "fx_version 'cerulean'\ngame 'gta5'\n");
    const files = { map: path.join(stream, 'test_map.ymap'), types: path.join(stream, 'test_types.ytyp'), model: path.join(stream, 'test_shell.ydr'), xml: path.join(stream, 'props.ytyp'), clips: path.join(stream, 'Anim@Test.ycd'), textures: path.join(stream, 'Test_Txd.ytd') };
    await fs.writeFile(files.textures, syntheticYtd());
    await fs.writeFile(files.clips, syntheticYcd()); await fs.writeFile(path.join(stream, 'test_interior.ybn'), syntheticFloorYbn([-4, -3], [4, 3], 0.75));
    await fs.writeFile(path.join(stream, 'ped@test.ycd'), syntheticPedYcd());
    await fs.writeFile(files.map, syntheticMeta(mapFixture())); await fs.writeFile(files.types, syntheticMeta(typesFixture())); await fs.writeFile(files.model, syntheticYdr());
    await fs.writeFile(files.xml, '<?xml version="1.0"?>\n<CMapTypes><archetypes><Item type="CBaseArchetypeDef"><name>prop_xml</name></Item></archetypes><name>props</name></CMapTypes>\n');
    return { map: vscode.Uri.file(files.map), types: vscode.Uri.file(files.types), model: vscode.Uri.file(files.model), xml: vscode.Uri.file(files.xml), clips: vscode.Uri.file(files.clips), textures: vscode.Uri.file(files.textures) };
}

const tests: Test[] = [
    ['viewer pages allow only their own nonce script and no network access', () => {
        for (const html of [getMapHtml('vscode-webview-resource://example/map.js?a="<&', 'safe-nonce'), getModelHtml('vscode-webview-resource://example/model.js?a="<&', 'safe-nonce'),
            getAnimHtml('vscode-webview-resource://example/anim.js?a="<&', 'safe-nonce'), getTextureHtml('vscode-webview-resource://example/texture.js?a="<&', 'safe-nonce')]) {
            assert.match(html, /default-src 'none'/); assert.match(html, /script-src 'nonce-safe-nonce'/); assert.match(html, /connect-src 'none'/);
            assert.match(html, /base-uri 'none'/); assert.match(html, /form-action 'none'/); assert.match(html, /\.js\?a=&quot;&lt;&amp;/);
            assert.doesNotMatch(html, /unsafe-inline|unsafe-eval|<iframe/); assert.equal((html.match(/<script\b/g) ?? []).length, 1);
        }
    }],
    ['the map viewer renders a binary map with its interior placed from the resource', async () => {
        await temporary(async (root) => {
            const files = await resource(root), editor = new MapEditor(extensionUri(), files.map, panel('qbxLua.test.map'));
            const view = await within<MapView>('The map webview render', editor.onDidLoad, () => editor.open());
            assert.equal(view.kind, 'ymap'); assert.equal(view.title, 'test_map.ymap'); assert.equal(view.interiors.length, 1); assert.equal(view.interiors[0].placed, true);
            assert.equal(view.interiors[0].hash, assetHash('test_interior')); assert.equal(view.interiors[0].definedIn, 'stream/test_types.ytyp'); assert.equal(view.entities.length, 8);
            assert.equal(view.interiors[0].name, 'test_interior', 'the collision file named after the interior gives the hash its name back');
            assert.deepEqual(view.interiors[0].collision, { files: ['stream/test_interior.ybn'], triangles: 2 });
            const office = view.interiors[0].rooms[1];
            assert.equal(office.floor, 30.5); assert.ok(Math.abs(office.surface! - 30.75) < 1e-3, 'the room floor comes from the collision surface, not the bottom of the room box');
            assert.equal(view.interiors[0].rooms[0].surface, office.surface);
            assert.deepEqual(view.related.map((file) => file.label), ['stream/test_types.ytyp']);
            assert.ok(view.entities.some((row) => row.name === 'test_shell'), 'model names come from asset files of the same resource');
            const reloaded = await within<MapView>('The map webview refresh', editor.onDidLoad, async () => {
                const changed = mapFixture(); (changed.entities as unknown[]).pop();
                await fs.writeFile(files.map.fsPath, syntheticMeta(changed));
            }, (next) => next.snapshotId !== view.snapshotId);
            assert.equal(reloaded.entities.length, 7, 'the viewer follows the file when another tool rewrites it');
            editor.dispose();
        });
    }],
    ['XML map files open as text by default and in the viewer on request', async () => {
        await temporary(async (root) => {
            const files = await resource(root), handed = new MapEditor(extensionUri(), files.xml, panel('qbxLua.test.map'));
            assert.equal(await handed.open(), false);
            await waitFor('the XML file in a text editor', () => tabs().some((tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === files.xml.toString()));
            const forced = new MapEditor(extensionUri(), files.xml, panel('qbxLua.test.map'));
            const view = await within<MapView>('The map webview render', forced.onDidLoad, () => forced.open(true));
            assert.equal(view.source, 'xml'); assert.equal(view.archetypes[0].name, 'prop_xml');
            forced.dispose();
        });
    }],
    ['the model viewer summarises a drawable and offers its embedded texture', async () => {
        await temporary(async (root) => {
            const files = await resource(root), editor = new ModelEditor(extensionUri(), files.model, panel('qbxLua.test.model'));
            const drawn = new Promise<number>((resolve) => { editor.onDidRender((event) => resolve(event.triangles)); });
            const view = await within<ModelView>('The model webview render', editor.onDidLoad, () => editor.load());
            assert.equal(view.kind, 'ydr'); assert.equal(view.drawables.length, 1); assert.equal(view.drawables[0].name, 'test_prop.#dr');
            assert.deepEqual(view.drawables[0].lods.map((lod) => [lod.name, lod.triangles, lod.vertices]), [['High', 2, 4]]); assert.equal(view.drawables[0].embeddedTextures, 1);
            assert.deepEqual(view.drawables[0].materials, [{ shader: 'normal_spec', diffuse: 'test_diffuse', textures: ['test_diffuse'] }]);
            const triangles = await Promise.race([drawn, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 8_000))]);
            if (triangles === undefined) { console.log('       WebGL 2 is not available in this test host; the draw itself was not verified.'); } else { assert.equal(triangles, 2); }
            const model = await parseModel(syntheticYdr(), '.ydr'), [texture] = model.drawables[0].textures;
            const preview = texturePreview({ label: 'embedded', bytes: model.pages.bytes, textures: model.drawables[0].textures }, texture);
            assert.deepEqual([preview?.width, preview?.height, preview?.encoding, preview?.data.length], [4, 4, 'BC1', 8]);
            editor.dispose();
        });
    }],
    ['the animation dictionary viewer lists clips under the dictionary name', async () => {
        await temporary(async (root) => {
            const files = await resource(root), editor = new AnimEditor(extensionUri(), files.clips, panel('qbxLua.test.anim'));
            const view = await within<AnimView>('The animation webview render', editor.onDidLoad, () => editor.load());
            assert.equal(view.dictionary, 'anim@test'); assert.equal(view.title, 'Anim@Test.ycd'); assert.equal(view.animations, 1);
            assert.deepEqual(view.clips.map((clip) => [clip.name, clip.kind, clip.duration, clip.frames, clip.fps]), [['idle_a', 'animation', 4, 61, 30], ['walk_list', 'list', 4.5, 0, 0]]);
            editor.dispose();
        });
    }],
    ['the animation dictionary viewer poses a ped clip on the skeleton', async () => {
        await temporary(async (root) => {
            await resource(root);
            const uri = vscode.Uri.file(path.join(root, 'test_resource', 'stream', 'ped@test.ycd')), editor = new AnimEditor(extensionUri(), uri, panel('qbxLua.test.anim'));
            const played = await within<{ clip: number; frames: number }>('The first drawn pose', editor.onDidPlay, () => editor.load());
            assert.deepEqual(played, { clip: 0, frames: 2 }); assert.equal(editor.view?.clips[0].name, 'idle_a');
            editor.dispose();
        });
    }],
    ['the texture viewer decodes a dictionary texture onto its canvas', async () => {
        await temporary(async (root) => {
            const files = await resource(root), document = new TextureDocument(files.textures), editor = new TextureEditor(extensionUri(), document, panel('qbxLua.test.texture'));
            const drawn = new Promise<{ textureId: number; width: number; height: number }>((resolve) => { editor.onDidDraw(resolve); });
            const view = await within<TextureView>('The texture webview render', editor.onDidLoad, () => document.load());
            assert.equal(view.dictionary, 'test_txd'); assert.equal(view.kind, 'ytd'); assert.equal(view.readOnly, undefined); assert.equal(view.dirty, false); assert.equal(view.memory, 0x2000);
            assert.deepEqual(view.textures.map((texture) => [texture.name, texture.width, texture.height, texture.encoding]), [['test_diffuse', 4, 4, 'BC1']]);
            assert.deepEqual(await Promise.race([drawn, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 10_000))]), { textureId: 0, width: 4, height: 4 });
            const image = vscode.Uri.file(path.join(root, 'Shop Sign.png'));
            await fs.writeFile(image.fsPath, encodePng(testImage(40, 20, (x, y) => [x * 6, y * 12, 80, x < 20 ? 255 : 90])));
            const redrawn = new Promise<{ textureId: number; width: number; height: number }>((resolve) => { editor.onDidDraw((event) => { if (event.width === 32) { resolve(event); } }); });
            const edited = await within<TextureView>('The view of the edited dictionary', editor.onDidLoad, () => document.importImages([image], { compression: 'auto', mipmaps: 'auto' }), (next) => next.textures.length === 2);
            assert.deepEqual(edited.textures.map((texture) => [texture.name, texture.width, texture.height, texture.encoding, texture.mipCount]), [['test_diffuse', 4, 4, 'BC1', 1], ['Shop_Sign', 32, 16, 'BC3', 3]]);
            assert.equal(edited.dirty, true); assert.equal(edited.focus, 'Shop_Sign'); assert.match(edited.textures[1].notes.join(' '), /Resized from 40 × 20 to 32 × 16/);
            assert.deepEqual(await Promise.race([redrawn, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 10_000))]), { textureId: 1, width: 32, height: 16 }, 'the new texture is decoded and drawn before anything is saved');
            const exported = decodePng(await document.png(1));
            assert.deepEqual([exported.width, exported.height], [32, 16]); assert.equal(exported.rgba[3], 255); assert.ok(exported.rgba[31 * 4 + 3] < 120, 'the exported image keeps the transparency');
            const backup = vscode.Uri.file(path.join(root, 'backup.ytd')), restored = new TextureDocument(files.textures);
            await fs.writeFile(backup.fsPath, await document.bytes()); await restored.load(backup);
            assert.equal(restored.dirty, true, 'edits kept in a backup come back unsaved'); assert.deepEqual(restored.view().textures.map((texture) => texture.name).sort(), ['Shop_Sign', 'test_diffuse']);
            editor.dispose(); document.dispose(); restored.dispose();
        });
    }],
    ['textures are replaced, added, renamed and deleted in the editor, with undo, and saved as a valid dictionary', async () => {
        await temporary(async (root) => {
            const files = await resource(root), uri = files.textures, key = uri.toString();
            const tab = (): vscode.Tab | undefined => tabs().find((item) => item.input instanceof vscode.TabInputCustom && item.input.viewType === 'qbxLua.textureViewer' && item.input.uri.toString() === key);
            const stored = async (): Promise<(string | number | undefined)[][]> => (await parseYtd(await fs.readFile(uri.fsPath))).textures.map((texture) => [texture.name, texture.width, texture.height, texture.encoding, texture.mipCount]);
            const sign = vscode.Uri.file(path.join(root, 'sign.png')), paint = vscode.Uri.file(path.join(root, 'paint.png'));
            await fs.writeFile(sign.fsPath, encodePng(testImage(64, 64, (x, y) => [x * 4, y * 4, 200, 255]))); await fs.writeFile(paint.fsPath, encodePng(testImage(16, 16, (x) => [250, x * 16, 0, 255])));
            await vscode.commands.executeCommand('vscode.openWith', uri, 'qbxLua.textureViewer');
            await waitFor('the dictionary in the texture editor', () => tab() !== undefined);
            assert.equal(tab()!.isDirty, false);
            await vscode.commands.executeCommand('qbxLua.textures.edit', { uri, action: 'add', images: [sign] });
            await waitFor('the unsaved mark on the tab', () => tab()?.isDirty === true);
            assert.deepEqual(await stored(), [['test_diffuse', 4, 4, 'BC1', 1]], 'nothing is written before the file is saved');
            await vscode.commands.executeCommand('qbxLua.textures.edit', { uri, action: 'replace', texture: 'TEST_DIFFUSE', images: [paint], compression: 'BC7' });
            await vscode.commands.executeCommand('qbxLua.textures.edit', { uri, action: 'rename', texture: 'sign', name: 'shop_sign' });
            await assert.rejects(Promise.resolve(vscode.commands.executeCommand('qbxLua.textures.edit', { uri, action: 'rename', texture: 'shop_sign', name: 'Test_Diffuse' })), /already holds/);
            await assert.rejects(Promise.resolve(vscode.commands.executeCommand('qbxLua.textures.edit', { uri, action: 'remove', texture: 'missing' })), /no texture named missing/);
            await vscode.commands.executeCommand('workbench.action.files.save');
            await waitFor('the saved tab', () => tab()?.isDirty === false);
            assert.deepEqual((await stored()).sort(), [['shop_sign', 64, 64, 'BC1', 5], ['test_diffuse', 16, 16, 'BC7', 1]]);
            const { decodeAssetTexture } = await import('../../src/assetTextureDecode.mjs'), written = await parseYtd(await fs.readFile(uri.fsPath));
            const level = textureMip(written, written.textures.findIndex((texture) => texture.name === 'test_diffuse'), 0), pixels = decodeAssetTexture(level.data, 16, 16, level.encoding);
            assert.ok(Math.abs(pixels[0] - 250) <= 2 && Math.abs(pixels[15 * 4 + 1] - 240) <= 2, 'the saved texture holds the image it was replaced with');
            await vscode.commands.executeCommand('qbxLua.textures.edit', { uri, action: 'remove', texture: 'shop_sign' });
            await waitFor('the unsaved mark after a delete', () => tab()?.isDirty === true);
            await vscode.commands.executeCommand('undo');
            await waitFor('a clean tab once the delete is undone', () => tab()?.isDirty === false);
            await vscode.commands.executeCommand('undo');
            await waitFor('the unsaved mark once the rename is undone', () => tab()?.isDirty === true);
            await vscode.commands.executeCommand('workbench.action.files.save');
            await waitFor('the tab saved again', () => tab()?.isDirty === false);
            assert.deepEqual((await stored()).map((texture) => texture[0]).sort(), ['sign', 'test_diffuse'], 'undo steps back one edit at a time, across a save');
            await vscode.commands.executeCommand('qbxLua.textures.edit', { uri, action: 'remove', texture: 'sign' });
            await waitFor('the unsaved mark before a revert', () => tab()?.isDirty === true);
            await vscode.commands.executeCommand('workbench.action.files.revert');
            await waitFor('a clean tab after the revert', () => tab()?.isDirty === false);
            assert.equal((await stored()).length, 2);
            const created = vscode.Uri.file(path.join(root, 'test_resource', 'stream', 'fresh.ytd'));
            assert.equal(String(await vscode.commands.executeCommand('qbxLua.newTextureDictionary', created, [sign, paint])), created.toString());
            await waitFor('the new dictionary in the texture editor', () => tabs().some((item) => item.input instanceof vscode.TabInputCustom && item.input.uri.toString() === created.toString()));
            const fresh = await parseYtd(await fs.readFile(created.fsPath));
            assert.equal(fresh.header.version, 13); assert.deepEqual(fresh.textures.map((texture) => [texture.name, texture.width, texture.encoding, texture.mipCount]).sort(), [['paint', 16, 'BC1', 3], ['sign', 64, 'BC1', 5]]);
        });
    }],
    ['binary map and model files open in their viewers from the Explorer', async () => {
        await temporary(async (root) => {
            const files = await resource(root);
            for (const [uri, viewType] of [[files.types, 'qbxLua.mapViewer'], [files.model, 'qbxLua.modelViewer'], [files.clips, 'qbxLua.animViewer'], [files.textures, 'qbxLua.textureViewer']] as const) {
                await vscode.commands.executeCommand('vscode.open', uri);
                await waitFor(`${viewType} for ${path.basename(uri.fsPath)}`, () => tabs().some((tab) => tab.input instanceof vscode.TabInputCustom && tab.input.viewType === viewType && tab.input.uri.toString() === uri.toString()));
            }
            await vscode.commands.executeCommand('vscode.open', files.xml);
            await waitFor('the XML archetype file as text', () => tabs().some((tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === files.xml.toString()));
            await vscode.commands.executeCommand('qbxLua.openMapViewer', files.xml);
            await waitFor('the XML archetype file in the viewer', () => tabs().some((tab) => tab.input instanceof vscode.TabInputCustom && tab.input.viewType === 'qbxLua.mapViewer' && tab.input.uri.toString() === files.xml.toString()));
        });
    }],
];
export async function runViewerHostTests(): Promise<void> {
    const failures: string[] = [];
    for (const [name, body] of tests) {
        try { await body(); console.log(`  ok   ${name}`); }
        catch (error) { failures.push(name); console.error(`  FAIL ${name}\n${error instanceof Error ? error.stack : String(error)}`); }
    }
    if (failures.length) { throw new Error(`${failures.length} viewer host test(s) failed: ${failures.join(', ')}`); }
}
