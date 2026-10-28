import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';
import { gateIpc } from './ipc-gate';
import type { SandboxStatus } from '../../src/shared/sandbox';

const ready: SandboxStatus = {
  phase: 'ready',
  managed: true,
  message: 'Fixture sandbox ready',
};

async function event(app: ElectronApplication, status: SandboxStatus) {
  await app.evaluate(({ BrowserWindow }, status) => {
    BrowserWindow.getAllWindows()[0]!.webContents.send('workbench:event', {
      type: 'sandbox',
      status,
    });
  }, status);
}

async function consumeReply(page: Page) {
  // Give IPC delivery and React commits an opportunity before retained-state assertions.
  // The pre-fix run must reproduce each overwrite with this IPC/frame barrier.
  await page.evaluate(async () => {
    await window.interview.snapshot();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}

for (const initial of ['status', 'error'] as const) {
  for (const later of ['event', 'action result', 'action error'] as const) {
    test(`a late initial sandbox ${initial} preserves the later ${later}`, async () => {
      const app = await launch(await mkdtemp(join(tmpdir(), 'interview-sandbox-status-')));
      let info: Awaited<ReturnType<typeof gateIpc>> | undefined;
      let inspect: Awaited<ReturnType<typeof gateIpc>> | undefined;
      try {
        const page = await app.firstWindow();
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
        info = await gateIpc(app, 'sandbox-info', 'response');
        await page.getByRole('button', { name: 'Open settings' }).click();
        const dialog = page.getByRole('dialog', { name: 'Workbench settings' });
        const sandbox = dialog.locator('.sandbox-settings');
        const status = sandbox.getByRole('status');
        await expect.poll(() => info!.calls()).toHaveLength(1);
        await expect(status).toHaveText('Loading sandbox settings…');
        if (later === 'event') {
          await event(app, ready);
          await expect(status).toHaveText(ready.message);
          await expect(
            sandbox.getByRole('button', { name: 'Stop app-owned sandbox' }),
          ).toBeEnabled();
        } else {
          if (later === 'action result') {
            await app.evaluate(({ ipcMain }, status) => {
              ipcMain.removeHandler('workbench:sandbox-inspect');
              ipcMain.handle('workbench:sandbox-inspect', () => status);
            }, ready);
          }
          inspect = await gateIpc(app, 'sandbox-inspect');
          await sandbox.getByRole('button', { name: 'Check local sandbox' }).click();
          await expect.poll(() => inspect!.calls()).toHaveLength(1);
          await inspect.release(0, later === 'action error' ? 'Fixture check failed' : undefined);
          await expect(dialog.getByRole('button', { name: 'Close settings' })).toBeEnabled();
          if (later === 'action error') {
            await expect(sandbox.getByRole('alert')).toContainText('Fixture check failed');
          } else {
            await expect(status).toHaveText(ready.message);
          }
        }
        const before = await sandbox.textContent();
        await info.release(0, initial === 'error' ? 'Fixture initial read failed' : undefined);
        await consumeReply(page);
        expect(
          await sandbox.textContent(),
          `sandboxInfo() returned ${initial} after ${later}; the later panel state must remain visible`,
        ).toBe(before);
        if (later === 'event') {
          await expect(
            sandbox.getByRole('button', { name: 'Stop app-owned sandbox' }),
          ).toBeEnabled();
        }
        expect(errors).toEqual([]);
      } finally {
        await inspect?.restore();
        await info?.restore();
        await app.close();
      }
    });
  }
}

for (const initial of ['status', 'error'] as const) {
  test(`an accepted sandbox action supersedes an initial ${initial} before the action completes`, async () => {
    const app = await launch(await mkdtemp(join(tmpdir(), 'interview-sandbox-pending-')));
    let info: Awaited<ReturnType<typeof gateIpc>> | undefined;
    let inspect: Awaited<ReturnType<typeof gateIpc>> | undefined;
    try {
      const page = await app.firstWindow();
      await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
      info = await gateIpc(app, 'sandbox-info', 'response');
      await app.evaluate(({ ipcMain }, status) => {
        ipcMain.removeHandler('workbench:sandbox-inspect');
        ipcMain.handle('workbench:sandbox-inspect', () => status);
      }, ready);
      inspect = await gateIpc(app, 'sandbox-inspect');
      await page.getByRole('button', { name: 'Open settings' }).click();
      const dialog = page.getByRole('dialog', { name: 'Workbench settings' });
      const sandbox = dialog.locator('.sandbox-settings');
      await expect.poll(() => info!.calls()).toHaveLength(1);
      await sandbox.getByRole('button', { name: 'Check local sandbox' }).click();
      await expect.poll(() => inspect!.calls()).toHaveLength(1);
      await expect(dialog.getByRole('button', { name: 'Close settings' })).toBeDisabled();
      const pending = await sandbox.textContent();
      await info.release(0, initial === 'error' ? 'Fixture initial read failed' : undefined);
      await consumeReply(page);
      expect(
        await sandbox.textContent(),
        `sandboxInfo() returned ${initial} while inspectSandbox() was pending; initial state must not appear`,
      ).toBe(pending);
      await inspect.release(0);
      await expect(sandbox.getByRole('status')).toHaveText(ready.message);
      await expect(sandbox.getByRole('alert')).toHaveCount(0);
    } finally {
      await inspect?.restore();
      await info?.restore();
      await app.close();
    }
  });
}

test('an initial sandbox read error permits a check retry and a fresh read after reopen', async () => {
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-sandbox-read-')));
  let info: Awaited<ReturnType<typeof gateIpc>> | undefined;
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    info = await gateIpc(app, 'sandbox-info');
    await page.getByRole('button', { name: 'Open settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Workbench settings' });
    const sandbox = dialog.locator('.sandbox-settings');
    await expect.poll(() => info!.calls()).toHaveLength(1);
    await info.release(0, 'Fixture initial read failed');
    await expect(sandbox.getByRole('alert')).toContainText('Fixture initial read failed');
    await app.evaluate(({ ipcMain }, status) => {
      ipcMain.removeHandler('workbench:sandbox-inspect');
      ipcMain.handle('workbench:sandbox-inspect', () => status);
    }, ready);
    await sandbox.getByRole('button', { name: 'Check local sandbox' }).click();
    await expect(sandbox.getByRole('status')).toHaveText(ready.message);
    await expect(sandbox.getByRole('alert')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Close settings' }).click();
    await expect(dialog).toHaveCount(0);
    await info.restore();
    info = undefined;
    await page.getByRole('button', { name: 'Open settings' }).click();
    await expect(sandbox.getByRole('status')).not.toHaveText('Loading sandbox settings…');
    await expect(sandbox.getByRole('status')).not.toHaveText(ready.message);
    await expect(sandbox.getByRole('alert')).toHaveCount(0);
  } finally {
    await info?.restore();
    await app.close();
  }
});
