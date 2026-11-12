import { expect, test } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from '../e2e/desktop';
import { openPracticeQueue } from '../e2e/practice-queue-fixture';
import { recordJourney } from './recorder';

test('queue reminders, reflection history, and draft recovery after restart', async () => {
  const data = await mkdtemp(join(tmpdir(), 'interview-visual-queue-'));
  let app = await launch(data);
  const answer = 'I can explain the input contract before I write code.';
  const nextDraft = 'Next time, check the boundary cases without opening my notes.';
  let attemptId = '';
  let itemId = '';
  try {
    let page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    let dialog = page.getByRole('dialog', { name: 'Practice queue', exact: true });
    const cards = dialog.locator('.practice-queue-card');
    await recordJourney(
      page,
      'practice-queue',
      'AI off. Real local reminders and reflections.',
      async (step) => {
        await step(
          'Start a coding practice',
          'The local backend creates one coding attempt.',
          async () => {
            await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
            await expect(page.getByTestId('code-editor')).toBeVisible();
            const state = await page.evaluate(() => window.interview.snapshot());
            expect(state.sessions).toHaveLength(1);
            attemptId = state.sessions[0].attemptId;
          },
        );
        await step('Open the practice queue', 'The new workspace has no reminders.', async () => {
          await openPracticeQueue(page);
          await expect(cards).toHaveCount(0);
          expect((await page.evaluate(() => window.interview.practiceQueue())).items).toEqual([]);
        });
        await step(
          'Check an invalid reminder delay',
          'A negative delay disables Add to queue.',
          async () => {
            await dialog.getByLabel('Practice to revisit').selectOption(`coding:${attemptId}`);
            await dialog.getByLabel('Reminder delay (days)').fill('-1');
            await expect(
              dialog.getByRole('button', { name: 'Add to queue', exact: true }),
            ).toBeDisabled();
          },
        );
        await step('Add a reminder for today', 'One reminder appears in Due now.', async () => {
          await dialog.getByLabel('Reminder delay (days)').fill('0');
          await dialog.getByRole('button', { name: 'Add to queue', exact: true }).click();
          await expect(cards).toHaveCount(1);
          await expect(cards).toContainText('Delivery Hold Clusters');
          const queue = await page.evaluate(() => window.interview.practiceQueue());
          expect(queue.items).toHaveLength(1);
          expect(queue.items[0].source_id).toBe(attemptId);
          itemId = queue.items[0].id;
        });
        await step(
          'Filter for system design',
          'The coding reminder is hidden without being removed.',
          async () => {
            await dialog.getByLabel('Practice type').selectOption('design');
            await expect(cards).toHaveCount(0);
            expect(
              (await page.evaluate(() => window.interview.practiceQueue())).items,
            ).toHaveLength(1);
          },
        );
        await step('Show coding reminders', 'The same coding reminder returns.', async () => {
          await dialog.getByLabel('Practice type').selectOption('coding');
          await expect(cards).toHaveCount(1);
        });
        await step(
          'Pause the reminder',
          'The reminder leaves Due now and has a saved paused state.',
          async () => {
            await dialog.getByRole('button', { name: 'Pause reminder', exact: true }).click();
            await expect(cards).toHaveCount(0);
            expect(
              (await page.evaluate(() => window.interview.practiceQueue())).items[0].paused,
            ).toBe(true);
          },
        );
        await step(
          'Inspect paused reminders',
          'The paused card offers Resume reminder.',
          async () => {
            await dialog.getByRole('button', { name: 'Paused', exact: true }).click();
            await expect(
              dialog.getByRole('button', { name: 'Resume reminder', exact: true }),
            ).toBeVisible();
          },
        );
        await step('Resume the reminder', 'The saved reminder is active again.', async () => {
          await dialog.getByRole('button', { name: 'Resume reminder', exact: true }).click();
          await expect(cards).toHaveCount(0);
          expect(
            (await page.evaluate(() => window.interview.practiceQueue())).items[0].paused,
          ).toBe(false);
          await dialog.getByRole('button', { name: /^Due now/ }).click();
          await expect(cards).toHaveCount(1);
        });
        await step(
          'Move the reminder to tomorrow',
          'The reminder moves from Due now to Upcoming.',
          async () => {
            await dialog.getByLabel('Reminder delay (days)').fill('1');
            await dialog.getByRole('button', { name: 'Move reminder', exact: true }).click();
            await expect(cards).toHaveCount(0);
            await dialog.getByRole('button', { name: 'Upcoming', exact: true }).click();
            await expect(cards).toHaveCount(1);
          },
        );
        await step(
          'Move the reminder back to today',
          'The reminder returns to Due now.',
          async () => {
            await dialog.getByLabel('Reminder delay (days)').fill('0');
            await dialog.getByRole('button', { name: 'Move reminder', exact: true }).click();
            await expect(cards).toHaveCount(0);
            await dialog.getByRole('button', { name: /^Due now/ }).click();
            await expect(cards).toHaveCount(1);
          },
        );
        await step('Refresh the queue', 'Refresh retains the same saved reminder.', async () => {
          await dialog.getByRole('button', { name: 'Refresh queue', exact: true }).click();
          await expect(
            dialog.getByRole('button', { name: 'Refresh queue', exact: true }),
          ).toBeEnabled();
          await expect(cards).toHaveCount(1);
          expect((await page.evaluate(() => window.interview.practiceQueue())).items[0].id).toBe(
            itemId,
          );
        });
        await step(
          'Open recall and reflection',
          'An empty recall answer cannot be submitted.',
          async () => {
            await dialog.getByRole('button', { name: 'Recall & reflect', exact: true }).click();
            await expect(dialog.getByLabel('Your recall answer')).toHaveValue('');
            await expect(
              dialog.getByRole('button', { name: 'Save reflection & next review', exact: true }),
            ).toBeDisabled();
          },
        );
        await step('Write a recall answer', 'The answer is saved as a local draft.', async () => {
          await dialog.getByLabel('Your recall answer').pressSequentially(answer, { delay: 55 });
          await expect(dialog.getByText('Draft saved locally', { exact: true })).toBeVisible();
          await expect
            .poll(() => page.evaluate((id) => window.interview.loadReflectionDraft(id), itemId))
            .toMatchObject({ answer });
        });
        await step(
          'Record what needs practice',
          'The reflection contains a takeaway, next step, and self-rating.',
          async () => {
            await dialog
              .getByLabel('What needed help or surprised you?')
              .pressSequentially('Boundary cases need more practice.', { delay: 50 });
            await dialog
              .getByLabel('Next independent step')
              .pressSequentially('Write a small counterexample first.', { delay: 50 });
            await dialog.getByLabel('Your self-rating').selectOption('with_effort');
            await expect(
              dialog.getByRole('button', { name: 'Save reflection & next review', exact: true }),
            ).toBeEnabled();
          },
        );
        await step(
          'Save the reflection',
          'One reflection is stored and a future review is scheduled.',
          async () => {
            await dialog
              .getByRole('button', { name: 'Save reflection & next review', exact: true })
              .click();
            await expect(dialog.getByText(/Reflection saved\. Next reminder:/)).toBeVisible();
            const reflections = await page.evaluate(
              (id) => window.interview.practiceReflections(id),
              itemId,
            );
            expect(reflections).toHaveLength(1);
            expect(reflections[0]).toMatchObject({
              answer,
              self_rating: 'with_effort',
              takeaway: 'Boundary cases need more practice.',
              next_action: 'Write a small counterexample first.',
            });
            const queue = await page.evaluate(() => window.interview.practiceQueue());
            expect(queue.items[0].review_count).toBe(1);
            expect(Date.parse(queue.items[0].due_at)).toBeGreaterThan(Date.now());
            await expect(dialog.getByLabel('Your recall answer')).toHaveValue('');
          },
        );
        await step(
          'Read reflection history',
          'History shows the submitted answer exactly once.',
          async () => {
            await dialog.locator('.practice-reflection-history summary').click();
            await expect(dialog.locator('.practice-reflection-history article')).toHaveCount(1);
            await expect(dialog.locator('.practice-reflection-history article')).toContainText(
              answer,
            );
            await dialog
              .locator('.practice-reflection-history article p')
              .last()
              .scrollIntoViewIfNeeded();
          },
        );
        await step(
          'Start the next recall draft',
          'A new draft is saved without adding another reflection.',
          async () => {
            await dialog
              .getByLabel('Your recall answer')
              .pressSequentially(nextDraft, { delay: 45 });
            await expect
              .poll(() => page.evaluate((id) => window.interview.loadReflectionDraft(id), itemId))
              .toMatchObject({ answer: nextDraft });
            expect(
              await page.evaluate((id) => window.interview.practiceReflections(id), itemId),
            ).toHaveLength(1);
          },
        );
        await step(
          'Open the saved practice',
          'The original coding attempt opens without creating another attempt.',
          async () => {
            await dialog.getByRole('button', { name: 'Open saved practice', exact: true }).click();
            await expect(dialog).toBeHidden();
            await expect(page.getByTestId('code-editor')).toBeVisible();
            const state = await page.evaluate(() => window.interview.snapshot());
            expect(state.sessions).toHaveLength(1);
            expect(state.sessions[0].attemptId).toBe(attemptId);
          },
        );
      },
    );
    await app.close();
    app = await launch(data);
    page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    dialog = page.getByRole('dialog', { name: 'Practice queue', exact: true });
    await recordJourney(
      page,
      'queue-restart',
      'Real app restart. Same local workspace and saved data.',
      async (step) => {
        await step(
          'Inspect reminders after restart',
          'The scheduled coding reminder remains in Upcoming.',
          async () => {
            await openPracticeQueue(page);
            await dialog.getByRole('button', { name: 'Upcoming', exact: true }).click();
            await expect(dialog.locator('.practice-queue-card')).toHaveCount(1);
            await expect(dialog.locator('.practice-queue-card')).toContainText(
              'Delivery Hold Clusters',
            );
          },
        );
        await step(
          'Recover the unfinished recall draft',
          'The exact unsent text survives the restart.',
          async () => {
            await dialog.getByRole('button', { name: 'Recall & reflect', exact: true }).click();
            await expect(dialog.getByLabel('Your recall answer')).toHaveValue(nextDraft);
            await dialog.getByLabel('Your recall answer').scrollIntoViewIfNeeded();
          },
        );
        await step(
          'Verify saved history after restart',
          'The saved reflection remains separate from the unfinished draft.',
          async () => {
            await dialog.locator('.practice-reflection-history summary').click();
            await expect(dialog.locator('.practice-reflection-history article')).toHaveCount(1);
            await expect(dialog.locator('.practice-reflection-history article')).toContainText(
              answer,
            );
            await dialog
              .locator('.practice-reflection-history article p')
              .last()
              .scrollIntoViewIfNeeded();
            expect(
              await page.evaluate((id) => window.interview.practiceReflections(id), itemId),
            ).toHaveLength(1);
          },
        );
      },
    );
  } finally {
    await app.close().catch(() => {});
  }
});
