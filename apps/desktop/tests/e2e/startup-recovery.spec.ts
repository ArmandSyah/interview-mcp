import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LocalStore } from '../../src/main/storage';
import { launch } from './desktop';

type StartupFixture = {
  attempts: number;
  spawns: number;
  dialogs: Electron.MessageBoxOptions[];
  respond?: (response: number) => void;
};
type FixtureHost = typeof globalThis & { startupFixture: StartupFixture };

for (const action of ['retry', 'close', 'window-close'] as const) {
  test(`a document load failure permits ${action} and preserves saved data`, async () => {
    test.skip(!!process.env.INTERVIEW_DESKTOP_EXECUTABLE, 'Source bootstrap injects a load error.');
    const directory = await mkdtemp(join(tmpdir(), 'interview-startup-recovery-'));
    const data = join(directory, 'data');
    const store = new LocalStore(data);
    await store.load();
    store.state.settings.model = 'saved-model-choice';
    await store.persist();
    const saved = await readFile(join(data, 'workspace.json'), 'utf8');
    const entry = join(directory, 'entry.cjs');
    await writeFile(
      entry,
      `
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const electron = require('electron');
const childProcess = require('node:child_process');
const state = globalThis.startupFixture = { attempts: 0, spawns: 0, dialogs: [] };
const originalSpawn = childProcess.spawn;
childProcess.spawn = (...args) => { state.spawns++; return originalSpawn(...args); };
const originalFetch = electron.net.fetch.bind(electron.net);
electron.net.fetch = (url, options) => {
  if (String(url).endsWith('/renderer/index.html') && ++state.attempts === 1)
    return Promise.reject(new Error('Fixture initial document load failure'));
  return originalFetch(url, options);
};
electron.dialog.showMessageBox = async (_window, options) => {
  state.dialogs.push(options);
  return new Promise(resolve => { state.respond = response => resolve({ response, checkboxChecked: false }); });
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
        .poll(() => app.evaluate(() => (globalThis as FixtureHost).startupFixture.dialogs))
        .toEqual([
          expect.objectContaining({
            title: 'Cannot load the workspace page',
            buttons: ['Retry', 'Close'],
            defaultId: 0,
            cancelId: 1,
          }),
        ]);
      expect(await readFile(join(data, 'workspace.json'), 'utf8')).toBe(saved);
      expect(await app.evaluate(() => (globalThis as FixtureHost).startupFixture.spawns)).toBe(0);
      if (action === 'retry') {
        await app.evaluate(() => (globalThis as FixtureHost).startupFixture.respond!(0));
        const page = await app.firstWindow();
        await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
        expect(await app.evaluate(() => (globalThis as FixtureHost).startupFixture.attempts)).toBe(
          2,
        );
        expect(await app.evaluate(() => (globalThis as FixtureHost).startupFixture.spawns)).toBe(1);
        const snapshot = await page.evaluate(() => window.interview.snapshot());
        expect(snapshot.settings.model).toBe('saved-model-choice');
        await app.close();
      } else {
        const exited = app.waitForEvent('close', { timeout: 5000 });
        await app.evaluate(({ BrowserWindow }, action) => {
          if (action === 'window-close') BrowserWindow.getAllWindows()[0].close();
          else (globalThis as FixtureHost).startupFixture.respond!(1);
        }, action);
        await exited;
        expect(await readFile(join(data, 'workspace.json'), 'utf8')).toBe(saved);
      }
    } finally {
      // A failing startup assertion must not leave its isolated Electron process alive.
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await app.close().catch(() => {});
    }
  });
}
