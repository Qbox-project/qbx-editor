import { build, context } from 'esbuild';
import { readFile } from 'node:fs/promises';

const production = process.argv.includes('--production');
const options = {
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    external: ['vscode', './resourceWizard.js', './resourceDetailsBrowser.js', './runtimeToolsBrowser.js', './nuiBrowser.js', './luaUtilitiesBrowser.js', './assetBrowser.js', './assistantVscode.js'],
    // The UMD entry uses a factory-scoped require that cannot be bundled statically.
    alias: { 'jsonc-parser': 'jsonc-parser/lib/esm/main.js' },
    banner: { js: `/*!\njsonc-parser\n${await readFile(new URL('../node_modules/jsonc-parser/LICENSE.md', import.meta.url), 'utf8')}\n*/` },
    sourcemap: !production,
    minify: production,
    logLevel: 'info',
};

const webviewOptions = {
    entryPoints: ['src/referenceWebview.mts'],
    outfile: 'dist/referenceWebview.js',
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
    banner: { js: `/*!\n${await readFile(new URL('../node_modules/marked/LICENSE', import.meta.url), 'utf8')}\n*/` },
    sourcemap: !production,
    minify: production,
    logLevel: 'info',
};

const snippetOptions = {
    ...webviewOptions,
    entryPoints: ['src/snippetWebview.mts'],
    outfile: 'dist/snippetWebview.js',
    banner: undefined,
};

const wizardOptions = {
    ...options,
    entryPoints: ['src/resourceWizard.ts'],
    outfile: 'dist/resourceWizard.js',
    external: ['vscode'],
    banner: undefined,
};

const detailsOptions = { ...wizardOptions, entryPoints: ['src/resourceDetailsBrowser.ts'], outfile: 'dist/resourceDetailsBrowser.js' };
const detailsWebviewOptions = { ...snippetOptions, entryPoints: ['src/resourceDetailsWebview.mts'], outfile: 'dist/resourceDetailsWebview.js' };
const runtimeOptions = { ...wizardOptions, entryPoints: ['src/runtimeToolsBrowser.ts'], outfile: 'dist/runtimeToolsBrowser.js' };
const logWebviewOptions = { ...snippetOptions, entryPoints: ['src/runtimeLogWebview.mts'], outfile: 'dist/runtimeLogWebview.js' };
const healthWebviewOptions = { ...snippetOptions, entryPoints: ['src/workspaceHealthWebview.mts'], outfile: 'dist/workspaceHealthWebview.js' };
const nuiOptions = { ...wizardOptions, entryPoints: ['src/nuiBrowser.ts'], outfile: 'dist/nuiBrowser.js' };
const nuiWebviewOptions = { ...snippetOptions, entryPoints: ['src/nuiWebview.mts'], outfile: 'dist/nuiWebview.js' };
const nuiBridgeOptions = { ...snippetOptions, entryPoints: ['src/nuiPreviewBridge.mts'], outfile: 'dist/nuiPreviewBridge.js' };
const utilitiesOptions = { ...wizardOptions, entryPoints: ['src/luaUtilitiesBrowser.ts'], outfile: 'dist/luaUtilitiesBrowser.js', banner: options.banner };
const utilitiesWebviewOptions = { ...snippetOptions, entryPoints: ['src/luaUtilitiesWebview.mts'], outfile: 'dist/luaUtilitiesWebview.js', alias: options.alias, banner: options.banner };
const assetOptions = { ...wizardOptions, entryPoints: ['src/assetBrowser.ts'], outfile: 'dist/assetBrowser.js' };
const assetWebviewOptions = { ...snippetOptions, entryPoints: ['src/assetWebview.mts'], outfile: 'dist/assetWebview.js',
    banner: { js: '/*! Contains @bis-toolkit/bcn 1.0.2, GPL-3.0-or-later. See THIRD_PARTY_NOTICES.md and LICENSE. */' } };
const assistantOptions = { ...wizardOptions, entryPoints: ['src/assistantVscode.ts'], outfile: 'dist/assistantVscode.js' };
const mcpOptions = { ...wizardOptions, entryPoints: ['src/assistantMcp.ts'], outfile: 'dist/assistantMcp.js', external: [] };
const bundles = [options, webviewOptions, snippetOptions, wizardOptions, detailsOptions, detailsWebviewOptions, runtimeOptions, logWebviewOptions, healthWebviewOptions, nuiOptions, nuiWebviewOptions, nuiBridgeOptions,
    utilitiesOptions, utilitiesWebviewOptions, assetOptions, assetWebviewOptions, assistantOptions, mcpOptions];

if (process.argv.includes('--watch')) {
    const contexts = await Promise.all(bundles.map((options) => context(options)));
    await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
    await Promise.all(bundles.map((options) => build(options)));
}
