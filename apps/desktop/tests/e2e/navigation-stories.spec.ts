import { expect, test } from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';

test('problem search includes titles, IDs, tags, and patterns and combines with difficulty', async () => {
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-catalog-ui-')));
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
    await expect(page.getByTestId('code-editor')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open settings' })).toBeEnabled();
    const before = await page.evaluate(() => window.interview.snapshot());
    const search = page.getByRole('textbox', { name: 'Search problems' });
    for (const query of [
      'DELIVERY HOLD',
      '0015-delivery',
      'intervals',
      'interval-merge',
      'GAP-THRESHOLD',
    ]) {
      await search.fill(query);
      await expect(
        page.locator('.problem-card'),
        `Search ${JSON.stringify(query)} must match the delivery problem`,
      ).toHaveCount(1);
      await expect(page.locator('.problem-card')).toContainText('Delivery Hold Clusters');
    }
    await page.getByRole('button', { name: 'hard', exact: true }).click();
    await expect(page.getByRole('button', { name: 'hard', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByText('No matching problems.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'medium', exact: true }).click();
    await expect(page.locator('.problem-card')).toHaveCount(1);
    await search.fill('no-fixture-match');
    await expect(page.locator('.problem-card')).toHaveCount(0);
    await search.fill('');
    await expect(page.locator('.problem-card')).toHaveCount(5);
    await page.getByRole('button', { name: 'easy', exact: true }).click();
    await expect(page.locator('.problem-card')).toHaveCount(0);
    await page.getByRole('button', { name: 'all', exact: true }).click();
    await expect(page.locator('.problem-card')).toHaveCount(5);
    const after = await page.evaluate(() => window.interview.snapshot());
    expect(after.activeProblemId).toBe(before.activeProblemId);
    expect(after.sessions).toEqual(before.sessions);
  } finally {
    await app.close();
  }
});

for (const operation of [
  'file',
  'catalog',
  'coding-mode',
  'design-mode',
  'design-session',
] as const) {
  test(`${operation}: a failed selection write keeps the current workspace and permits retry`, async () => {
    const data = await mkdtemp(join(tmpdir(), 'interview-navigation-write-'));
    let app = await launch(data);
    let fault = false;
    const restore = () =>
      app.evaluate(({ ipcMain }) => {
        const ipc = ipcMain as Electron.IpcMain & {
          navigationRename?: typeof import('node:fs/promises').rename;
        };
        if (!ipc.navigationRename) return;
        process.getBuiltinModule('node:fs/promises').rename = ipc.navigationRename;
        delete ipc.navigationRename;
      });
    try {
      let page = await app.firstWindow();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
      await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
      await page.getByRole('button', { name: /Training Mix Segment/ }).click();
      await expect(page.getByRole('button', { name: 'Open settings' })).toBeEnabled();
      if (operation === 'file') await page.getByRole('button', { name: 'Files explorer' }).click();
      if (operation.startsWith('design')) {
        await page.getByRole('button', { name: 'System design', exact: true }).click();
        await page
          .getByRole('button', { name: /Link Alias Service/ })
          .first()
          .click();
        await page
          .getByRole('textbox', { name: 'Requirements', exact: true })
          .fill('Keep the design notes after a failed mode change.');
        await expect(page.getByText(/Saved locally/)).toBeVisible();
        if (operation === 'design-session') {
          await page.getByRole('button', { name: 'New attempt', exact: true }).click();
          await expect
            .poll(
              async () =>
                (await page.evaluate(() => window.interview.snapshot())).designSessions.length,
            )
            .toBe(2);
          await expect(
            page.getByRole('button', { name: 'New attempt', exact: true }),
          ).toBeEnabled();
          await expect(
            page.getByRole('textbox', { name: 'Requirements', exact: true }),
          ).toHaveValue('');
          await expect(page.getByText(/Saved locally/)).toBeVisible();
          await page.locator('.design-attempts summary').click();
        }
      }
      const before = await page.evaluate(() => window.interview.snapshot());
      const disk = await readFile(join(data, 'workspace.json'), 'utf8');
      await app.evaluate(
        ({ ipcMain }, path) => {
          const fs = process.getBuiltinModule(
            'node:fs/promises',
          ) as typeof import('node:fs/promises');
          const ipc = ipcMain as Electron.IpcMain & { navigationRename?: typeof fs.rename };
          ipc.navigationRename = fs.rename;
          fs.rename = async (from, to) => {
            if (to === path) throw new Error('Fixture navigation write failure');
            return ipc.navigationRename!(from, to);
          };
        },
        join(data, 'workspace.json'),
      );
      fault = true;
      const select = () =>
        operation === 'design-session'
          ? page.locator('.design-attempts button').last().click()
          : page
              .getByRole('button', {
                name:
                  operation === 'coding-mode'
                    ? 'System design'
                    : operation === 'design-mode'
                      ? 'Coding'
                      : /Delivery Hold Clusters/,
                exact: operation.endsWith('mode'),
              })
              .click();
      await select();
      await expect(
        page.getByRole('alert').filter({ hasText: 'Fixture navigation write failure' }),
      ).toBeVisible();
      const failed = await page.evaluate(() => window.interview.snapshot());
      expect(failed.mode, 'A rejected selection must keep the previous mode').toBe(before.mode);
      expect(
        failed.activeProblemId,
        'A rejected selection must keep the previous active problem',
      ).toBe(before.activeProblemId);
      expect(failed.sessions).toEqual(before.sessions);
      expect(failed.designSessions).toEqual(before.designSessions);
      expect(failed.activeDesignSessionId).toBe(before.activeDesignSessionId);
      expect(await readFile(join(data, 'workspace.json'), 'utf8')).toBe(disk);
      await restore();
      fault = false;
      await select();
      await expect(
        page.getByRole('alert').filter({ hasText: 'Fixture navigation write failure' }),
      ).toHaveCount(0);
      await expect
        .poll(async () => {
          const snapshot = await page.evaluate(() => window.interview.snapshot());
          return {
            busy: snapshot.busy,
            mode: snapshot.mode,
            id: snapshot.activeProblemId,
            designId: snapshot.activeDesignSessionId,
          };
        })
        .toEqual({
          busy: false,
          mode: operation === 'coding-mode' || operation === 'design-session' ? 'design' : 'coding',
          id:
            operation.endsWith('mode') || operation === 'design-session'
              ? before.activeProblemId
              : '0015-delivery-hold-clusters',
          designId:
            operation === 'design-session'
              ? before.designSessions[0].id
              : before.activeDesignSessionId,
        });
      const saved = await page.evaluate(() => window.interview.snapshot());
      expect(saved.busy).toBe(false);
      expect(saved.mode).toBe(
        operation === 'coding-mode' || operation === 'design-session' ? 'design' : 'coding',
      );
      expect(saved.activeProblemId).toBe(
        operation.endsWith('mode') || operation === 'design-session'
          ? before.activeProblemId
          : '0015-delivery-hold-clusters',
      );
      if (operation === 'design-session')
        expect(saved.activeDesignSessionId).toBe(before.designSessions[0].id);
      expect(saved.sessions).toEqual(before.sessions);
      expect(errors).toEqual([]);
      await app.close();
      app = await launch(data);
      page = await app.firstWindow();
      await expect
        .poll(async () => (await page.evaluate(() => window.interview.snapshot())).connection, {
          timeout: 20_000,
        })
        .toBe('connected');
      const reopened = await page.evaluate(() => window.interview.snapshot());
      expect(reopened.mode).toBe(saved.mode);
      expect(reopened.activeProblemId).toBe(saved.activeProblemId);
      expect(reopened.sessions).toEqual(saved.sessions);
      expect(reopened.activeDesignSessionId).toBe(saved.activeDesignSessionId);
      if (operation === 'design-session')
        await expect(page.getByRole('textbox', { name: 'Requirements', exact: true })).toHaveValue(
          'Keep the design notes after a failed mode change.',
        );
    } finally {
      if (fault) await restore().catch(() => {});
      await app.close().catch(() => {});
    }
  });
}
