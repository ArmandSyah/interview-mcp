import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';
import { signedUpdateFixture, type UpdateFixture } from './signed-update-fixture';

for (const stage of ['metadata', 'download', 'consent', 'hash'] as const) {
  test(`native close cancels update ${stage} and cannot open an installer`, async () => {
    test.skip(
      Boolean(process.env.INTERVIEW_DESKTOP_EXECUTABLE),
      'This fixture uses the source bundle.',
    );
    const data = await mkdtemp(join(tmpdir(), 'interview-update-close-'));
    const fixture = await signedUpdateFixture(data);
    const app = await launch(data, '', fixture.entry);
    try {
      const page = await app.firstWindow();
      await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
      await app.evaluate(() => {
        const state = (globalThis as typeof globalThis & { updateFixture: UpdateFixture })
          .updateFixture;
        state.badSignature = false;
        state.badDownload = false;
      });
      await page.getByRole('button', { name: 'Open settings' }).click();
      const dialog = page.getByRole('dialog', { name: 'Workbench settings' });
      const check = dialog.getByRole('button', { name: 'Check for signed updates', exact: true });
      const download = dialog.getByRole('button', {
        name: 'Download verified installer',
        exact: true,
      });
      if (stage !== 'metadata') await check.click();
      if (stage === 'consent' || stage === 'hash') await download.click();
      await app.evaluate((_electron, stage) => {
        (globalThis as typeof globalThis & { updateFixture: UpdateFixture }).updateFixture.hold =
          stage;
      }, stage);
      if (stage === 'metadata') await check.click();
      else if (stage === 'download') await download.click();
      else
        await dialog.getByRole('button', { name: 'Back up & open installer', exact: true }).click();
      await expect
        .poll(() =>
          app.evaluate(
            () =>
              (globalThis as typeof globalThis & { updateFixture: UpdateFixture }).updateFixture
                .held,
          ),
        )
        .toBe(true);
      if (stage === 'download')
        await expect
          .poll(() => readdir(join(data, 'updates', '99.0.0')).catch(() => []))
          .toHaveLength(1);
      let closed = false;
      app.on('close', () => {
        closed = true;
      });
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
      if (stage === 'consent')
        await app.evaluate(() =>
          (
            globalThis as typeof globalThis & { updateFixture: UpdateFixture }
          ).updateFixture.releaseHeld?.(),
        );
      await expect.poll(() => closed, { timeout: 5000 }).toBe(true);
      await expect(readFile(join(data, 'installer-opened'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      if (stage === 'download') expect(await readdir(join(data, 'updates', '99.0.0'))).toEqual([]);
    } finally {
      await app
        .evaluate(() =>
          (
            globalThis as typeof globalThis & { updateFixture: UpdateFixture }
          ).updateFixture.releaseHeld?.(),
        )
        .catch(() => {});
      await app.close().catch(() => {});
    }
  });
}
