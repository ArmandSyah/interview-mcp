import { expect, test } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';
import { gateIpc } from './ipc-gate';
import {
  codingReminder,
  openPracticeQueue,
  repeatedClick,
  secondCodingSource,
} from './practice-queue-fixture';

for (const outcome of ['request-error', 'response-due', 'response-paused'] as const) {
  test(`queue creation retries preserve existing reminders and show the returned item (${outcome})`, async () => {
    const app = await launch(await mkdtemp(join(tmpdir(), 'interview-queue-create-')));
    let gate: Awaited<ReturnType<typeof gateIpc>> | undefined;
    try {
      const page = await app.firstWindow();
      const { dialog, existing, source } = await secondCodingSource(page);
      const delay = dialog.getByLabel('Reminder delay (days)');
      const add = dialog.getByRole('button', { name: 'Add to queue', exact: true });
      const move = dialog.getByRole('button', { name: 'Move reminder', exact: true });
      for (const invalid of ['-1', '0.5', '366']) {
        await delay.fill(invalid);
        await expect(add).toBeDisabled();
        await expect(move).toBeDisabled();
      }
      for (const valid of ['0', '365']) {
        await delay.fill(valid);
        await expect(add).toBeEnabled();
        await expect(move).toBeEnabled();
      }
      const firstDelay = outcome === 'request-error' ? 365 : 0;
      await delay.fill(String(firstDelay));
      gate = await gateIpc(
        app,
        'practice-add',
        outcome === 'request-error' ? 'request' : 'response',
      );
      await repeatedClick(add);
      await expect.poll(gate.calls).toEqual([['coding', source.attemptId, firstDelay]]);
      await expect(add).toBeDisabled();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeVisible();
      await gate.release(0, 'Fixture reminder creation error');
      await expect(dialog.getByRole('alert')).toContainText('Fixture reminder creation error');
      await expect(dialog.getByLabel('Practice to revisit')).toHaveValue(
        `coding:${source.attemptId}`,
      );
      await expect(delay).toHaveValue(String(firstDelay));
      const afterError = await page.evaluate(() => window.interview.practiceQueue());
      expect(afterError.items).toHaveLength(outcome === 'request-error' ? 1 : 2);
      expect(afterError.items.find((item) => item.id === existing.id)).toEqual(existing);
      const created = afterError.items.find((item) => item.source_id === source.attemptId);
      let expectedCreated = created;
      if (outcome === 'response-paused') {
        expectedCreated = await page.evaluate(
          (item) => window.interview.pausePracticeReview(item.id, true, item.version),
          created!,
        );
      }
      await delay.fill('365');
      await repeatedClick(add);
      await expect.poll(gate.calls).toHaveLength(2);
      expect((await gate.calls())[1]).toEqual(['coding', source.attemptId, 365]);
      await gate.release(1);
      await expect(
        dialog.getByRole('button', { name: 'Refresh queue', exact: true }),
      ).toBeEnabled();
      await expect(dialog.getByRole('alert')).toHaveCount(0);
      const after = await page.evaluate(() => window.interview.practiceQueue());
      expect(after.items).toHaveLength(2);
      expect(after.items.find((item) => item.id === existing.id)).toEqual(existing);
      const result = after.items.find((item) => item.source_id === source.attemptId)!;
      if (expectedCreated) expect(result).toEqual(expectedCreated);
      await expect(
        dialog.locator('.practice-queue-card').filter({ hasText: source.problem.title }),
      ).toBeVisible();
      await expect(dialog.getByLabel('Practice to revisit')).toHaveValue('');
      await expect(dialog.getByLabel('Practice type')).toHaveValue('all');
      await expect(
        dialog
          .getByLabel('Practice to revisit')
          .locator(`option[value="coding:${source.attemptId}"]`),
      ).toHaveJSProperty('disabled', true);
    } finally {
      await gate?.restore();
      await app.close().catch(() => {});
    }
  });
}

test('queue creation shows a new reminder when the previous practice filter excludes its type', async () => {
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-queue-create-kind-')));
  try {
    const page = await app.firstWindow();
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
    await dialog.getByLabel('Practice type').selectOption('coding');
    await dialog
      .getByLabel('Practice to revisit')
      .selectOption(`design:${snapshot.activeDesignSessionId}`);
    await dialog.getByLabel('Reminder delay (days)').fill('0');
    await dialog.getByRole('button', { name: 'Add to queue', exact: true }).click();
    await expect(
      dialog.locator('.practice-queue-card').filter({ hasText: 'Link Alias Service' }),
    ).toBeVisible();
    await expect(dialog.getByLabel('Practice type')).toHaveValue('design');
    await page.screenshot({ path: 'test-results/queue-created-design.png' });
    const queue = await page.evaluate(() => window.interview.practiceQueue());
    expect(queue.items).toHaveLength(2);
    expect(queue.items.find((value) => value.id === item.id)).toEqual(item);
  } finally {
    await app.close();
  }
});

test('queue creation uses the refreshed reminder when its schedule changes before the add response', async () => {
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-queue-create-late-')));
  let gate: Awaited<ReturnType<typeof gateIpc>> | undefined;
  try {
    const page = await app.firstWindow();
    const { dialog, source } = await secondCodingSource(page);
    await dialog.getByLabel('Reminder delay (days)').fill('0');
    gate = await gateIpc(app, 'practice-add', 'response');
    await dialog.getByRole('button', { name: 'Add to queue', exact: true }).click();
    await expect.poll(gate.calls).toHaveLength(1);
    const queue = await page.evaluate(() => window.interview.practiceQueue());
    const item = queue.items.find((value) => value.source_id === source.attemptId)!;
    const paused = await page.evaluate(
      (value) => window.interview.pausePracticeReview(value.id, true, value.version),
      item,
    );
    await gate.release(0);
    await expect(dialog.getByRole('button', { name: 'Refresh queue', exact: true })).toBeEnabled();
    await expect(
      dialog.locator('.practice-queue-card').filter({ hasText: source.problem.title }),
    ).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Resume reminder', exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: 'test-results/queue-created-paused.png' });
    const after = await page.evaluate(() => window.interview.practiceQueue());
    expect(after.items.find((value) => value.id === item.id)).toEqual(paused);
  } finally {
    await gate?.restore();
    await app.close().catch(() => {});
  }
});
