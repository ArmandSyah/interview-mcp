import { expect, test } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';
import { codingReminder, openPracticeQueue, repeatedClick } from './practice-queue-fixture';
import { pasteAccountDraft } from './account-fixture';
import { gateIpc } from './ipc-gate';

for (const kind of ['coding', 'design'] as const) {
  test(`${kind}: open saved practice preserves recall through an activation error and retry`, async () => {
    const app = await launch(await mkdtemp(join(tmpdir(), 'interview-queue-open-')));
    let gate: Awaited<ReturnType<typeof gateIpc>> | undefined;
    try {
      const page = await app.firstWindow();
      const initial = await codingReminder(page);
      let item = initial.item;
      await initial.dialog.getByRole('button', { name: 'Close practice queue' }).click();
      await pasteAccountDraft(page, '# Saved coding practice from the queue.\n');
      await page.getByRole('button', { name: /Training Mix Segment/ }).click();
      await page.getByRole('button', { name: 'System design', exact: true }).click();
      await page
        .getByRole('button', { name: /Link Alias Service/ })
        .first()
        .click();
      await page
        .getByRole('textbox', { name: 'Requirements', exact: true })
        .fill('Saved design practice from the queue.');
      await expect(page.getByText(/Saved locally/)).toBeVisible();
      if (kind === 'design') {
        const design = await page.evaluate(() => window.interview.snapshot());
        const dialog = await openPracticeQueue(page);
        await dialog
          .getByLabel('Practice to revisit')
          .selectOption(`design:${design.activeDesignSessionId}`);
        await dialog.getByLabel('Reminder delay (days)').fill('0');
        await dialog.getByRole('button', { name: 'Add to queue', exact: true }).click();
        await expect(dialog.getByRole('button', { name: 'Refresh queue' })).toBeEnabled();
        item = (await page.evaluate(() => window.interview.practiceQueue())).items.find(
          (value) => value.source_kind === 'design',
        )!;
        await dialog.getByRole('button', { name: 'Close practice queue' }).click();
        const other = design.designProblems.find((value) => value.id !== item.problem_id)!;
        await page.getByRole('button').filter({ hasText: other.title }).first().click();
        await expect
          .poll(
            async () =>
              (await page.evaluate(() => window.interview.snapshot())).activeDesignSessionId,
          )
          .not.toBe(item.source_id);
        await page.getByRole('button', { name: 'Coding', exact: true }).click();
      }
      await expect(page.getByRole('button', { name: 'Practice queue', exact: true })).toBeEnabled();
      const before = await page.evaluate(() => window.interview.snapshot());
      const queueBefore = await page.evaluate(() => window.interview.practiceQueue());
      const historyBefore = await page.evaluate(
        (id) => window.interview.practiceReflections(id),
        item.id,
      );
      const dialog = await openPracticeQueue(page);
      const card = dialog.locator('.practice-queue-card').filter({ hasText: item.title });
      await card.getByRole('button', { name: 'Recall & reflect', exact: true }).click();
      const recall = `Keep this ${kind} recall through activation and retry.`;
      await dialog.getByLabel('Your recall answer').fill(recall);
      const open = dialog.getByRole('button', { name: 'Open saved practice', exact: true });
      gate = await gateIpc(app, kind === 'coding' ? 'activate' : 'design-activate');
      const args = [kind === 'coding' ? item.problem_id : item.source_id];
      await repeatedClick(open);
      await expect.poll(gate.calls).toEqual([args]);
      await expect(open).toBeDisabled();
      await gate.release(0, 'Fixture saved practice activation error');
      await expect(dialog.getByRole('alert')).toContainText(
        'Fixture saved practice activation error',
      );
      await expect(dialog.getByLabel('Your recall answer')).toHaveValue(recall);
      const failed = await page.evaluate(() => window.interview.snapshot());
      expect([failed.mode, failed.activeProblemId, failed.activeDesignSessionId]).toEqual([
        before.mode,
        before.activeProblemId,
        before.activeDesignSessionId,
      ]);
      const draft = await page.evaluate((id) => window.interview.loadReflectionDraft(id), item.id);
      expect(draft.answer).toBe(recall);
      await repeatedClick(open);
      await expect.poll(gate.calls).toEqual([args, args]);
      await gate.release(1);
      await expect(dialog).toHaveCount(0);
      const after = await page.evaluate(() => window.interview.snapshot());
      expect(after.mode).toBe(kind);
      expect(after.sessions).toEqual(before.sessions);
      expect(after.designSessions).toEqual(before.designSessions);
      if (kind === 'coding') {
        expect(after.activeProblemId).toBe(item.problem_id);
        expect(
          after.sessions.find((value) => value.problem.id === after.activeProblemId)?.attemptId,
        ).toBe(item.source_id);
        await expect(page.locator('.monaco-editor .view-lines')).toContainText(
          'Saved coding practice from the queue.',
        );
      } else {
        expect(after.activeDesignSessionId).toBe(item.source_id);
        await expect(page.getByRole('textbox', { name: 'Requirements', exact: true })).toHaveValue(
          'Saved design practice from the queue.',
        );
      }
      expect(await page.evaluate(() => window.interview.practiceQueue())).toEqual(queueBefore);
      expect(
        await page.evaluate((id) => window.interview.practiceReflections(id), item.id),
      ).toEqual(historyBefore);
      expect(
        await page.evaluate((id) => window.interview.loadReflectionDraft(id), item.id),
      ).toEqual(draft);
      await openPracticeQueue(page);
      await card.getByRole('button', { name: 'Recall & reflect', exact: true }).click();
      await expect(dialog.getByLabel('Your recall answer')).toHaveValue(recall);
    } finally {
      await gate?.restore();
      await app.close().catch(() => {});
    }
  });
}

test('reflection text limits preserve exact drafts and reject extra typed characters', async () => {
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-recall-limits-')));
  try {
    const page = await app.firstWindow();
    const { dialog, item } = await codingReminder(page);
    await dialog.getByRole('button', { name: 'Recall & reflect', exact: true }).click();
    const save = dialog.getByRole('button', { name: 'Save reflection & next review', exact: true });
    await dialog.getByLabel('Your recall answer').fill(' \n\t ');
    await expect(save).toBeDisabled();
    const fields = [
      ['Your recall answer', 'answer', 8000],
      ['What needed help or surprised you?', 'takeaway', 2000],
      ['Next independent step', 'next_action', 2000],
    ] as const;
    for (const [label, key, length] of fields) {
      const field = dialog.getByRole('textbox', { name: label, exact: true });
      const value = key[0].repeat(length);
      await field.fill(value);
      await field.press('ControlOrMeta+End');
      await field.pressSequentially('X');
      await expect(field).toHaveValue(value);
    }
    await expect(save).toBeEnabled();
    await dialog.getByRole('button', { name: 'Close practice queue' }).click();
    const draft = await page.evaluate((id) => window.interview.loadReflectionDraft(id), item.id);
    for (const [, key, length] of fields) expect(draft[key]).toBe(key[0].repeat(length));
    await openPracticeQueue(page);
    await dialog.getByRole('button', { name: 'Recall & reflect', exact: true }).click();
    for (const [label, key, length] of fields)
      await expect(dialog.getByRole('textbox', { name: label, exact: true })).toHaveValue(
        key[0].repeat(length),
      );
    await save.click();
    await expect(dialog.getByText(/Reflection saved\. Next reminder:/)).toBeVisible();
    const history = await page.evaluate((id) => window.interview.practiceReflections(id), item.id);
    expect(history).toHaveLength(1);
    for (const [, key, length] of fields) expect(history[0][key]).toBe(key[0].repeat(length));
    expect(
      (await page.evaluate(() => window.interview.practiceQueue())).items[0].review_count,
    ).toBe(1);
  } finally {
    await app.close().catch(() => {});
  }
});
