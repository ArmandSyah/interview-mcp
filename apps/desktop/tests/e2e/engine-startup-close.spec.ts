import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch } from './desktop';
import { pasteAccountDraft } from './account-fixture';

type StartupHost = typeof globalThis & {
  engineStartup: { held: boolean; pid?: number; spawns: number };
};

for (const stage of [
  'initialize',
  'tools/list',
  'list_problems',
  'get_progress',
  'list_design_problems',
  'list_content_packs',
]) {
  test(`close during engine ${stage} preserves practice and stops the backend`, async () => {
    test.skip(
      !!process.env.INTERVIEW_DESKTOP_EXECUTABLE,
      'The source fixture holds a backend response.',
    );
    const data = await mkdtemp(join(tmpdir(), 'interview-engine-startup-close-'));
    const seed = await launch(data);
    try {
      const page = await seed.firstWindow();
      await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
      await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
      await pasteAccountDraft(page, '# Preserve practice through interrupted engine startup.\n');
    } finally {
      await seed.close();
    }
    const saved = await readFile(join(data, 'workspace.json'), 'utf8');
    const exited = join(data, 'backend-exited');
    const entry = join(data, 'startup-entry.cjs');
    await writeFile(
      entry,
      String.raw`
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const childProcess = require('node:child_process');
const state = globalThis.engineStartup = { held: false, spawns: 0 };
const spawn = childProcess.spawn;
childProcess.spawn = (...args) => {
  const child = spawn(...args);
  state.spawns++;
  state.pid = child.pid;
  child.once('exit', () => fs.writeFileSync(${JSON.stringify(exited)}, 'exited'));
  const write = child.stdin.write.bind(child.stdin);
  const emit = child.stdout.emit.bind(child.stdout);
  let requestBuffer = '', responseBuffer = '', heldId;
  child.stdin.write = (chunk, ...rest) => {
    requestBuffer += chunk.toString();
    let newline;
    while ((newline = requestBuffer.indexOf('\n')) >= 0) {
      const line = requestBuffer.slice(0, newline);
      requestBuffer = requestBuffer.slice(newline + 1);
      const message = JSON.parse(line);
      if ((message.method === 'tools/call' ? message.params.name : message.method) === ${JSON.stringify(stage)}) heldId = message.id;
    }
    return write(chunk, ...rest);
  };
  child.stdout.emit = (event, ...args) => {
    if (event !== 'data') return emit(event, ...args);
    responseBuffer += args[0].toString();
    let newline;
    while ((newline = responseBuffer.indexOf('\n')) >= 0) {
      const line = responseBuffer.slice(0, newline);
      responseBuffer = responseBuffer.slice(newline + 1);
      const message = JSON.parse(line);
      if (heldId !== undefined && message.id === heldId) state.held = true;
      else emit('data', Buffer.from(line + '\n'));
    }
    return true;
  };
  return child;
};
const original = ${JSON.stringify(resolve('dist/main/index.cjs'))};
const loaded = new Module(original, module);
loaded.filename = original;
loaded.paths = Module._nodeModulePaths(path.dirname(original));
loaded._compile(fs.readFileSync(original, 'utf8'), original);
`,
    );
    const app = await launch(data, '', entry);
    try {
      await expect
        .poll(() => app.evaluate(() => (globalThis as StartupHost).engineStartup.held), {
          timeout: 20_000,
        })
        .toBe(true);
      const state = await app.evaluate(() => (globalThis as StartupHost).engineStartup);
      expect(state.spawns).toBe(1);
      expect(state.pid).toBeGreaterThan(0);
      let closed = false;
      app.on('close', () => {
        closed = true;
      });
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
      await expect
        .poll(() => closed, {
          timeout: 5000,
          message: `${stage}: close must cancel startup without waiting for its response`,
        })
        .toBe(true);
      await expect.poll(() => readFile(exited, 'utf8').catch(() => '')).toBe('exited');
      expect(() => process.kill(state.pid!, 0), `${stage}: backend process must stop`).toThrow();
      expect(await readFile(join(data, 'workspace.json'), 'utf8')).toBe(saved);
    } finally {
      // A failing scenario must stop its isolated backend before force-exiting Electron.
      await app
        .evaluate(({ app }) => {
          const pid = (globalThis as StartupHost).engineStartup.pid;
          if (pid) {
            try {
              process.kill(pid);
            } catch {}
          }
          app.exit(0);
        })
        .catch(() => {});
      await app.close().catch(() => {});
    }
  });
}
