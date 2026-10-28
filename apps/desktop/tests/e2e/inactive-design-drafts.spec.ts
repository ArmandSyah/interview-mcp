import { expect, test } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';
import { gateIpc } from './ipc-gate';

for (const retry of ['mode', 'close'] as const) {
  test(`design: a failed save in Coding preserves notes for a ${retry} retry`, async () => {
    const data = await mkdtemp(join(tmpdir(), 'interview-inactive-design-'));
    let app = await launch(data);
    let mode: Awaited<ReturnType<typeof gateIpc>> | undefined;
    let save: Awaited<ReturnType<typeof gateIpc>> | undefined;
    try {
      let page = await app.firstWindow();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
      await page.getByRole('button', { name: 'System design', exact: true }).click();
      await page
        .getByRole('button', { name: /Link Alias Service/ })
        .first()
        .click();
      const notes = page.getByRole('textbox', { name: 'Requirements', exact: true });
      await notes.fill('Previously saved notes');
      await expect(page.getByText(/Saved locally/)).toBeVisible();
      const before = await page.evaluate(() => window.interview.snapshot());
      mode = await gateIpc(app, 'mode');
      await page.getByRole('button', { name: 'Coding', exact: true }).click();
      await expect.poll(mode.calls).toEqual([['coding']]);
      save = await gateIpc(app, 'design-save');
      await page.clock.install();
      await page.clock.pauseAt(new Date());
      await notes.fill('Late notes retained through failed saves');
      await mode.release(0);
      await expect
        .poll(async () => (await page.evaluate(() => window.interview.snapshot())).mode)
        .toBe('coding');
      await page.clock.runFor(1000);
      await page.clock.resume();
      await expect.poll(save.calls).toHaveLength(1);
      expect((await save.calls())[0][0]).toBe(before.activeDesignSessionId);
      expect((await save.calls())[0][1]).toMatchObject({
        notes: { requirements: 'Late notes retained through failed saves' },
      });
      await save.release(0, 'Fixture inactive design save failure');
      await expect(
        page.getByRole('alert').filter({ hasText: 'Fixture inactive design save failure' }),
      ).toBeVisible();
      if (retry === 'mode')
        await page.screenshot({ path: 'test-results/inactive-design-save-failure.png' });
      await expect(page.getByRole('button', { name: 'System design', exact: true })).toBeEnabled();
      expect(
        await page.evaluate(
          (id) => window.interview.loadDesignDraft(id).then((draft) => draft.notes.requirements),
          before.activeDesignSessionId!,
        ),
      ).toBe('Previously saved notes');
      await mode.restore();
      mode = undefined;
      const request = async () => {
        if (retry === 'mode')
          await page.getByRole('button', { name: 'System design', exact: true }).click();
        else await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
      };
      await request();
      await expect.poll(save.calls).toHaveLength(2);
      await save.release(1, 'Fixture design retry failure');
      if (retry === 'mode') {
        await expect(
          page.getByRole('alert').filter({ hasText: 'Fixture design retry failure' }),
        ).toBeVisible();
        expect((await page.evaluate(() => window.interview.snapshot())).mode).toBe('coding');
      } else {
        const dialog = page.getByRole('dialog', { name: 'Cannot close workspace' });
        await expect(dialog.getByRole('alert')).toContainText('Fixture design retry failure');
        await page.screenshot({ path: 'test-results/inactive-design-close-failure.png' });
        await dialog.getByRole('button', { name: 'Continue practice' }).click();
      }
      await request();
      await expect.poll(save.calls).toHaveLength(3);
      expect((await save.calls())[2]).toEqual((await save.calls())[0]);
      await save.restore();
      save = undefined;
      if (retry === 'mode')
        await expect(notes).toHaveValue('Late notes retained through failed saves');
      else await expect.poll(() => page.isClosed()).toBe(true);
      await app.close();
      app = await launch(data);
      page = await app.firstWindow();
      page.on('pageerror', (error) => errors.push(error.message));
      await expect(page.getByText(/MCP connected · 5 (problems|design briefs)/)).toBeVisible({
        timeout: 20_000,
      });
      if (retry === 'close')
        await page.getByRole('button', { name: 'System design', exact: true }).click();
      await expect(page.getByRole('textbox', { name: 'Requirements', exact: true })).toHaveValue(
        'Late notes retained through failed saves',
      );
      expect(errors).toEqual([]);
    } finally {
      await mode?.restore().catch(() => {});
      await save?.restore().catch(() => {});
      await app.close().catch(() => {});
    }
  });
}
