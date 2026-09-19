import { build, context } from 'esbuild';

const production = process.argv.includes('--production');
const options = {
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    external: ['vscode'],
    sourcemap: !production,
    minify: production,
    logLevel: 'info',
};

if (process.argv.includes('--watch')) {
    const ctx = await context(options);
    await ctx.watch();
} else {
    await build(options);
}
