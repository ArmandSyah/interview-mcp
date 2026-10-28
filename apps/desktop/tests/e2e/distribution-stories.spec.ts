import { expect, test } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';
import { gateIpc } from './ipc-gate';

test('configured update controls retain the channel and permit check, download, and installer retries', async () => {
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-update-controls-')));
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    // Protocol fixtures exercise renderer state. Signature and artifact checks have separate unit tests.
    await app.evaluate(({ ipcMain }) => {
      const idle = {
        state: 'idle',
        version: null,
        notes: '',
        message: 'Fixture updates configured.',
      };
      for (const channel of ['update-info', 'update-check', 'update-download', 'update-install'])
        ipcMain.removeHandler(`workbench:${channel}`);
      ipcMain.handle('workbench:update-info', () => idle);
      ipcMain.handle('workbench:update-check', () => ({
        ...idle,
        state: 'available',
        version: '0.3.0-beta.1',
        notes: 'Fixture release notes.',
        message: 'Fixture update available.',
      }));
      ipcMain.handle('workbench:update-download', () => ({
        ...idle,
        state: 'ready',
        version: '0.3.0-beta.1',
        notes: 'Fixture release notes.',
        message: 'Fixture installer ready.',
      }));
      ipcMain.handle('workbench:update-install', () => undefined);
    });
    await page.getByRole('button', { name: 'Open settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Workbench settings' });
    const channel = dialog.getByLabel('Release channel');
    await channel.selectOption('beta');
    for (const [method, label, failure] of [
      ['update-check', 'Check for signed updates', 'Fixture check failure'],
      ['update-download', 'Download verified installer', 'Fixture download failure'],
      ['update-install', 'Back up & open installer', 'Fixture backup failure'],
    ] as const) {
      const gate = await gateIpc(app, method);
      try {
        const button = dialog.getByRole('button', { name: label, exact: true });
        await expect(button).toBeEnabled();
        await button.evaluate((element) => {
          (element as HTMLButtonElement).click();
          (element as HTMLButtonElement).click();
        });
        await expect.poll(async () => (await gate.calls()).length).toBe(1);
        await expect(channel).toBeDisabled();
        await expect(
          dialog.getByRole('button', { name: 'Export practice backup', exact: true }),
        ).toBeDisabled();
        if (method === 'update-check') expect((await gate.calls())[0]).toEqual(['beta']);
        await gate.release(0, failure);
        await expect(dialog.getByRole('status').filter({ hasText: failure })).toBeVisible();
        await expect(button).toBeEnabled();
        expect(await gate.calls()).toHaveLength(1);
        await expect(channel).toHaveValue('beta');
        await button.click();
        await expect.poll(async () => (await gate.calls()).length).toBe(2);
        await gate.release(1);
        await expect(dialog.getByRole('status').filter({ hasText: 'Working…' })).toHaveCount(0);
        await expect(dialog.getByRole('status').filter({ hasText: failure })).toHaveCount(0);
        expect(await gate.calls()).toHaveLength(2);
      } finally {
        await gate.restore();
      }
    }
    await expect(
      dialog.getByText('0.3.0-beta.1: Fixture release notes.', { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Back up & open installer', exact: true }),
    ).toBeEnabled();
  } finally {
    await app.close().catch(() => {});
  }
});

test('notices display and backup picker cancellation preserve practice data', async () => {
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-distribution-cancel-')));
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    const before = await page.evaluate(() => window.interview.snapshot());
    await app.evaluate(({ dialog }) => {
      dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' });
    });
    await page.getByRole('button', { name: 'Open settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Workbench settings' });
    await dialog.getByRole('button', { name: 'View canvas & font notices', exact: true }).click();
    await expect(dialog.locator('.license-notices')).toContainText('Excalidraw');
    await dialog.getByRole('button', { name: 'Export practice backup', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Close settings' })).toBeEnabled();
    await expect(
      dialog.getByText('Practice backup exported without saved API credentials.', { exact: true }),
    ).toHaveCount(0);
    const after = await page.evaluate(() => window.interview.snapshot());
    expect(after.sessions).toEqual(before.sessions);
    expect(after.designSessions).toEqual(before.designSessions);
  } finally {
    await app.close().catch(() => {});
  }
});

test('initial distribution read failure permits close and reopen', async () => {
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-distribution-load-')));
  const gate = await gateIpc(app, 'distribution-info');
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Open settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Workbench settings' });
    await expect.poll(async () => (await gate.calls()).length).toBe(1);
    await gate.release(0, 'Fixture initial read failure');
    await expect(
      dialog.getByRole('status').filter({ hasText: 'Fixture initial read failure' }),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Close settings' }).click();
    await gate.restore();
    await page.getByRole('button', { name: 'Open settings' }).click();
    await expect(
      dialog.getByText('Signed updates are not configured in this preview build.', { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole('status').filter({ hasText: 'Fixture initial read failure' }),
    ).toHaveCount(0);
  } finally {
    await gate.restore().catch(() => {});
    await app.close().catch(() => {});
  }
});
