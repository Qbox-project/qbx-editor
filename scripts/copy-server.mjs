// Builds the sibling qbx-lua-ls checkout in release mode and copies it into server/<platform>-<arch>/ so it gets bundled into the .vsix.
// usage: node scripts/copy-server.mjs [path-to-prebuilt-binary]
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const name = process.platform === 'win32' ? 'qbx-lua-ls.exe' : 'qbx-lua-ls';
const checkout = join(root, '..', 'qbx-lua-ls');
const source = resolve(process.argv[2] ?? join(checkout, 'target', 'release', name));
if (!process.argv[2] && existsSync(join(checkout, 'Cargo.toml'))) {
    const build = spawnSync('cargo', ['build', '--release', '--locked'], { cwd: checkout, stdio: 'inherit' });
    if (build.status !== 0) {
        process.exit(build.status ?? 1);
    }
}
if (!existsSync(source)) {
    console.error(`no server binary at ${source}`);
    process.exit(1);
}
const folder = join(root, 'server', `${process.platform}-${process.arch}`);
mkdirSync(folder, { recursive: true });
copyFileSync(source, join(folder, name));
if (process.platform !== 'win32') {
    chmodSync(join(folder, name), 0o755);
}
console.log(`copied ${source} -> ${join(folder, name)}`);
