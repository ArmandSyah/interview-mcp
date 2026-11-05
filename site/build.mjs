import { build } from 'esbuild';
import { validateConfig } from './src/config.js';
import { cp, mkdir, readFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
const config = JSON.parse(await readFile('public/config.json', 'utf8'));
validateConfig(config);
await cp('public', 'dist', { recursive: true });
await build({ entryPoints: ['src/app.js'], bundle: true, format: 'esm', outfile: 'dist/app.js', minify: true, target: 'es2022', sourcemap: false });
