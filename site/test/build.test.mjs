import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const buildScript = fileURLToPath(new URL('../build.mjs', import.meta.url));
const publicSource = fileURLToPath(new URL('../public/', import.meta.url));
test('build excludes unlisted public files and removes stale output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'interview-site-build-'));
  try {
    await cp(publicSource, join(directory, 'public'), { recursive: true });
    await symlink(fileURLToPath(new URL('../src/', import.meta.url)), join(directory, 'src'), 'dir');
    await writeFile(join(directory, 'public', 'private-notes.txt'), 'DO_NOT_PUBLISH');
    await mkdir(join(directory, 'dist'));
    await writeFile(join(directory, 'dist', 'old-settings.json'), 'DO_NOT_PUBLISH');
    const result = spawnSync(process.execPath, [buildScript], { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await readdir(join(directory, 'dist'))).sort(), ['app.js', 'coding-workbench.png', 'config.json', 'design-workbench.png', 'index.html', 'styles.css']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('invalid configuration cannot replace a previously safe build', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'interview-site-build-'));
  try {
    await cp(publicSource, join(directory, 'public'), { recursive: true });
    await symlink(fileURLToPath(new URL('../src/', import.meta.url)), join(directory, 'src'), 'dir');
    await writeFile(join(directory, 'public', 'config.json'), JSON.stringify({ paymentMode: 'sandbox', paddleClientToken: 'pdl_sdbx_apikey_example' }));
    await mkdir(join(directory, 'dist'));
    await writeFile(join(directory, 'dist', 'config.json'), '{}');
    const result = spawnSync(process.execPath, [buildScript], { cwd: directory, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(join(directory, 'dist', 'config.json'), 'utf8'), '{}');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
