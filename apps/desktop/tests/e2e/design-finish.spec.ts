import { expect, test } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';
import { gateIpc } from './ipc-gate';

test('finish failure permits retry, rejects duplicate clicks, and preserves the completed attempt after restart', async () => {
  const data = await mkdtemp(join(tmpdir(), 'interview-design-finish-'));
  let app = await launch(data);
  try {
    let page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'System design', exact: true }).click();
    await page
      .getByRole('button', { name: /Link Alias Service/ })
      .first()
      .click();
    await expect(page.getByTestId('design-canvas').locator('.excalidraw')).toBeVisible();
    await page
      .getByRole('textbox', { name: 'Requirements', exact: true })
      .fill('Owner access is necessary.');
    await page.getByRole('button', { name: '+ Database', exact: true }).click();
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    const finish = page.getByRole('button', { name: 'Finish practice', exact: true });
    await expect(finish).toBeEnabled();
    const before = await page.evaluate(() => window.interview.snapshot());
    const original = before.designSessions.find(
      (item) => item.id === before.activeDesignSessionId,
    )!;
    const gate = await gateIpc(app, 'design-finish');
    try {
      await finish.evaluate((button) => {
        (button as HTMLButtonElement).click();
        (button as HTMLButtonElement).click();
      });
      await expect.poll(async () => (await gate.calls()).length).toBe(1);
      await expect(finish).toBeDisabled();
      await gate.release(0, 'Fixture finish failure');
      await expect(
        page.getByRole('alert').filter({ hasText: 'Fixture finish failure' }),
      ).toBeVisible();
      await expect(finish).toBeEnabled();
      const failed = await page.evaluate(() => window.interview.snapshot());
      expect(failed.designSessions.find((item) => item.id === original.id)).toEqual(original);
      await finish.click();
      await expect.poll(async () => (await gate.calls()).length).toBe(2);
      await gate.release(1);
      await expect(
        page.getByRole('button', { name: 'Session finished', exact: true }),
      ).toBeDisabled();
    } finally {
      await gate.restore();
    }
    const completed = await page.evaluate(() => window.interview.snapshot());
    const record = completed.designSessions.find((item) => item.id === original.id)!;
    expect(record.status).toBe('completed');
    expect(record.review).toEqual(original.review);
    expect(record.completed_at).toBeTruthy();
    await app.close();
    app = await launch(data);
    page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 design briefs')).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole('button', { name: 'review', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Session finished', exact: true }),
    ).toBeDisabled();
    await page.getByRole('button', { name: 'notes', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Requirements', exact: true })).toHaveValue(
      'Owner access is necessary.',
    );
    await expect(page.getByRole('textbox', { name: 'Requirements', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'New attempt', exact: true }).click();
    await expect
      .poll(
        async () => (await page.evaluate(() => window.interview.snapshot())).activeDesignSessionId,
      )
      .not.toBe(original.id);
    const next = await page.evaluate(() => window.interview.snapshot());
    expect(next.designSessions.find((item) => item.id === original.id)).toEqual(record);
    const fresh = next.designSessions.find((item) => item.id === next.activeDesignSessionId)!;
    expect(fresh.review).toBeFalsy();
    expect(fresh.completed_at).toBeFalsy();
    await page.getByRole('button', { name: 'notes', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Requirements', exact: true })).toBeEnabled();
    await expect(page.getByRole('textbox', { name: 'Requirements', exact: true })).toHaveValue('');
  } finally {
    await app.close().catch(() => {});
  }
});
