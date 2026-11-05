import { build } from 'esbuild';
import { validateConfig } from './src/config.js';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
const config = JSON.parse(await readFile('public/config.json', 'utf8'));
validateConfig(config);
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
for (const file of ['index.html', 'styles.css', 'config.json', 'coding-workbench.png', 'design-workbench.png']) {
  await cp(`public/${file}`, `dist/${file}`);
}
await build({ entryPoints: ['src/app.js'], bundle: true, format: 'esm', outfile: 'dist/app.js', minify: true, target: 'es2022', sourcemap: false });
