import { expect, test } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';
import { gateIpc } from './ipc-gate';

test('a failed design mode change shows an error and a new action clears it', async () => {
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-design-mode-failure-')));
  let gate: Awaited<ReturnType<typeof gateIpc>> | undefined;
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'System design', exact: true }).click();
    gate = await gateIpc(app, 'mode');
    await page.getByRole('button', { name: 'Coding', exact: true }).click();
    await expect.poll(() => gate!.calls()).toEqual([['coding']]);
    await gate.release(0, 'Fixture mode change failure');
    await expect(page.getByRole('alert')).toContainText('Fixture mode change failure');
    await expect(page.getByRole('button', { name: 'Coding', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect
      .poll(async () => {
        const state = await page.evaluate(() => window.interview.snapshot());
        return [state.connection, state.busy, state.mode];
      })
      .toEqual(['connected', false, 'design']);
  } finally {
    await gate?.restore();
    await app.close();
  }
});

for (const mode of ['coding', 'design'] as const) {
  test(`${mode}: repeated actions produce one request before the service busy event`, async () => {
    const app = await launch(await mkdtemp(join(tmpdir(), 'interview-action-repeat-')));
    let gate: Awaited<ReturnType<typeof gateIpc>> | undefined;
    try {
      const page = await app.firstWindow();
      await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
      if (mode === 'coding') {
        await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
        await expect(page.getByTestId('code-editor')).toBeVisible();
      } else {
        await page.getByRole('button', { name: 'System design', exact: true }).click();
        await page
          .getByRole('button', { name: /Link Alias Service/ })
          .first()
          .click();
        await expect(
          page.getByRole('textbox', { name: 'Requirements', exact: true }),
        ).toBeVisible();
      }
      gate = await gateIpc(app, mode === 'coding' ? 'hint' : 'design-start');
      const button = page.getByRole('button', {
        name: mode === 'coding' ? 'Hint' : 'New attempt',
        exact: true,
      });
      await button.evaluate((element: HTMLButtonElement) => {
        element.click();
        element.click();
      });
      await expect.poll(async () => (await gate!.calls()).length).toBeGreaterThan(0);
      // The second snapshot request reaches the main process after the click handlers.
      await page.evaluate(() => window.interview.snapshot());
      expect(
        await gate.calls(),
        'Two clicks before a busy event must produce exactly one IPC call',
      ).toHaveLength(1);
      await expect(button).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Open settings' })).toBeDisabled();
      await gate.release(0);
      await expect(button).toBeEnabled();
      const state = await page.evaluate(() => window.interview.snapshot());
      if (mode === 'coding') expect(state.sessions[0].hintDepth).toBe(1);
      else expect(state.designSessions).toHaveLength(2);
    } finally {
      await gate?.restore();
      await app.close();
    }
  });
}

test('settings lock all controls and accept one submit while the connection request is pending', async () => {
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-settings-repeat-')));
  let gate: Awaited<ReturnType<typeof gateIpc>> | undefined;
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Open settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Workbench settings' });
    gate = await gateIpc(app, 'settings');
    await dialog.locator('form').evaluate((form: HTMLFormElement) => {
      form.requestSubmit();
      form.requestSubmit();
    });
    await expect.poll(async () => (await gate!.calls()).length).toBeGreaterThan(0);
    await page.evaluate(() => window.interview.snapshot());
    expect(
      await gate.calls(),
      'Two form submits must not create two settings requests',
    ).toHaveLength(1);
    await expect(dialog.getByLabel('Provider')).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Close settings' })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Check local sandbox' })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Export practice backup' })).toBeDisabled();
    await gate.release(0);
    await expect(dialog).toHaveCount(0);
  } finally {
    await gate?.restore();
    await app.close();
  }
});

for (const mode of ['coding', 'design'] as const) {
  for (const replacement of ['', 'A newer question entered during the pending request.']) {
    test(`${mode}: a rejected chat request keeps ${replacement ? 'the newer message' : 'the unsent message'}`, async () => {
      const app = await launch(await mkdtemp(join(tmpdir(), 'interview-chat-retry-')));
      let gate: Awaited<ReturnType<typeof gateIpc>> | undefined;
      try {
        const page = await app.firstWindow();
        await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
        await page.getByRole('button', { name: 'Open settings' }).click();
        await page.getByLabel('Provider').selectOption('ollama');
        await page.getByRole('button', { name: 'Save & connect' }).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        if (mode === 'design') {
          await page.getByRole('button', { name: 'System design', exact: true }).click();
          await page
            .getByRole('button', { name: /Link Alias Service/ })
            .first()
            .click();
          await expect(
            page.getByRole('textbox', { name: 'Requirements', exact: true }),
          ).toBeVisible();
          await page.getByRole('button', { name: 'coach', exact: true }).click();
        }
        gate = await gateIpc(app, 'chat');
        const composer = page.getByRole('textbox', {
          name: mode === 'coding' ? 'Message the coach' : 'Message the design coach',
          exact: true,
        });
        const message = 'Keep this question if the request cannot start.';
        await composer.fill(message);
        await page
          .getByRole('button', {
            name: mode === 'coding' ? 'Send message' : 'Send design message',
            exact: true,
          })
          .click();
        await expect.poll(() => gate!.calls()).toEqual([[message]]);
        if (replacement) await composer.fill(replacement);
        await gate.release(0, 'Fixture chat preflight failure');
        await expect(
          page.getByRole('alert').filter({ hasText: 'Fixture chat preflight failure' }),
        ).toBeVisible();
        await expect(
          composer,
          'A rejected chat request must not discard the unsent text',
        ).toHaveValue(replacement || message);
      } finally {
        await gate?.restore();
        await app.close();
      }
    });
  }
}
