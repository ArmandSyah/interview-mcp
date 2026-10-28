import { expect, test } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';
import { gateIpc } from './ipc-gate';
import { codingReminder, openPracticeQueue, repeatedClick } from './practice-queue-fixture';

test('queue schedule conflict preserves recall and a lost save response cannot duplicate its reflection', async () => {
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-queue-conflict-')));
  let gate: Awaited<ReturnType<typeof gateIpc>> | undefined;
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const { dialog, item } = await codingReminder(page);
    await dialog.getByRole('button', { name: 'Recall & reflect', exact: true }).click();
    const answer = dialog.getByLabel('Your recall answer');
    await answer.fill('Keep my answer after a schedule conflict.');
    await dialog.getByLabel('What needed help or surprised you?').fill('Keep my reflection.');
    await dialog.getByLabel('Next independent step').fill('Keep my next step.');
    await dialog.getByLabel('Your self-rating').selectOption('recalled');
    await expect(dialog.getByText('Draft saved locally', { exact: true })).toBeVisible();
    await page.evaluate(
      (item) => window.interview.reschedulePracticeReview(item.id, 2, item.version),
      item,
    );
    const save = dialog.getByRole('button', { name: 'Save reflection & next review', exact: true });
    await save.click();
    await expect(dialog.getByRole('alert')).toContainText(
      'This queue item changed. Refresh before saving your reflection or schedule.',
    );
    await expect(answer).toHaveValue('Keep my answer after a schedule conflict.');
    expect(await page.evaluate((id) => window.interview.practiceReflections(id), item.id)).toEqual(
      [],
    );
    await dialog.getByRole('button', { name: 'Refresh queue', exact: true }).click();
    await expect(
      dialog.getByRole('button', { name: 'Use refreshed schedule', exact: true }),
    ).toBeVisible();
    await expect(save).toBeDisabled();
    await expect(dialog.getByLabel('What needed help or surprised you?')).toHaveValue(
      'Keep my reflection.',
    );
    await expect(dialog.getByLabel('Next independent step')).toHaveValue('Keep my next step.');
    await expect(dialog.getByLabel('Your self-rating')).toHaveValue('recalled');
    await dialog.getByRole('button', { name: 'Use refreshed schedule', exact: true }).click();
    gate = await gateIpc(app, 'practice-reflect', 'response');
    await repeatedClick(save);
    await expect.poll(gate.calls).toHaveLength(1);
    await expect(save).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await gate.release(0, 'Fixture reflection response failure');
    await expect(dialog.getByRole('alert')).toContainText('Fixture reflection response failure');
    await expect(answer).toHaveValue('Keep my answer after a schedule conflict.');
    const committed = await page.evaluate(
      (id) => window.interview.practiceReflections(id),
      item.id,
    );
    expect(committed).toHaveLength(1);
    await repeatedClick(save);
    await expect.poll(gate.calls).toHaveLength(2);
    const calls = await gate.calls();
    expect(calls[1]).toEqual(calls[0]);
    await gate.release(1);
    await expect(dialog.getByText(/Reflection saved\. Next reminder:/)).toBeVisible();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await expect(answer).toHaveValue('');
    await dialog.locator('.practice-reflection-history summary').click();
    await expect(dialog.locator('.practice-reflection-history article')).toHaveCount(1);
    await expect(dialog.locator('.practice-reflection-history')).toContainText(committed[0].answer);
    expect(await page.evaluate((id) => window.interview.practiceReflections(id), item.id)).toEqual(
      committed,
    );
    expect((await page.evaluate(() => window.interview.practiceQueue())).items[0]).toMatchObject({
      version: item.version + 2,
      review_count: 1,
    });
    expect(errors).toEqual([]);
  } finally {
    await gate?.restore();
    await app.close().catch(() => {});
  }
});

for (const recovery of ['unchanged', 'edited', 'restart'] as const) {
  test(`queue refresh after a lost reflection response preserves immutable history (${recovery})`, async () => {
    const edited = recovery !== 'unchanged';
    const data = await mkdtemp(join(tmpdir(), 'interview-queue-lost-response-'));
    let app = await launch(data);
    let gate: Awaited<ReturnType<typeof gateIpc>> | undefined;
    try {
      let page = await app.firstWindow();
      const initial = await codingReminder(page);
      const item = initial.item;
      let dialog = initial.dialog;
      await dialog.getByRole('button', { name: 'Recall & reflect', exact: true }).click();
      let answer = dialog.getByLabel('Your recall answer');
      await answer.fill('The first saved recall answer.');
      gate = await gateIpc(app, 'practice-reflect', 'response');
      let save = dialog.getByRole('button', {
        name: 'Save reflection & next review',
        exact: true,
      });
      await save.click();
      await expect.poll(gate.calls).toHaveLength(1);
      await gate.release(0, 'Fixture lost committed reflection response');
      await expect(dialog.getByRole('alert')).toContainText(
        'Fixture lost committed reflection response',
      );
      await gate.restore();
      gate = undefined;
      const previous = await page.evaluate(
        (id) => window.interview.practiceReflections(id),
        item.id,
      );
      expect(previous).toHaveLength(1);
      if (edited) await answer.fill('My new recall after the first reflection.');
      if (recovery === 'restart') {
        await dialog.getByRole('button', { name: 'Close practice queue', exact: true }).click();
        await app.close();
        app = await launch(data);
        page = await app.firstWindow();
        await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
        dialog = await openPracticeQueue(page);
        await dialog.getByRole('button', { name: 'Upcoming', exact: true }).click();
        await dialog.getByRole('button', { name: 'Recall & reflect', exact: true }).click();
        answer = dialog.getByLabel('Your recall answer');
        await expect(answer).toHaveValue('My new recall after the first reflection.');
        save = dialog.getByRole('button', { name: 'Save reflection & next review', exact: true });
      }
      await dialog.getByRole('button', { name: 'Refresh queue', exact: true }).click();
      await dialog.getByRole('button', { name: 'Use refreshed schedule', exact: true }).click();
      await save.click();
      await expect(dialog.getByText(/Reflection saved\. Next reminder:/)).toBeVisible();
      await expect(dialog.getByRole('alert')).toHaveCount(0);
      const after = await page.evaluate((id) => window.interview.practiceReflections(id), item.id);
      expect(after).toHaveLength(edited ? 2 : 1);
      expect(after.find((value) => value.id === previous[0].id)).toEqual(previous[0]);
      if (edited) {
        expect(after[0].id).not.toBe(previous[0].id);
        expect(after[0].answer).toBe('My new recall after the first reflection.');
        await dialog.locator('.practice-reflection-history summary').click();
        await expect(dialog.locator('.practice-reflection-history article')).toHaveCount(2);
        if (recovery === 'edited') {
          await dialog.locator('.practice-reflection-history').scrollIntoViewIfNeeded();
          await page.screenshot({
            path: 'test-results/queue-reflection-recovery.png',
            fullPage: true,
          });
        }
      }
      await expect(answer).toHaveValue('');
    } finally {
      await gate?.restore();
      await app.close().catch(() => {});
    }
  });
}

for (const operation of ['pause', 'reschedule'] as const) {
  test(`queue ${operation} rejects duplicate clicks and preserves the draft through request failure`, async () => {
    const app = await launch(await mkdtemp(join(tmpdir(), `interview-queue-${operation}-`)));
    let gate: Awaited<ReturnType<typeof gateIpc>> | undefined;
    try {
      const page = await app.firstWindow();
      const { dialog, item } = await codingReminder(page);
      await dialog.getByRole('button', { name: 'Recall & reflect', exact: true }).click();
      const answer = dialog.getByLabel('Your recall answer');
      await answer.fill(`Keep my draft during ${operation}.`);
      await dialog.getByLabel('Reminder delay (days)').fill('3');
      gate = await gateIpc(app, `practice-${operation}`);
      const button = dialog.getByRole('button', {
        name: operation === 'pause' ? 'Pause reminder' : 'Move reminder',
        exact: true,
      });
      await repeatedClick(button);
      await expect
        .poll(gate.calls)
        .toEqual([[item.id, operation === 'pause' ? true : 3, item.version]]);
      await expect(answer).toBeDisabled();
      await expect(
        dialog.getByRole('button', { name: 'Refresh queue', exact: true }),
      ).toBeDisabled();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeVisible();
      await gate.release(0, 'Fixture schedule request failure');
      await expect(dialog.getByRole('alert')).toContainText('Fixture schedule request failure');
      await expect(answer).toHaveValue(`Keep my draft during ${operation}.`);
      const unchanged = await page.evaluate(() => window.interview.practiceQueue());
      expect(unchanged.items[0]).toEqual(item);
      await repeatedClick(button);
      await expect.poll(gate.calls).toHaveLength(2);
      expect((await gate.calls())[1]).toEqual((await gate.calls())[0]);
      await gate.release(1);
      await expect(dialog.getByRole('alert')).toHaveCount(0);
      await expect(
        dialog.getByRole('button', { name: 'Refresh queue', exact: true }),
      ).toBeEnabled();
      await expect(answer).toHaveValue(`Keep my draft during ${operation}.`);
      if (operation === 'pause') await expect(answer).toBeDisabled();
      else await expect(answer).toBeEnabled();
      await expect(
        dialog.getByRole('button', { name: 'Use refreshed schedule', exact: true }),
      ).toHaveCount(0);
      await dialog.getByRole('button', { name: 'Close practice queue', exact: true }).click();
      const draft = await page.evaluate((id) => window.interview.loadReflectionDraft(id), item.id);
      expect(draft).toMatchObject({
        answer: `Keep my draft during ${operation}.`,
        expected_version: item.version + 1,
      });
    } finally {
      await gate?.restore();
      await app.close().catch(() => {});
    }
  });
}
