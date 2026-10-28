import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';
import { codingReminder, openPracticeQueue } from './practice-queue-fixture';

test('queue date and practice filters preserve reminders at the exact due time', async () => {
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-queue-filters-')));
  try {
    const page = await app.firstWindow();
    await page.clock.install();
    const { dialog, item } = await codingReminder(page);
    await dialog.getByRole('button', { name: 'Close practice queue', exact: true }).click();
    await page.getByRole('button', { name: 'System design', exact: true }).click();
    await page
      .getByRole('button', { name: /Link Alias Service/ })
      .first()
      .click();
    await expect(page.getByRole('textbox', { name: 'Requirements', exact: true })).toBeVisible();
    const snapshot = await page.evaluate(() => window.interview.snapshot());
    await openPracticeQueue(page);
    await dialog
      .getByLabel('Practice to revisit')
      .selectOption(`design:${snapshot.activeDesignSessionId}`);
    await dialog.getByLabel('Reminder delay (days)').fill('1');
    await dialog.getByRole('button', { name: 'Add to queue', exact: true }).click();
    const cards = dialog.locator('.practice-queue-card');
    await expect(cards).toHaveCount(1);
    await expect(cards).toContainText('Link Alias Service');
    await dialog.getByLabel('Practice type').selectOption('coding');
    await expect(cards).toHaveCount(0);
    await dialog.getByRole('button', { name: /^Due now/ }).click();
    await expect(cards).toHaveCount(1);
    await expect(cards).toContainText('Delivery Hold Clusters');
    await dialog.getByRole('button', { name: 'Pause reminder', exact: true }).click();
    await expect(cards).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Paused', exact: true }).click();
    await expect(cards).toHaveCount(1);
    await dialog.getByLabel('Practice type').selectOption('design');
    await expect(cards).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Upcoming', exact: true }).click();
    await expect(cards).toHaveCount(1);
    const before = await page.evaluate(() => window.interview.practiceQueue());
    const design = before.items.find((value) => value.source_kind === 'design')!;
    expect(before.items.find((value) => value.id === item.id)).toMatchObject({ paused: true });
    await page.clock.setFixedTime(new Date(Date.parse(design.due_at) - 1));
    await page.clock.fastForward(30_000);
    await expect(cards).toHaveCount(1);
    await expect(dialog.getByRole('button', { name: 'Due now (0)', exact: true })).toBeVisible();
    await page.clock.setFixedTime(new Date(design.due_at));
    await page.clock.fastForward(30_000);
    await expect(cards).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Due now (1)', exact: true }).click();
    await expect(cards).toHaveCount(1);
    await expect(cards).toContainText('Link Alias Service');
    await dialog.getByLabel('Practice type').selectOption('all');
    await expect(cards).toHaveCount(1);
    await dialog.getByRole('button', { name: 'Paused', exact: true }).click();
    await expect(cards).toContainText('Delivery Hold Clusters');
    expect(await page.evaluate(() => window.interview.practiceQueue())).toEqual(before);
  } finally {
    await app.close();
  }
});

test('an attempt without a local draft permits recall but cannot open a different practice', async () => {
  const data = await mkdtemp(join(tmpdir(), 'interview-queue-unavailable-'));
  let app = await launch(data);
  try {
    let page = await app.firstWindow();
    const { item, snapshot } = await codingReminder(page);
    await app.close();
    const path = join(data, 'workspace.json');
    const state = JSON.parse(await readFile(path, 'utf8'));
    state.workspaces[snapshot.workspaceId].sessions = [];
    state.workspaces[snapshot.workspaceId].activeProblemId = null;
    await writeFile(path, JSON.stringify(state));
    app = await launch(data);
    page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    const dialog = await openPracticeQueue(page);
    await expect(dialog.locator('.practice-queue-card')).toContainText(item.title);
    await dialog.getByRole('button', { name: 'Recall & reflect', exact: true }).click();
    const open = dialog.getByRole('button', { name: 'Open saved practice', exact: true });
    await expect(open).toBeDisabled();
    await expect(
      dialog.getByText(/The original draft is not saved in this desktop workspace/),
    ).toBeVisible();
    await open.evaluate((button: HTMLButtonElement) => button.click());
    expect((await page.evaluate(() => window.interview.snapshot())).activeProblemId).toBeNull();
    await dialog
      .getByLabel('Your recall answer')
      .fill('Recall remains available without a local draft.');
    await dialog
      .getByRole('button', { name: 'Save reflection & next review', exact: true })
      .click();
    await expect(dialog.getByText(/Reflection saved\. Next reminder:/)).toBeVisible();
    const after = await page.evaluate(() => window.interview.practiceQueue());
    expect(after.items[0]).toMatchObject({
      id: item.id,
      source_id: item.source_id,
      problem_revision: item.problem_revision,
      review_count: 1,
    });
    expect((await page.evaluate(() => window.interview.snapshot())).sessions).toEqual([]);
  } finally {
    await app.close().catch(() => {});
  }
});
