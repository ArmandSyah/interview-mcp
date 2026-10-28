import { expect, test } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';

test('progress controls show empty and populated reports without changing practice', async () => {
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-progress-view-')));
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await page
      .getByRole('button', { name: /Training Mix Segment/ })
      .first()
      .click();
    await expect(page.getByTestId('code-editor')).toBeVisible();
    const before = await page.evaluate(() => window.interview.snapshot());
    expect(before.sessions.length).toBeGreaterThan(0);
    // Supply renderer reports through the same snapshot event used by the backend.
    await app.evaluate(({ BrowserWindow }, snapshot) => {
      BrowserWindow.getAllWindows()[0]!.webContents.send('workbench:event', {
        type: 'snapshot',
        snapshot: { ...snapshot, progress: '' },
      });
    }, before);
    await page.getByRole('button', { name: 'Show progress', exact: true }).click();
    await expect(page.getByText('Your attempts will appear here.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'TEST RESULTS', exact: true }).click();
    await expect(page.getByText('Your attempts will appear here.', { exact: true })).toHaveCount(0);
    await app.evaluate(({ BrowserWindow }, snapshot) => {
      BrowserWindow.getAllWindows()[0]!.webContents.send('workbench:event', {
        type: 'snapshot',
        snapshot: { ...snapshot, progress: '# Practice report\n\nOne saved attempt.' },
      });
    }, before);
    await page.getByRole('button', { name: 'PROGRESS', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Practice report', exact: true })).toBeVisible();
    await expect(page.getByText('One saved attempt.', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.interview.snapshot())).toEqual(before);
  } finally {
    await app.close().catch(() => {});
  }
});
