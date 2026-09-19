// Copies a locally built qbx-lua-ls into server/<platform>-<arch>/ so it gets bundled into the .vsix.
// usage: node scripts/copy-server.mjs [path-to-binary]
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const name = process.platform === 'win32' ? 'qbx-lua-ls.exe' : 'qbx-lua-ls';
const source = resolve(process.argv[2] ?? join(root, '..', 'qbx-lua-ls', 'target', 'release', name));
if (!existsSync(source)) {
    console.error(`no server binary at ${source}; build it with "cargo build --release" in qbx-lua-ls first`);
    process.exit(1);
}
const folder = join(root, 'server', `${process.platform}-${process.arch}`);
mkdirSync(folder, { recursive: true });
copyFileSync(source, join(folder, name));
if (process.platform !== 'win32') {
    chmodSync(join(folder, name), 0o755);
}
console.log(`copied ${source} -> ${join(folder, name)}`);
