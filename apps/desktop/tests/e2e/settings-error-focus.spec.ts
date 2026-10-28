import { expect, test } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';
import { gateIpc } from './ipc-gate';

for (const mode of ['coding', 'design'] as const) {
  test(`${mode}: a settings error stays in view after keyboard submission`, async () => {
    const app = await launch(await mkdtemp(join(tmpdir(), 'interview-settings-keyboard-error-')));
    let save: Awaited<ReturnType<typeof gateIpc>> | undefined;
    try {
      const page = await app.firstWindow();
      await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
      if (mode === 'design')
        await page.getByRole('button', { name: 'System design', exact: true }).click();
      await page.setViewportSize({ width: 1040, height: 633 });
      await page.getByRole('button', { name: 'Open settings' }).click();
      const dialog = page.getByRole('dialog', { name: 'Workbench settings' });
      await dialog.getByLabel('Provider').selectOption('ollama');
      const model = dialog.getByLabel('Model', { exact: true });
      await model.fill('fixture-keyboard-model');
      save = await gateIpc(app, 'settings');
      await model.press('Enter');
      await expect.poll(save.calls).toHaveLength(1);
      await save.release(0, 'Fixture keyboard save failure');
      const error = dialog.getByRole('alert');
      await expect(error).toContainText('Fixture keyboard save failure');
      await expect(dialog.getByRole('button', { name: 'Save & connect' })).toBeEnabled();
      await page.screenshot({ path: `test-results/settings-${mode}-keyboard-error.png` });
      await expect
        .poll(
          () =>
            error.evaluate((element) => {
              const box = element.getBoundingClientRect();
              const hit = document.elementFromPoint(box.left + 1, box.top + box.height / 2);
              return (
                box.top >= 0 &&
                box.bottom <= innerHeight &&
                (hit === element || (hit !== null && element.contains(hit)))
              );
            }),
          { message: 'The settings error must be in view after Enter submits the form' },
        )
        .toBe(true);
      await expect(error).toBeFocused();
      expect((await page.evaluate(() => window.interview.snapshot())).settings.provider).toBe(
        'disabled',
      );
      await expect(model).toHaveValue('fixture-keyboard-model');
      await save.restore();
      save = undefined;
      await page.keyboard.press('Tab');
      await expect(dialog.getByRole('button', { name: 'Save & connect' })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(dialog).toHaveCount(0);
      const after = await page.evaluate(() => window.interview.snapshot());
      expect(after.settings.provider).toBe('ollama');
      expect(after.settings.model).toBe('fixture-keyboard-model');
      await expect(page.getByRole('button', { name: 'Open settings' })).toBeFocused();
    } finally {
      await save?.restore().catch(() => {});
      await app.close().catch(() => {});
    }
  });
}
