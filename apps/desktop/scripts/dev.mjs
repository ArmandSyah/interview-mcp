import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import { build } from 'esbuild';
import electron from 'electron';

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
const vite = await createServer();
await vite.listen();
const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, INTERVIEW_DESKTOP_DEV_URL: 'http://127.0.0.1:5173' },
});
child.on('exit', async (code) => {
  await vite.close();
  process.exit(code ?? 0);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
