import { expect, test } from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';
import { pasteAccountDraft } from './account-fixture';

type PickerHost = typeof globalThis & { nativePicker: { calls: number; settled: boolean } };

for (const kind of ['open', 'save'] as const) {
  test(`native ${kind} picker permits app closure without a selection`, async () => {
    const data = await mkdtemp(join(tmpdir(), 'interview-native-picker-close-'));
    const app = await launch(data);
    try {
      const page = await app.firstWindow();
      await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
      await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
      await pasteAccountDraft(page, '# Preserve draft with a real native picker.\n');
      await page.getByRole('button', { name: 'Open settings' }).click();
      const saved = await readFile(join(data, 'workspace.json'), 'utf8');
      await app.evaluate(
        ({ dialog }, { data, kind }) => {
          const state: PickerHost['nativePicker'] = ((globalThis as PickerHost).nativePicker = {
            calls: 0,
            settled: false,
          });
          const method = kind === 'open' ? 'showOpenDialog' : 'showSaveDialog';
          const original = dialog[method].bind(dialog) as (
            window: Electron.BrowserWindow,
            options: Electron.OpenDialogOptions,
          ) => Promise<unknown>;
          // Keep the real OS dialog. Limit its initial folder to this test's files.
          Object.assign(dialog, {
            [method]: async (
              window: Electron.BrowserWindow,
              options: Electron.OpenDialogOptions,
            ) => {
              state.calls++;
              try {
                return await original(window, { ...options, defaultPath: data });
              } finally {
                state.settled = true;
              }
            },
          });
        },
        { data, kind },
      );
      await page
        .getByRole('button', {
          name: kind === 'open' ? 'Browse' : 'Export practice backup',
          exact: true,
        })
        .click();
      await expect
        .poll(() => app.evaluate(() => (globalThis as PickerHost).nativePicker))
        .toEqual({ calls: 1, settled: false });
      let closed = false;
      app.on('close', () => {
        closed = true;
      });
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
      await expect.poll(() => closed, { timeout: 5000 }).toBe(true);
      expect(await readFile(join(data, 'workspace.json'), 'utf8')).toBe(saved);
    } finally {
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await app.close().catch(() => {});
    }
  });
}
