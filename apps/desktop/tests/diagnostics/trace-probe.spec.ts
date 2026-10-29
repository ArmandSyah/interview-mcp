import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from '../e2e/desktop';

for (const nativeClose of [false, true]) {
  test(`expected assertion failure retains the Electron settings trace, native close=${nativeClose}`, async () => {
    test.fail();
    process.env.INTERVIEW_TRACE_SENTINEL = 'fixture-value-must-not-enter-launch-options';
    const app = await launch(await mkdtemp(join(tmpdir(), 'interview-trace-probe-')));
    try {
      const page = await app.firstWindow();
      await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
      await page.getByRole('button', { name: 'Open settings' }).click();
      await expect(page.getByRole('dialog', { name: 'Workbench settings' })).toBeVisible();
      await page.screenshot({ path: test.info().outputPath('settings.png') });
      // Screencast frames arrive asynchronously. Do not close the app before one is recorded.
      const raw = (await readdir(test.info().outputDir)).find((name) => name.endsWith('-raw'));
      expect(raw, 'The Electron trace directory must exist').toBeDefined();
      await expect
        .poll(async () => {
          const trace = await readFile(test.info().outputPath(raw!, 'context.trace'), 'utf8');
          return trace.includes('"type":"screencast-frame"');
        })
        .toBe(true);
      if (nativeClose) {
        const closed = app.waitForEvent('close');
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
        await closed;
      }
      expect(false, 'Intentional trace probe after settings opened').toBe(true);
    } finally {
      delete process.env.INTERVIEW_TRACE_SENTINEL;
      await app.close();
    }
  });
}
