import { expect, test, type Page } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';
import { gateIpc } from './ipc-gate';

async function savedDesign(page: Page) {
  await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'System design', exact: true }).click();
  await page
    .getByRole('button', { name: /Link Alias Service/ })
    .first()
    .click();
  await page
    .getByRole('textbox', { name: 'Requirements', exact: true })
    .fill('Previous session notes.');
  await page.getByRole('button', { name: 'Coding', exact: true }).click();
  return page.evaluate(() => window.interview.snapshot());
}

for (const result of ['success', 'failure'] as const) {
  test(`a design load retry ${result} cannot replace a new session`, async () => {
    const app = await launch(await mkdtemp(join(tmpdir(), 'interview-design-retry-race-')));
    let gate: Awaited<ReturnType<typeof gateIpc>> | undefined;
    try {
      const page = await app.firstWindow();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const before = await savedDesign(page);
      gate = await gateIpc(app, 'design-load');
      await page.getByRole('button', { name: 'System design', exact: true }).click();
      await expect.poll(gate.calls).toEqual([[before.activeDesignSessionId]]);
      await gate.release(0, 'Fixture initial canvas read failure');
      await page.getByRole('button', { name: 'Retry canvas load', exact: true }).click();
      await expect.poll(gate.calls).toHaveLength(2);
      await page.getByRole('button', { name: 'New attempt', exact: true }).click();
      await expect.poll(gate.calls).toHaveLength(3);
      const selected = await page.evaluate(() => window.interview.snapshot());
      expect(selected.activeDesignSessionId).not.toBe(before.activeDesignSessionId);
      expect(await gate.calls()).toEqual([
        [before.activeDesignSessionId],
        [before.activeDesignSessionId],
        [selected.activeDesignSessionId],
      ]);
      await gate.release(2);
      const notes = page.getByRole('textbox', { name: 'Requirements', exact: true });
      await expect(notes).toHaveValue('');
      await notes.fill('New session notes.');
      await gate.release(1, result === 'failure' ? 'Fixture old retry failure' : undefined);
      await gate.restore();
      gate = undefined;
      await expect(page.getByText(/Saved locally/)).toBeVisible();
      await expect(notes).toHaveValue('New session notes.');
      await expect(page.getByRole('alert')).toHaveCount(0);
      const records = await page.evaluate(
        async ({ oldId, newId }) => ({
          old: await window.interview.loadDesignDraft(oldId),
          next: await window.interview.loadDesignDraft(newId),
        }),
        { oldId: before.activeDesignSessionId!, newId: selected.activeDesignSessionId! },
      );
      expect(records.old.notes.requirements).toBe('Previous session notes.');
      expect(records.next.notes.requirements).toBe('New session notes.');
      expect(errors).toEqual([]);
    } finally {
      await gate?.restore();
      await app.close().catch(() => {});
    }
  });
}

test('a successful canvas load does not clear an unrelated action error', async () => {
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-design-load-action-error-')));
  let load: Awaited<ReturnType<typeof gateIpc>> | undefined;
  let start: Awaited<ReturnType<typeof gateIpc>> | undefined;
  try {
    const page = await app.firstWindow();
    await savedDesign(page);
    load = await gateIpc(app, 'design-load');
    await page.getByRole('button', { name: 'System design', exact: true }).click();
    await expect.poll(load.calls).toHaveLength(1);
    start = await gateIpc(app, 'design-start');
    await page.getByRole('button', { name: 'New attempt', exact: true }).click();
    await expect.poll(start.calls).toHaveLength(1);
    await start.release(0, 'Fixture new attempt failure');
    const error = page.getByRole('alert').filter({ hasText: 'Fixture new attempt failure' });
    await expect(error).toBeVisible();
    await load.release(0);
    await expect(page.getByRole('textbox', { name: 'Requirements', exact: true })).toHaveValue(
      'Previous session notes.',
    );
    await expect(error).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry canvas load', exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'History', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Design checkpoint history' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('No checkpoints yet.')).toBeVisible();
    await expect(error).toHaveCount(0);
    await page.keyboard.press('Escape');
  } finally {
    await load?.restore();
    await start?.restore();
    await app.close().catch(() => {});
  }
});
