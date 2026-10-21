import { expect, test } from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';

test('a settings write failure preserves the connection and credentials, and permits a retry', async () => {
  const data = await mkdtemp(join(tmpdir(), 'interview-settings-write-'));
  let app = await launch(data);
  let fault = false;
  const restore = () =>
    app.evaluate(({ ipcMain }) => {
      const ipc = ipcMain as Electron.IpcMain & {
        settingsRename?: typeof import('node:fs/promises').rename;
      };
      if (!ipc.settingsRename) return;
      process.getBuiltinModule('node:fs/promises').rename = ipc.settingsRename;
      delete ipc.settingsRename;
    });
  try {
    let page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
    await expect(page.getByRole('button', { name: 'Open settings' })).toBeEnabled();
    const before = await page.evaluate(() => window.interview.snapshot());
    const disk = await readFile(join(data, 'workspace.json'), 'utf8');
    await page.getByRole('button', { name: 'Open settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Workbench settings' });
    await dialog.getByLabel('Provider').selectOption('anthropic');
    await dialog.getByLabel('Claude API key', { exact: true }).fill('fixture-api-not-a-real-key');
    await dialog.getByLabel('Connection').selectOption('remote');
    await dialog.getByLabel('HTTPS MCP URL').fill('http://127.0.0.1:1/mcp');
    await dialog
      .getByLabel('MCP bearer key or account token', { exact: true })
      .fill('fixture-mcp-not-a-real-key');
    await app.evaluate(
      ({ ipcMain }, path) => {
        const fs = process.getBuiltinModule(
          'node:fs/promises',
        ) as typeof import('node:fs/promises');
        const ipc = ipcMain as Electron.IpcMain & { settingsRename?: typeof fs.rename };
        ipc.settingsRename = fs.rename;
        fs.rename = async (from, to) => {
          if (to === path) throw new Error('Fixture settings write failure');
          return ipc.settingsRename!(from, to);
        };
      },
      join(data, 'workspace.json'),
    );
    fault = true;
    await dialog.getByRole('button', { name: 'Save & connect' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Fixture settings write failure');
    expect(
      await page.evaluate(() => window.interview.snapshot()),
      'A failed settings write must retain the previous snapshot',
    ).toEqual(before);
    expect(await readFile(join(data, 'workspace.json'), 'utf8')).toBe(disk);
    await expect(dialog.getByLabel('Claude API key', { exact: true })).toHaveValue(
      'fixture-api-not-a-real-key',
    );
    await expect(dialog.getByLabel('MCP bearer key or account token', { exact: true })).toHaveValue(
      'fixture-mcp-not-a-real-key',
    );
    await restore();
    fault = false;
    await dialog.getByLabel('Connection').selectOption('local');
    await dialog.getByLabel('Provider').selectOption('ollama');
    await dialog.getByRole('button', { name: 'Save & connect' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible();
    const saved = await page.evaluate(() => window.interview.snapshot());
    expect(saved.settings.provider).toBe('ollama');
    expect(saved.settings.hasApiKey).toBe(true);
    expect(saved.settings.hasMcpKey).toBe(true);
    expect(saved.sessions).toEqual(before.sessions);
    expect(errors).toEqual([]);
    await app.close();
    app = await launch(data);
    page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    const reopened = await page.evaluate(() => window.interview.snapshot());
    expect(reopened.settings.provider).toBe('ollama');
    expect(reopened.sessions).toEqual(before.sessions);
  } finally {
    if (fault) await restore().catch(() => {});
    await app.close().catch(() => {});
  }
});
