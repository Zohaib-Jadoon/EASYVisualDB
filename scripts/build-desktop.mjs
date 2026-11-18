import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const outDir = path.resolve(process.cwd(), 'dist-electron');
fs.mkdirSync(outDir, { recursive: true });

// 1. Electron Main Process (CommonJS)
await build({
  entryPoints: ['electron/main.ts'],
  outfile: 'dist-electron/main.cjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron'],
  sourcemap: false,
});

// 2. Electron Preload Bridge (CommonJS for sandboxed renderer)
await build({
  entryPoints: ['electron/preload.ts'],
  outfile: 'dist-electron/preload.cjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron'],
  sourcemap: false,
});

// 3. Bundled Backend Server (ESM inside Electron utilityProcess with external node_modules)
await build({
  entryPoints: ['server.ts'],
  outfile: 'dist-electron/server.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  sourcemap: false,
  banner: {
    js: '// Visual Database Studio Desktop Bundled Backend\n',
  },
});

console.log('Compiled Electron main, preload, and bundled backend into dist-electron/.');
