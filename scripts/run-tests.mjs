// Compiles the tests, then runs the suites that need no editor with `node --test` and the rest in
// an extension host.
// usage: node scripts/run-tests.mjs [--unit | --host | --restricted]
//   QBX_TEST_FILTER     run only the host tests whose name contains this text
//   QBX_VSCODE_VERSION  the VS Code version of the host, such as 1.85.0 (default: the current stable)
//   QBX_TEST_WORKSPACE  the fixture resources folder (default: the one of the sibling qbx-lua checkout)
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const restrictedOnly = process.argv.includes('--restricted');
const only = process.argv.includes('--unit') ? 'unit' : process.argv.includes('--host') || restrictedOnly ? 'host' : undefined;

function run(args) {
    const result = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: root });
    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

run([join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', root]);
if (only !== 'host') {
    run(['--test', join(root, 'out', 'test', 'unit.js')]);
}
if (only === 'unit') {
    process.exit(0);
}

const workspace = resolve(process.env.QBX_TEST_WORKSPACE || join(root, '..', 'qbx-lua', 'crates', 'qbx_lua_ls', 'tests', 'fixtures', 'resources'));
// The update server sometimes takes longer than the 15 seconds the downloader allows, or does not answer at all.
async function downloadVSCode(version) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await downloadAndUnzipVSCode({ version, timeout: 60000 });
        } catch (error) {
            if (attempt === 3) {
                throw error;
            }
            console.error(`Downloading VS Code failed (${error instanceof Error ? error.message : error}); trying again.`);
            await new Promise((done) => setTimeout(done, attempt * 10000));
        }
    }
}

const executable = process.env.VSCODE_EXECUTABLE_PATH || await downloadVSCode(process.env.QBX_VSCODE_VERSION || undefined);

/**
 * The fixture workspace in Restricted Mode. `runTests` always passes `--disable-workspace-trust`,
 * so this host is started directly, with a profile of its own that opens a workspace nobody
 * trusted without asking.
 */
async function runRestricted() {
    const profile = mkdtempSync(join(tmpdir(), 'qbx-editor-restricted-'));
    mkdirSync(join(profile, 'data', 'User'), { recursive: true });
    writeFileSync(join(profile, 'data', 'User', 'settings.json'), JSON.stringify({
        'security.workspace.trust.enabled': true,
        'security.workspace.trust.startupPrompt': 'never',
        'security.workspace.trust.banner': 'never',
    }));
    const args = [
        workspace, '--disable-extensions', '--no-sandbox', '--disable-gpu-sandbox', '--disable-updates', '--skip-welcome', '--skip-release-notes',
        `--user-data-dir=${join(profile, 'data')}`, `--extensions-dir=${join(profile, 'extensions')}`,
        `--extensionTestsPath=${join(root, 'out', 'test', 'suite', 'restricted.js')}`, `--extensionDevelopmentPath=${root}`,
    ];
    try {
        const code = await new Promise((done, failed) => {
            const child = spawn(executable, args, { stdio: 'inherit' });
            child.on('error', failed);
            child.on('exit', (status) => done(status ?? 1));
        });
        if (code !== 0) {
            throw new Error(`The Restricted Mode tests failed with code ${code}.`);
        }
    } finally {
        rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
}

// A profile per run: two runs that share one would hand the second to the window of the first.
const profile = mkdtempSync(join(tmpdir(), 'qbx-editor-host-'));
let failed = false;
try {
    if (!restrictedOnly) {
        await runTests({
            vscodeExecutablePath: executable,
            extensionDevelopmentPath: root,
            extensionTestsPath: join(root, 'out', 'test', 'suite', 'index.js'),
            launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust',
                `--user-data-dir=${join(profile, 'data')}`, `--extensions-dir=${join(profile, 'extensions')}`],
        });
    }
    if (restrictedOnly || !process.env.QBX_TEST_FILTER) {
        await runRestricted();
    }
} catch (error) {
    console.error(error);
    failed = true;
} finally {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(failed ? 1 : 0);
