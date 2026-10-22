import { expect, test, type Page } from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';
import { gateIpc } from './ipc-gate';

async function openDesign(page: Page) {
  await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'System design', exact: true }).click();
  await page
    .getByRole('button', { name: /Link Alias Service/ })
    .first()
    .click();
  await expect(page.getByRole('textbox', { name: 'Requirements', exact: true })).toBeVisible();
}

test('a failed design draft load preserves the saved file and permits a retry', async () => {
  const data = await mkdtemp(join(tmpdir(), 'interview-design-load-retry-'));
  const app = await launch(data);
  let gate: Awaited<ReturnType<typeof gateIpc>> | undefined;
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openDesign(page);
    await page
      .getByRole('textbox', { name: 'Requirements', exact: true })
      .fill('Keep this saved requirement.');
    await page.getByRole('button', { name: '+ Database', exact: true }).click();
    await page.getByRole('button', { name: 'Coding', exact: true }).click();
    const before = await page.evaluate(() => window.interview.snapshot());
    const draftPath = join(
      data,
      'design',
      before.workspaceId,
      before.activeDesignSessionId!,
      'draft.json',
    );
    const stored = await readFile(draftPath, 'utf8');
    gate = await gateIpc(app, 'design-load');
    await page.getByRole('button', { name: 'System design', exact: true }).click();
    await expect.poll(gate.calls).toEqual([[before.activeDesignSessionId]]);
    await gate.release(0, 'Fixture saved canvas read failure');
    await expect(
      page.getByRole('alert').filter({ hasText: 'Fixture saved canvas read failure' }),
    ).toBeVisible();
    await expect(page.getByTestId('design-canvas').locator('.excalidraw')).toHaveCount(0);
    expect(await readFile(draftPath, 'utf8')).toBe(stored);
    await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toHaveCount(0);
    await page.screenshot({ path: 'test-results/design-load-error.png', fullPage: true });
    const retry = page.getByRole('button', { name: 'Retry canvas load', exact: true });
    await retry.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
      button.click();
    });
    await expect
      .poll(gate.calls, { message: 'Retry must read the same saved design again' })
      .toEqual([[before.activeDesignSessionId], [before.activeDesignSessionId]]);
    await expect(page.getByText('Loading saved canvas…')).toBeVisible();
    await gate.release(1, 'Fixture second canvas read failure');
    await expect(
      page.getByRole('alert').filter({ hasText: 'Fixture second canvas read failure' }),
    ).toBeVisible();
    expect(await readFile(draftPath, 'utf8')).toBe(stored);
    await retry.click();
    await expect
      .poll(gate.calls)
      .toEqual(Array.from({ length: 3 }, () => [before.activeDesignSessionId]));
    await gate.release(2);
    await expect(page.getByRole('textbox', { name: 'Requirements', exact: true })).toHaveValue(
      'Keep this saved requirement.',
    );
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await readFile(draftPath, 'utf8')).toBe(stored);
    expect(errors).toEqual([]);
  } finally {
    await gate?.restore();
    await app.close().catch(() => {});
  }
});

test('a failed history load preserves the draft and retry opens one checkpoint dialog', async () => {
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-design-history-load-')));
  let gate: Awaited<ReturnType<typeof gateIpc>> | undefined;
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openDesign(page);
    const notes = page.getByRole('textbox', { name: 'Requirements', exact: true });
    await notes.fill('Saved checkpoint notes.');
    await page.getByRole('button', { name: 'Checkpoint', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Checkpoint', exact: true })).toBeEnabled();
    await notes.fill('New notes before the history read.');
    gate = await gateIpc(app, 'design-history');
    const history = page.getByRole('button', { name: 'History', exact: true });
    await history.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
      button.click();
    });
    await expect.poll(gate.calls).toHaveLength(1);
    await expect(history).toBeDisabled();
    await gate.release(0, 'Fixture checkpoint list read failure');
    await expect(
      page.getByRole('alert').filter({ hasText: 'Fixture checkpoint list read failure' }),
    ).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Design checkpoint history' })).toHaveCount(0);
    await expect(notes).toHaveValue('New notes before the history read.');
    await history.click();
    await expect.poll(gate.calls).toHaveLength(2);
    await gate.release(1);
    const dialog = page.getByRole('dialog', { name: 'Design checkpoint history' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Restore', exact: true })).toHaveCount(1);
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(history).toBeFocused();
    await expect(notes).toHaveValue('New notes before the history read.');
    const saved = await page.evaluate(async () => {
      const snapshot = await window.interview.snapshot();
      return window.interview.loadDesignDraft(snapshot.activeDesignSessionId!);
    });
    expect(saved.notes.requirements).toBe('New notes before the history read.');
    expect(errors).toEqual([]);
  } finally {
    await gate?.restore();
    await app.close().catch(() => {});
  }
});
