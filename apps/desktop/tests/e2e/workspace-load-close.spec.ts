import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LocalStore } from '../../src/main/storage';
import { launch } from './desktop';

type LoadFailureHost = typeof globalThis & {
  workspaceLoadFailure: { dialogs: Electron.MessageBoxOptions[]; spawns: number };
};

for (const failure of ['invalid JSON', 'invalid settings']) {
  test(`native close preserves ${failure} while the startup error is unanswered`, async () => {
    test.skip(
      !!process.env.INTERVIEW_DESKTOP_EXECUTABLE,
      'The source fixture holds the error dialog.',
    );
    const data = await mkdtemp(join(tmpdir(), 'interview-workspace-load-close-'));
    const store = new LocalStore(data);
    await store.load();
    await store.persist();
    const path = join(data, 'workspace.json');
    const saved =
      failure === 'invalid JSON'
        ? '{"version": 2, "unfinished":'
        : JSON.stringify({
            ...store.state,
            settings: { ...store.state.settings, managedSandbox: 'invalid' },
          });
    await writeFile(path, saved);
    const entry = join(data, 'load-error-entry.cjs');
    await writeFile(
      entry,
      `
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const electron = require('electron');
const childProcess = require('node:child_process');
const state = globalThis.workspaceLoadFailure = { dialogs: [], spawns: 0 };
const spawn = childProcess.spawn;
childProcess.spawn = (...args) => { state.spawns++; return spawn(...args); };
electron.dialog.showMessageBox = (_parent, options) => {
  state.dialogs.push(options);
  return new Promise(() => {});
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
        .poll(() =>
          app.evaluate(() => (globalThis as LoadFailureHost).workspaceLoadFailure.dialogs),
        )
        .toEqual([
          expect.objectContaining({
            title: 'Cannot open workspace',
            message: expect.stringContaining('not been overwritten'),
          }),
        ]);
      expect(
        await app.evaluate(() => (globalThis as LoadFailureHost).workspaceLoadFailure.spawns),
      ).toBe(0);
      let closed = false;
      app.on('close', () => {
        closed = true;
      });
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
      await expect
        .poll(() => closed, {
          timeout: 5000,
          message: `${failure}: close must not require an error-dialog response`,
        })
        .toBe(true);
      expect(await readFile(path, 'utf8')).toBe(saved);
    } finally {
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await app.close().catch(() => {});
    }
  });
}
