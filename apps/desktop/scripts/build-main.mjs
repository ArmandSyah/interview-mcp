import { build } from 'esbuild';

await build({
  entryPoints: ['src/main/index.ts', 'src/main/preload.ts'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  outdir: 'dist/main',
  outExtension: { '.js': '.cjs' },
  external: ['electron'],
  sourcemap: true,
});
