import { expect, test, type Page } from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountServer, connectAccount } from './account-fixture';
import { launch } from './desktop';
import { openPracticeQueue } from './practice-queue-fixture';

async function connect(page: Page, url: string, token: string) {
  await connectAccount(page, url, token, undefined, 20_000);
  await expect
    .poll(async () => {
      const snapshot = await page.evaluate(() => window.interview.snapshot());
      return [snapshot.connection, snapshot.busy];
    })
    .toEqual(['connected', false]);
}

async function readPractice(page: Page, itemId: string) {
  return page.evaluate(async (id) => {
    const snapshot = await window.interview.snapshot();
    return {
      workspaceId: snapshot.workspaceId,
      sessions: snapshot.sessions,
      queue: await window.interview.practiceQueue(),
      draft: await window.interview.loadReflectionDraft(id),
      history: await window.interview.practiceReflections(id),
    };
  }, itemId);
}

async function createPractice(page: Page, owner: 'Alice' | 'Bob') {
  await page
    .getByRole('button', { name: /Account fixture/ })
    .first()
    .click();
  await expect(page.getByTestId('code-editor')).toBeVisible();
  const snapshot = await page.evaluate(() => window.interview.snapshot());
  expect(snapshot.sessions).toHaveLength(1);
  const dialog = await openPracticeQueue(page);
  await dialog
    .getByLabel('Practice to revisit')
    .selectOption(`coding:${snapshot.sessions[0].attemptId}`);
  await dialog.getByLabel('Reminder delay (days)').fill('0');
  await dialog.getByRole('button', { name: 'Add to queue', exact: true }).click();
  await expect(dialog.locator('.practice-queue-card')).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Recall & reflect', exact: true }).click();
  const answer = dialog.getByLabel('Your recall answer');
  await expect(answer).toHaveValue('');
  await expect(dialog.locator('.practice-reflection-history summary')).toHaveText(
    'Recent reflection history (0)',
  );
  await answer.fill(`${owner} recorded recall.`);
  await dialog.getByLabel('What needed help or surprised you?').fill(`${owner} recorded takeaway.`);
  await dialog.getByLabel('Next independent step').fill(`${owner} recorded next step.`);
  await dialog.getByLabel('Your self-rating').selectOption('recalled');
  await dialog.getByRole('button', { name: 'Save reflection & next review', exact: true }).click();
  await expect(dialog.getByText(/Reflection saved\. Next reminder:/)).toBeVisible();
  await expect(dialog.locator('.practice-reflection-history summary')).toHaveText(
    'Recent reflection history (1)',
  );
  await answer.fill(`${owner} draft after the recorded reflection.`);
  await dialog.getByLabel('What needed help or surprised you?').fill(`${owner} draft takeaway.`);
  await dialog.getByLabel('Next independent step').fill(`${owner} draft next step.`);
  await dialog.getByLabel('Your self-rating').selectOption('with_effort');
  // Closing the dialog must flush the draft before the account changes.
  await dialog.getByRole('button', { name: 'Close practice queue', exact: true }).click();
  const queue = await page.evaluate(() => window.interview.practiceQueue());
  expect(queue.items).toHaveLength(1);
  const item = queue.items[0];
  expect(item).toMatchObject({
    source_id: snapshot.sessions[0].attemptId,
    review_count: 1,
    version: 1,
  });
  const result = await readPractice(page, item.id);
  expect(result.history).toHaveLength(1);
  expect(result.history[0]).toMatchObject({
    item_id: item.id,
    answer: `${owner} recorded recall.`,
    takeaway: `${owner} recorded takeaway.`,
    next_action: `${owner} recorded next step.`,
    self_rating: 'recalled',
  });
  expect(result.draft).toMatchObject({
    expected_version: item.version,
    answer: `${owner} draft after the recorded reflection.`,
    takeaway: `${owner} draft takeaway.`,
    next_action: `${owner} draft next step.`,
    self_rating: 'with_effort',
  });
  expect(result.draft.reflection_id).not.toBe(result.history[0].id);
  return result;
}

async function expectPractice(page: Page, saved: Awaited<ReturnType<typeof createPractice>>) {
  const item = saved.queue.items[0];
  expect(await readPractice(page, item.id)).toEqual(saved);
  const dialog = await openPracticeQueue(page);
  await dialog.getByRole('button', { name: 'Upcoming', exact: true }).click();
  await expect(dialog.locator('.practice-queue-card')).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Recall & reflect', exact: true }).click();
  await expect(dialog.getByLabel('Your recall answer')).toHaveValue(saved.draft.answer);
  await expect(dialog.getByLabel('What needed help or surprised you?')).toHaveValue(
    saved.draft.takeaway,
  );
  await expect(dialog.getByLabel('Next independent step')).toHaveValue(saved.draft.next_action);
  await expect(dialog.getByLabel('Your self-rating')).toHaveValue(saved.draft.self_rating);
  await dialog.locator('.practice-reflection-history summary').click();
  await expect(dialog.getByText(saved.history[0].answer, { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close practice queue', exact: true }).click();
  expect(await readPractice(page, item.id)).toEqual(saved);
}

test('a queue-enabled remote account keeps its draft and history across token and account changes', async () => {
  const server = await accountServer(undefined, { queue: true });
  const data = await mkdtemp(join(tmpdir(), 'interview-queue-accounts-'));
  const app = await launch(data);
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await connect(page, server.url, 'fixture-alice-old');
    const alice = await createPractice(page, 'Alice');
    await connect(page, server.url, 'fixture-alice-new');
    await expectPractice(page, alice);

    await connect(page, server.url, 'fixture-bob');
    const bobStart = await page.evaluate(async () => ({
      snapshot: await window.interview.snapshot(),
      queue: await window.interview.practiceQueue(),
    }));
    expect(bobStart.snapshot.workspaceId).not.toBe(alice.workspaceId);
    expect(bobStart.snapshot.sessions).toEqual([]);
    expect(bobStart.queue).toEqual({ supported: true, items: [], sources: [] });
    const dialog = await openPracticeQueue(page);
    await expect(dialog.locator('.practice-queue-card')).toHaveCount(0);
    await expect(dialog.getByLabel('Your recall answer')).toHaveCount(0);
    await expect(dialog.getByText(alice.history[0].answer, { exact: true })).toHaveCount(0);
    await expect(
      page.evaluate((id) => window.interview.loadReflectionDraft(id), alice.queue.items[0].id),
    ).rejects.toThrow('Practice queue item not found.');
    await dialog.getByRole('button', { name: 'Close practice queue', exact: true }).click();
    const bob = await createPractice(page, 'Bob');
    expect(bob.queue.items[0].id).not.toBe(alice.queue.items[0].id);
    expect(bob.queue.items[0].source_id).not.toBe(alice.queue.items[0].source_id);
    expect(bob.history[0].id).not.toBe(alice.history[0].id);
    expect(bob.draft.reflection_id).not.toBe(alice.draft.reflection_id);

    await connect(page, server.url, 'fixture-alice-new');
    await expectPractice(page, alice);
    await connect(page, server.url, 'fixture-bob');
    await expectPractice(page, bob);
    const writes = server.requests.filter(
      (request) => request.name === 'record_practice_reflection',
    );
    expect(writes.map((request) => ({ account: request.account, args: request.args }))).toEqual([
      expect.objectContaining({
        account: 'alice',
        args: expect.objectContaining({
          item_id: alice.queue.items[0].id,
          reflection_id: alice.history[0].id,
          answer: alice.history[0].answer,
        }),
      }),
      expect.objectContaining({
        account: 'bob',
        args: expect.objectContaining({
          item_id: bob.queue.items[0].id,
          reflection_id: bob.history[0].id,
          answer: bob.history[0].answer,
        }),
      }),
    ]);
    const stored = JSON.parse(await readFile(join(data, 'workspace.json'), 'utf8'));
    expect(stored.workspaces[alice.workspaceId].reflectionDrafts).toEqual({
      [alice.queue.items[0].id]: alice.draft,
    });
    expect(stored.workspaces[bob.workspaceId].reflectionDrafts).toEqual({
      [bob.queue.items[0].id]: bob.draft,
    });
    expect(errors).toEqual([]);
  } finally {
    await app.close().catch(() => {});
    await server.close();
  }
});
