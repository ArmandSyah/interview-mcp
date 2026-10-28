import { expect, test } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';
import { gateIpc } from './ipc-gate';
import { codingReminder, repeatedClick, secondCodingSource } from './practice-queue-fixture';
import { accountServer, connectAccount } from './account-fixture';

test('a queue read error permits close and reopen without a change to the reminder', async () => {
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-queue-read-')));
  let gate: Awaited<ReturnType<typeof gateIpc>> | undefined;
  try {
    const page = await app.firstWindow();
    const { dialog, item } = await codingReminder(page);
    await dialog.getByRole('button', { name: 'Close practice queue', exact: true }).click();
    gate = await gateIpc(app, 'practice-queue');
    const open = page.getByRole('button', { name: 'Practice queue', exact: true });
    await open.click();
    await expect.poll(gate.calls).toEqual([[]]);
    await expect(dialog.getByText('Loading your queue…')).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Close practice queue', exact: true }),
    ).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await gate.release(0, 'Fixture initial queue read error');
    await expect(dialog.getByRole('alert')).toContainText('Fixture initial queue read error');
    await dialog.getByRole('button', { name: 'Close practice queue', exact: true }).click();
    await expect(open).toBeFocused();
    await open.click();
    await expect.poll(gate.calls).toEqual([[], []]);
    await gate.release(1);
    await expect(dialog.locator('.practice-queue-card')).toContainText(item.title);
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await gate.restore();
    gate = undefined;
    expect((await page.evaluate(() => window.interview.practiceQueue())).items).toEqual([item]);
  } finally {
    await gate?.restore();
    await app.close().catch(() => {});
  }
});

test('queue refresh errors keep the selected recall and one retry request', async () => {
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-queue-refresh-')));
  let gate: Awaited<ReturnType<typeof gateIpc>> | undefined;
  try {
    const page = await app.firstWindow();
    const { dialog, item } = await codingReminder(page);
    await dialog.getByRole('button', { name: 'Recall & reflect', exact: true }).click();
    const answer = dialog.getByLabel('Your recall answer');
    await answer.fill('Keep my recall during a queue refresh.');
    gate = await gateIpc(app, 'practice-queue');
    const refresh = dialog.getByRole('button', { name: 'Refresh queue', exact: true });
    await repeatedClick(refresh);
    await expect.poll(gate.calls).toEqual([[]]);
    await expect(answer).toBeDisabled();
    await gate.release(0, 'Fixture queue refresh error');
    await expect(dialog.getByRole('alert')).toContainText('Fixture queue refresh error');
    await expect(answer).toHaveValue('Keep my recall during a queue refresh.');
    await expect(dialog.locator('.practice-queue-card')).toContainText(item.title);
    await repeatedClick(refresh);
    await expect.poll(gate.calls).toEqual([[], []]);
    await gate.release(1);
    await expect(refresh).toBeEnabled();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await expect(answer).toHaveValue('Keep my recall during a queue refresh.');
    const saved = await page.evaluate((id) => window.interview.loadReflectionDraft(id), item.id);
    expect(saved.answer).toBe('Keep my recall during a queue refresh.');
  } finally {
    await gate?.restore();
    await app.close().catch(() => {});
  }
});

for (const failed of ['draft', 'history'] as const) {
  test(`a partial recall read error keeps the previous selection and ignores the old response (${failed})`, async () => {
    const app = await launch(await mkdtemp(join(tmpdir(), 'interview-queue-partial-read-')));
    let draft: Awaited<ReturnType<typeof gateIpc>> | undefined;
    let history: Awaited<ReturnType<typeof gateIpc>> | undefined;
    try {
      const page = await app.firstWindow();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const { dialog, existing, source } = await secondCodingSource(page);
      await dialog.getByLabel('Reminder delay (days)').fill('0');
      await dialog.getByRole('button', { name: 'Add to queue', exact: true }).click();
      await expect(dialog.locator('.practice-queue-card')).toHaveCount(2);
      const first = dialog.locator('.practice-queue-card').filter({ hasText: existing.title });
      const second = dialog
        .locator('.practice-queue-card')
        .filter({ hasText: source.problem.title });
      await first.getByRole('button', { name: 'Recall & reflect', exact: true }).click();
      const answer = dialog.getByLabel('Your recall answer');
      await answer.fill('Recall for the previous item.');
      draft = await gateIpc(app, 'practice-draft-load', 'response');
      history = await gateIpc(app, 'practice-history', 'response');
      await second.getByRole('button', { name: 'Recall & reflect', exact: true }).click();
      await expect.poll(draft.calls).toHaveLength(1);
      await expect.poll(history.calls).toHaveLength(1);
      const failing = failed === 'draft' ? draft : history;
      const pending = failed === 'draft' ? history : draft;
      await failing.release(0, 'Fixture partial recall read error');
      await expect(dialog.getByRole('alert')).toContainText('Fixture partial recall read error');
      await expect(answer).toHaveValue('Recall for the previous item.');
      await expect(dialog.locator('.practice-reflection-form legend')).toHaveText(
        `Recall: ${existing.title}`,
      );
      await second.getByRole('button', { name: 'Recall & reflect', exact: true }).click();
      await expect.poll(draft.calls).toHaveLength(2);
      await expect.poll(history.calls).toHaveLength(2);
      await draft.release(1);
      await history.release(1);
      await expect(dialog.locator('.practice-reflection-form legend')).toHaveText(
        `Recall: ${source.problem.title}`,
      );
      await expect(answer).toHaveValue('');
      await answer.fill('Recall for the new item after retry.');
      await pending.release(0);
      await draft.restore();
      draft = undefined;
      await history.restore();
      history = undefined;
      await expect(answer).toHaveValue('Recall for the new item after retry.');
      await expect(dialog.getByRole('alert')).toHaveCount(0);
      await dialog.getByRole('button', { name: 'Close practice queue', exact: true }).click();
      const saved = await page.evaluate(
        async ({ firstId, sourceId }) => {
          const queue = await window.interview.practiceQueue();
          const second = queue.items.find((item) => item.source_id === sourceId)!;
          return [
            await window.interview.loadReflectionDraft(firstId),
            await window.interview.loadReflectionDraft(second.id),
          ];
        },
        { firstId: existing.id, sourceId: source.attemptId },
      );
      expect(saved.map((value) => value.answer)).toEqual([
        'Recall for the previous item.',
        'Recall for the new item after retry.',
      ]);
      expect(errors).toEqual([]);
    } finally {
      await draft?.restore();
      await history?.restore();
      await app.close().catch(() => {});
    }
  });
}

test('a server without queue support does not expose local recall and local mode restores its draft', async () => {
  const server = await accountServer();
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-queue-unsupported-')));
  try {
    const page = await app.firstWindow();
    const { dialog, item } = await codingReminder(page);
    await dialog.getByRole('button', { name: 'Recall & reflect', exact: true }).click();
    await dialog.getByLabel('Your recall answer').fill('Keep this recall in the local workspace.');
    await dialog.getByRole('button', { name: 'Close practice queue', exact: true }).click();
    await connectAccount(page, server.url, 'fixture-alice');
    await page.getByRole('button', { name: 'Practice queue', exact: true }).click();
    await expect(
      dialog.getByText(/This connected engine does not support the practice queue yet/),
    ).toBeVisible();
    await expect(dialog.locator('.practice-queue-card')).toHaveCount(0);
    await expect(dialog.getByLabel('Your recall answer')).toHaveCount(0);
    await expect(dialog.getByText('Keep this recall in the local workspace.')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Workbench settings' });
    await settings.getByLabel('Connection').selectOption('local');
    await settings.getByRole('button', { name: 'Save & connect', exact: true }).click();
    await expect(settings).toHaveCount(0);
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Practice queue', exact: true }).click();
    await dialog.getByRole('button', { name: 'Recall & reflect', exact: true }).click();
    await expect(dialog.getByLabel('Your recall answer')).toHaveValue(
      'Keep this recall in the local workspace.',
    );
    expect((await page.evaluate(() => window.interview.practiceQueue())).items).toEqual([item]);
  } finally {
    await app.close().catch(() => {});
    await server.close();
  }
});
