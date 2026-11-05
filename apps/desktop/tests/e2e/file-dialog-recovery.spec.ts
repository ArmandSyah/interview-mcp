import { expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../../src/main/storage';
import { launch } from './desktop';
import { pasteAccountDraft } from './account-fixture';
import { gateIpc } from './ipc-gate';

type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown;
type RecoveryFixture = {
  selections: ((result: Electron.SaveDialogReturnValue) => void)[];
  results: unknown[];
  holdWrite: boolean;
  writeHeld: boolean;
  temporary?: string;
  releaseWrite?: () => void;
  failWorkspace: boolean;
  failedWrites: number;
  restore: () => void;
};
type FixtureHost = typeof globalThis & { fileRecovery: RecoveryFixture };

async function holdExport(app: ElectronApplication, destination: string, workspace: string) {
  await app.evaluate(
    ({ dialog, ipcMain }, { destination, workspace }) => {
      const fs = process.getBuiltinModule('node:fs/promises');
      const originalRename = fs.rename;
      const originalDialog = dialog.showSaveDialog;
      const ipc = ipcMain as Electron.IpcMain & { _invokeHandlers: Map<string, Handler> };
      const channel = 'workbench:export';
      const originalHandler = ipc._invokeHandlers.get(channel);
      if (!originalHandler) throw new Error('No solution export handler');
      const state: RecoveryFixture = {
        selections: [],
        results: [],
        holdWrite: false,
        writeHeld: false,
        failWorkspace: false,
        failedWrites: 0,
        restore: () => {
          fs.rename = originalRename;
          dialog.showSaveDialog = originalDialog;
          ipc.removeHandler(channel);
          ipc.handle(channel, originalHandler);
          state.releaseWrite?.();
          for (const select of state.selections) select({ canceled: true, filePath: '' });
        },
      };
      (globalThis as FixtureHost).fileRecovery = state;
      dialog.showSaveDialog = (() =>
        new Promise<Electron.SaveDialogReturnValue>((resolve) => {
          state.selections.push(resolve);
        })) as typeof dialog.showSaveDialog;
      fs.rename = async (from, to) => {
        if (to === workspace && state.failWorkspace) {
          state.failedWrites++;
          throw new Error('Fixture final workspace write failure');
        }
        if (to === destination && state.holdWrite) {
          state.temporary = String(from);
          state.writeHeld = true;
          await new Promise<void>((resolve) => {
            state.releaseWrite = resolve;
          });
        }
        return originalRename(from, to);
      };
      ipc.removeHandler(channel);
      ipc.handle(channel, async (event, ...args) => {
        const result = await originalHandler(event, ...args);
        state.results.push(result);
        return result;
      });
    },
    { destination, workspace },
  );
}

async function releaseSelection(app: ElectronApplication, index: number, filePath: string) {
  await app.evaluate(
    (_electron, { index, filePath }) => {
      const select = (globalThis as FixtureHost).fileRecovery.selections[index];
      if (!select) throw new Error(`No file selection ${index}`);
      select({ canceled: false, filePath });
    },
    { index, filePath },
  );
}

test('native close waits for an accepted export write and preserves the latest draft', async () => {
  const data = await mkdtemp(join(tmpdir(), 'interview-export-close-write-'));
  const destination = join(data, 'solution.py');
  await writeFile(destination, '# Previous export\n');
  const app = await launch(data);
  let close: Awaited<ReturnType<typeof gateIpc>> | undefined;
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
    const exported = '# Complete export captured before close\n';
    await pasteAccountDraft(page, exported);
    await holdExport(app, destination, join(data, 'workspace.json'));
    await app.evaluate(() => {
      (globalThis as FixtureHost).fileRecovery.holdWrite = true;
    });
    close = await gateIpc(app, 'close-ready');
    await page.getByRole('button', { name: 'Export solution', exact: true }).click();
    await expect
      .poll(() => app.evaluate(() => (globalThis as FixtureHost).fileRecovery.selections.length))
      .toBe(1);
    await releaseSelection(app, 0, destination);
    await expect
      .poll(() => app.evaluate(() => (globalThis as FixtureHost).fileRecovery.writeHeld))
      .toBe(true);
    const temporary = await app.evaluate(() => (globalThis as FixtureHost).fileRecovery.temporary!);
    expect(await readFile(temporary, 'utf8')).toBe(exported);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    const latest = '# Draft entered while close waits for the accepted export\n';
    await pasteAccountDraft(page, latest);
    expect(await close.calls(), 'Close must wait for the accepted file replacement').toEqual([]);
    expect(page.isClosed()).toBe(false);
    expect(await readFile(destination, 'utf8')).toBe('# Previous export\n');
    await app.evaluate(() => (globalThis as FixtureHost).fileRecovery.releaseWrite!());
    await expect.poll(() => close!.calls()).toEqual([[true]]);
    expect(await readFile(destination, 'utf8')).toBe(exported);
    expect((await page.evaluate(() => window.interview.snapshot())).sessions[0].code).toBe(latest);
    expect((await readdir(data)).filter((name) => name.startsWith('.interview-export-'))).toEqual(
      [],
    );
    await close.restore();
    close = undefined;
    await app.close();
    const saved = new LocalStore(data);
    await saved.load();
    expect(Object.values(saved.state.workspaces).flatMap((item) => item.sessions)[0].code).toBe(
      latest,
    );
  } finally {
    await app.evaluate(() => (globalThis as FixtureHost).fileRecovery?.restore()).catch(() => {});
    await close?.restore().catch(() => {});
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
});

test('a failed final save cannot revive an old selection and permits a fresh export', async () => {
  const data = await mkdtemp(join(tmpdir(), 'interview-export-close-retry-'));
  const destination = join(data, 'solution.py');
  await writeFile(destination, '# Previous export\n');
  const app = await launch(data);
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
    const code = '# Keep this practice through the failed close\n';
    await pasteAccountDraft(page, code);
    const before = await readFile(join(data, 'workspace.json'), 'utf8');
    await holdExport(app, destination, join(data, 'workspace.json'));
    await page.getByRole('button', { name: 'Export solution', exact: true }).click();
    await expect
      .poll(() => app.evaluate(() => (globalThis as FixtureHost).fileRecovery.selections.length))
      .toBe(1);
    await app.evaluate(({ BrowserWindow }) => {
      (globalThis as FixtureHost).fileRecovery.failWorkspace = true;
      BrowserWindow.getAllWindows()[0]!.close();
    });
    const error = page.getByRole('dialog', { name: 'Cannot close workspace' });
    await expect(error.getByRole('alert')).toContainText('Fixture final workspace write failure');
    expect(await app.evaluate(() => (globalThis as FixtureHost).fileRecovery.failedWrites)).toBe(1);
    expect(await app.evaluate(() => (globalThis as FixtureHost).fileRecovery.results)).toEqual([
      null,
    ]);
    expect(await readFile(join(data, 'workspace.json'), 'utf8')).toBe(before);
    await app.evaluate(() => {
      (globalThis as FixtureHost).fileRecovery.failWorkspace = false;
    });
    await error.getByRole('button', { name: 'Continue practice', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Export solution', exact: true })).toBeEnabled();
    await releaseSelection(app, 0, destination);
    await page.evaluate(() => window.interview.snapshot());
    expect(await readFile(destination, 'utf8')).toBe('# Previous export\n');
    expect(await app.evaluate(() => (globalThis as FixtureHost).fileRecovery.results)).toEqual([
      null,
    ]);
    await page.getByRole('button', { name: 'Export solution', exact: true }).click();
    await expect
      .poll(() => app.evaluate(() => (globalThis as FixtureHost).fileRecovery.selections.length))
      .toBe(2);
    await releaseSelection(app, 1, destination);
    await expect
      .poll(() => app.evaluate(() => (globalThis as FixtureHost).fileRecovery.results))
      .toEqual([null, destination]);
    await expect(page.getByRole('button', { name: 'Export solution', exact: true })).toBeEnabled();
    expect(await readFile(destination, 'utf8')).toBe(code);
    expect((await page.evaluate(() => window.interview.snapshot())).sessions[0].code).toBe(code);
    await app.close();
    const saved = new LocalStore(data);
    await saved.load();
    expect(Object.values(saved.state.workspaces).flatMap((item) => item.sessions)[0].code).toBe(
      code,
    );
  } finally {
    await app.evaluate(() => (globalThis as FixtureHost).fileRecovery?.restore()).catch(() => {});
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
});
