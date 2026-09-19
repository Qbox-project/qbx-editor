import { runTests } from '@vscode/test-electron';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compiled = spawnSync('npx', ['tsc', '-p', root], { stdio: 'inherit', shell: true });
if (compiled.status !== 0) {
    process.exit(compiled.status ?? 1);
}

const workspace = resolve(root, '..', 'qbx-lua-ls', 'tests', 'fixtures', 'resources');
try {
    await runTests({
        extensionDevelopmentPath: root,
        extensionTestsPath: join(root, 'out', 'test', 'suite', 'index.js'),
        launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust'],
    });
} catch (error) {
    console.error(error);
    process.exit(1);
}
