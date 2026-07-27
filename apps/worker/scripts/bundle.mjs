#!/usr/bin/env node
/**
 * Bundle the worker into a single self-contained file.
 *
 * Workspace packages are bundled in so they work inside the Electron asar
 * where workspace symlinks are not available.
 * Node.js built-in modules (node:*) and electron are externalized.
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

await build({
  entryPoints: [path.join(rootDir, 'src/index.ts')],
  bundle: true,
  outfile: path.join(rootDir, 'dist/index.js'),
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: false,
  minify: false,
  // Externalize Node.js built-ins and electron
  external: ['node:*', 'electron'],
});

console.log('[bundle] Worker bundled successfully');
