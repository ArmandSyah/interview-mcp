import { expect, test } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';
import { gateIpc } from './ipc-gate';

for (const credential of ['model', 'mcp'] as const) {
  test(`${credential} credential controls preserve their visible values across selection changes`, async () => {
    const app = await launch(await mkdtemp(join(tmpdir(), 'interview-settings-credential-')));
    try {
      const page = await app.firstWindow();
      await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
      await page.getByRole('button', { name: 'Open settings' }).click();
      const dialog = page.getByRole('dialog', { name: 'Workbench settings' });
      const selector = dialog.getByLabel(credential === 'model' ? 'Provider' : 'Connection');
      const option = credential === 'model' ? 'anthropic' : 'remote';
      const input = dialog.getByLabel(
        credential === 'model' ? 'Claude API key' : 'MCP bearer key or account token',
        { exact: true },
      );
      const remove = dialog.getByRole('checkbox', {
        name: credential === 'model' ? 'Remove saved API key' : 'Remove saved MCP key',
      });
      await selector.selectOption(option);
      await input.fill('fixture-value-not-a-real-credential');
      await remove.check();
      await selector.selectOption(credential === 'model' ? 'disabled' : 'local');
      await selector.selectOption(option);
      await expect(input, 'The displayed key must agree with the unsaved form value').toHaveValue(
        'fixture-value-not-a-real-credential',
      );
      await expect(remove, 'The checkbox must show the retained removal choice').toBeChecked();
      await dialog.getByRole('button', { name: 'Close settings' }).click();
      const settings = (await page.evaluate(() => window.interview.snapshot())).settings;
      expect(settings.hasApiKey).toBe(false);
      expect(settings.hasMcpKey).toBe(false);
      expect(settings.provider).toBe('disabled');
      expect(settings.connection).toBe('local');
    } finally {
      await app.close();
    }
  });
}

test('directory picker cancellation and failure keep settings editable and preserve the path', async () => {
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-settings-picker-')));
  let gate: Awaited<ReturnType<typeof gateIpc>> | undefined;
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    });
    await page.getByRole('button', { name: 'Open settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Workbench settings' });
    const path = dialog.getByPlaceholder('Bundled public examples');
    await path.fill('/fixture/original-path');
    gate = await gateIpc(app, 'corpus');
    await dialog.getByRole('button', { name: 'Browse' }).click();
    await expect.poll(() => gate!.calls()).toHaveLength(1);
    await expect(dialog.getByRole('button', { name: 'Save & connect' })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Close settings' })).toBeDisabled();
    await gate.release(0);
    await expect(path).toBeEnabled();
    await expect(path).toHaveValue('/fixture/original-path');
    await dialog.getByRole('button', { name: 'Browse' }).click();
    await expect.poll(() => gate!.calls()).toHaveLength(2);
    await gate.release(1, 'Fixture directory picker failure');
    await expect(dialog.getByRole('alert')).toContainText('Fixture directory picker failure');
    await expect(path).toHaveValue('/fixture/original-path');
    await expect(dialog.getByRole('button', { name: 'Save & connect' })).toBeEnabled();
    expect(errors).toEqual([]);
  } finally {
    await gate?.restore();
    await app.close();
  }
});

for (const operation of [
  { method: 'sandbox-inspect', button: 'Check local sandbox' },
  { method: 'license-notices', button: 'View canvas & font notices' },
] as const) {
  test(`${operation.method} blocks conflicting settings actions until its response`, async () => {
    const app = await launch(await mkdtemp(join(tmpdir(), 'interview-settings-shared-lock-')));
    let gate: Awaited<ReturnType<typeof gateIpc>> | undefined;
    try {
      const page = await app.firstWindow();
      await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
      await page.getByRole('button', { name: 'Open settings' }).click();
      const dialog = page.getByRole('dialog', { name: 'Workbench settings' });
      gate = await gateIpc(app, operation.method);
      await dialog.getByRole('button', { name: operation.button }).click();
      await expect.poll(() => gate!.calls()).toHaveLength(1);
      await expect(dialog.getByLabel('Provider')).toBeDisabled();
      await expect(dialog.getByRole('button', { name: 'Save & connect' })).toBeDisabled();
      await expect(dialog.getByRole('button', { name: 'Close settings' })).toBeDisabled();
      await expect(dialog.getByRole('button', { name: 'Export practice backup' })).toBeDisabled();
      await gate.release(0, 'Fixture settings operation failure');
      await expect(dialog.getByText(/Fixture settings operation failure/)).toBeVisible();
      await expect(dialog.getByLabel('Provider')).toBeEnabled();
      await expect(dialog.getByRole('button', { name: 'Save & connect' })).toBeEnabled();
      await dialog.getByRole('button', { name: 'Close settings' }).click();
      await expect(dialog).toHaveCount(0);
    } finally {
      await gate?.restore();
      await app.close();
    }
  });
}

test('invalid settings keep the dialog open and do not change the stored connection', async () => {
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-settings-validation-')));
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Open settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Workbench settings' });
    await dialog.getByLabel('Connection').selectOption('remote');
    await dialog.getByLabel('HTTPS MCP URL').fill('http://example.invalid/mcp');
    await dialog.getByRole('button', { name: 'Save & connect' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Use HTTPS for a remote MCP connection');
    await expect(dialog.getByLabel('HTTPS MCP URL')).toHaveValue('http://example.invalid/mcp');
    expect((await page.evaluate(() => window.interview.snapshot())).settings.connection).toBe(
      'local',
    );
    await dialog.getByLabel('Connection').selectOption('local');
    await dialog.getByLabel('Local Piston URL').fill('https://127.0.0.1:2000');
    await dialog.getByRole('button', { name: 'Save & connect' }).click();
    await expect(dialog.getByRole('alert')).toContainText(
      'Local services must use HTTP loopback URLs',
    );
    await dialog.getByLabel('Local Piston URL').fill('http://127.0.0.1:2000');
    await dialog.getByRole('button', { name: 'Save & connect' }).click();
    await expect(dialog).toHaveCount(0);
  } finally {
    await app.close();
  }
});
