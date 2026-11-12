import { expect, test } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from '../e2e/desktop';
import { recordJourney } from './recorder';

test('settings choices, cancellation, validation, notices, and local reconnect', async () => {
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-visual-settings-')));
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    const dialog = page.getByRole('dialog', { name: 'Workbench settings' });
    const initial = (await page.evaluate(() => window.interview.snapshot())).settings;
    await recordJourney(
      page,
      'settings-validation',
      'Real local settings. Dummy key only. No model requests.',
      async (step) => {
        await step(
          'Open settings',
          'The default configuration uses local practice with AI off.',
          async () => {
            await page.getByRole('button', { name: 'Open settings' }).click();
            await expect(dialog.getByLabel('Provider')).toHaveValue('disabled');
            await expect(
              dialog.getByRole('combobox', { name: 'Connection', exact: true }),
            ).toHaveValue('local');
          },
        );
        await step(
          'Inspect the local model option',
          'Ollama exposes a model name and local server address.',
          async () => {
            await dialog.getByLabel('Provider').selectOption('ollama');
            await expect(dialog.getByLabel('Model', { exact: true })).toBeVisible();
            await expect(dialog.getByLabel('Ollama URL')).toBeVisible();
            await expect(dialog.getByText(/No model is downloaded automatically/)).toBeVisible();
            expect((await page.evaluate(() => window.interview.snapshot())).settings.provider).toBe(
              'disabled',
            );
          },
        );
        await step(
          'Inspect the API key option',
          'The key field masks a dummy value and explains usage charges.',
          async () => {
            await dialog.getByLabel('Provider').selectOption('anthropic');
            const key = dialog.getByLabel('Claude API key', { exact: true });
            await key.pressSequentially('fixture-value-not-a-real-credential', { delay: 50 });
            await expect(key).toHaveAttribute('type', 'password');
            await expect(dialog.getByText(/incurs usage charges/)).toBeVisible();
          },
        );
        await step(
          'Select removal of a saved key',
          'The removal checkbox reflects the unsaved choice.',
          async () => {
            await dialog.getByRole('checkbox', { name: 'Remove saved API key' }).check();
            await expect(
              dialog.getByRole('checkbox', { name: 'Remove saved API key' }),
            ).toBeChecked();
          },
        );
        await step(
          'Cancel the settings changes',
          'Closing the dialog leaves all saved settings unchanged.',
          async () => {
            await dialog.getByRole('button', { name: 'Close settings' }).click();
            await expect(dialog).toBeHidden();
            expect((await page.evaluate(() => window.interview.snapshot())).settings).toEqual(
              initial,
            );
            await expect(page.getByRole('button', { name: 'Open settings' })).toBeFocused();
          },
        );
        await step(
          'Reopen the saved settings',
          'AI remains off and no API key was saved.',
          async () => {
            await page.getByRole('button', { name: 'Open settings' }).click();
            await expect(dialog.getByLabel('Provider')).toHaveValue('disabled');
            expect(
              (await page.evaluate(() => window.interview.snapshot())).settings.hasApiKey,
            ).toBe(false);
          },
        );
        await step(
          'Inspect the remote connection fields',
          'The remote URL and masked token fields are available.',
          async () => {
            await dialog
              .getByRole('combobox', { name: 'Connection', exact: true })
              .selectOption('remote');
            await expect(dialog.getByLabel('HTTPS MCP URL')).toBeVisible();
            await expect(
              dialog.getByLabel('MCP bearer key or account token', { exact: true }),
            ).toHaveAttribute('type', 'password');
            await dialog.getByLabel('HTTPS MCP URL').scrollIntoViewIfNeeded();
          },
        );
        await step(
          'Reject an insecure remote address',
          'The dialog explains that remote connections require HTTPS.',
          async () => {
            await dialog.getByLabel('HTTPS MCP URL').fill('http://example.invalid/mcp');
            await dialog.getByRole('button', { name: 'Save & connect' }).click();
            await expect(dialog.getByRole('alert')).toContainText(
              'Use HTTPS for a remote MCP connection',
            );
            await expect(dialog.getByRole('alert')).toBeFocused();
            expect(
              (await page.evaluate(() => window.interview.snapshot())).settings.connection,
            ).toBe('local');
          },
        );
        await step(
          'Reject an invalid local execution address',
          'The dialog explains the HTTP loopback requirement.',
          async () => {
            await dialog
              .getByRole('combobox', { name: 'Connection', exact: true })
              .selectOption('local');
            await dialog.getByLabel('Local Piston URL').fill('https://127.0.0.1:2000');
            await dialog.getByRole('button', { name: 'Save & connect' }).click();
            await expect(dialog.getByRole('alert')).toContainText(
              'Local services must use HTTP loopback URLs',
            );
            expect(
              (await page.evaluate(() => window.interview.snapshot())).settings.pistonUrl,
            ).toBe(initial.pistonUrl);
          },
        );
        await step(
          'Inspect canvas and font notices',
          'The app shows its bundled license notices.',
          async () => {
            await dialog
              .getByRole('button', { name: 'View canvas & font notices', exact: true })
              .click();
            await expect(dialog.locator('.license-notices')).toContainText('Excalidraw');
            await dialog.locator('.license-notices').scrollIntoViewIfNeeded();
          },
        );
        await step(
          'Save the corrected local configuration',
          'The real local MCP reconnects and closes the settings dialog.',
          async () => {
            await dialog.getByLabel('Local Piston URL').fill('http://127.0.0.1:2000');
            await dialog.getByRole('button', { name: 'Save & connect' }).click();
            await expect(dialog).toBeHidden();
            await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({
              timeout: 20_000,
            });
            const settings = (await page.evaluate(() => window.interview.snapshot())).settings;
            expect(settings.connection).toBe('local');
            expect(settings.provider).toBe('disabled');
            expect(settings.hasApiKey).toBe(false);
          },
        );
      },
    );
  } finally {
    await app.close();
  }
});
