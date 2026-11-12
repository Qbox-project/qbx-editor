import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { runAnimDataTests } from './suite/animData';
import { runAssetTests } from './suite/assets';
import { runAssistantToolsTests } from './suite/assistantTools';
import { runCheckTests } from './suite/checks';
import { runLuaUtilitiesCoreTests } from './suite/luaUtilities';
import { runMapDataTests } from './suite/mapData';
import { runModelDataTests } from './suite/modelData';
import { runNuiPreviewServerTests } from './suite/nuiPreviewServer';
import { runRconTests } from './suite/rcon';
import { runRuntimeLogCoreTests } from './suite/runtimeLogCore';
import { runTextureEditTests } from './suite/textureEdit';

// out/test/unit.js: the packaged MCP entry and the bundled server sit two folders up.
const root = path.resolve(__dirname, '..', '..');
const server = path.join(root, 'server', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'qbx-lua-ls.exe' : 'qbx-lua-ls');
const packaged = existsSync(path.join(root, 'dist', 'assistantMcp.js')) && existsSync(server);

/**
 * The suites that need no editor: `node --test` runs them in seconds on any platform, without a
 * VS Code download or the sibling language-server checkout. `scripts/run-tests.mjs` runs the rest
 * in an extension host.
 */
const suites: [name: string, run: () => Promise<void>][] = [
    ['RCON transport uses exact targets and bounded authenticated responses', runRconTests],
    ['runtime log following, bounds and trace parsing', runRuntimeLogCoreTests],
    ['NUI local asset serving, isolation and lifetime', runNuiPreviewServerTests],
    ['Lua utility calculations and conversion', runLuaUtilitiesCoreTests],
    ['Asset formats, texture decoding and bounded inventory', runAssetTests],
    ['Texture editing: PNG input, mip levels, encodings and dictionary writing', runTextureEditTests],
    ['Map data decoding, XML export, world placement and Lua snippets', runMapDataTests],
    ['Model and collision decoding', runModelDataTests],
    ['Animation decoding and ped skeleton poses', runAnimDataTests],
    ['Resource data checks, locale matrix and their reports', runCheckTests],
    [`Structured assistant tools and portable MCP${packaged ? '' : ' (packaged server not built: process test skipped)'}`, () => runAssistantToolsTests({ editor: false, packaged })],
];

for (const [name, run] of suites) {
    test(name, { timeout: 120000 }, run);
}
