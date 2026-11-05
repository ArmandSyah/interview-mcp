import { expect, test } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../../src/main/storage';
import type { ChatItem, Snapshot } from '../../src/shared/types';
import { launch } from './desktop';
import { controlledCoach, openCoach } from './chat-fixture';
import { gateIpc } from './ipc-gate';

function conversation(snapshot: Snapshot, mode: 'coding' | 'design') {
  return mode === 'coding'
    ? snapshot.sessions.find((item) => item.problem.id === snapshot.activeProblemId)!.chat
    : snapshot.designSessions.find((item) => item.id === snapshot.activeDesignSessionId)!.chat;
}

for (const mode of ['coding', 'design'] as const) {
  test(`${mode}: chat retains 200 records across roles and scrolls after a streamed update`, async () => {
    const data = await mkdtemp(join(tmpdir(), 'interview-chat-history-'));
    const coach = await controlledCoach();
    let app = await launch(data);
    try {
      let page = await app.firstWindow();
      await openCoach(page, coach.url, mode);
      const before = await page.evaluate(() => window.interview.snapshot());
      await app.close();
      const store = new LocalStore(data);
      await store.load();
      const workspace = store.workspace(before.workspaceId);
      const roles = ['user', 'assistant', 'tool', 'system'] as const;
      const seeded: ChatItem[] = Array.from({ length: 200 }, (_, index) => ({
        id: randomUUID(),
        role: roles[index % roles.length],
        text: `Saved fixture record ${index}.\n\nEach record belongs to this practice.`,
        timestamp: index + 1,
        ...(roles[index % roles.length] === 'tool'
          ? { tool: mode === 'coding' ? 'get_hint' : 'get_design_hint', status: 'done' as const }
          : {}),
      }));
      // Seed valid saved records. The next append, stream update, trim, and save use the real service.
      const saved =
        mode === 'coding'
          ? workspace.sessions.find((item) => item.problem.id === before.activeProblemId)!
          : workspace.designSessions.find((item) => item.id === before.activeDesignSessionId)!;
      saved.chat = seeded;
      await store.persist();
      app = await launch(data);
      page = await app.firstWindow();
      await expect(
        page.getByText(`MCP connected · 5 ${mode === 'coding' ? 'problems' : 'design briefs'}`),
      ).toBeVisible({ timeout: 20_000 });
      if (mode === 'design') await page.getByRole('button', { name: 'coach', exact: true }).click();
      const history = page.locator('.chat-history');
      const records = history.locator(
        ':scope > .chat-message, :scope > .tool-activity, :scope > .system-message',
      );
      await expect(records).toHaveCount(200);
      expect(conversation(await page.evaluate(() => window.interview.snapshot()), mode)).toEqual(
        seeded,
      );
      const composer = page.getByRole('textbox', {
        name: mode === 'coding' ? 'Message the coach' : 'Message the design coach',
        exact: true,
      });
      const request = 'A new question after the saved record limit.';
      await composer.fill(request);
      await page
        .getByRole('button', {
          name: mode === 'coding' ? 'Send message' : 'Send design message',
          exact: true,
        })
        .click();
      await expect.poll(() => coach.requests.length).toBe(1);
      await expect(history.locator('.chat-message.assistant').last()).toContainText(
        'Fixture partial response 1.',
      );
      const partial = conversation(await page.evaluate(() => window.interview.snapshot()), mode);
      expect(partial).toHaveLength(200);
      expect(partial.slice(0, 198)).toEqual(seeded.slice(2));
      expect(partial.at(-2)).toMatchObject({ role: 'user', text: request });
      expect(partial.at(-1)).toMatchObject({
        role: 'assistant',
        text: 'Fixture partial response 1.',
      });
      await history.evaluate((element) => {
        element.scrollTop = 0;
      });
      const reply =
        '\n\n' +
        'Explain one constraint before you select a component.\n\n'.repeat(40) +
        'End of the streamed reply.';
      coach.finish(0, reply);
      await expect(page.getByRole('button', { name: 'Stop coach', exact: true })).toHaveCount(0);
      await expect
        .poll(() =>
          history.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        )
        .toBeLessThanOrEqual(3);
      expect(await history.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      await expect(history.locator('.chat-message.assistant').last()).toContainText(
        'End of the streamed reply.',
      );
      await expect(records).toHaveCount(200);
      const completed = conversation(await page.evaluate(() => window.interview.snapshot()), mode);
      expect(completed.slice(0, 198)).toEqual(seeded.slice(2));
      expect(completed.at(-1)).toEqual({
        ...partial.at(-1)!,
        text: 'Fixture partial response 1.' + reply,
      });
      expect(completed.at(-2)).toEqual(partial.at(-2));
      await app.close();
      app = await launch(data);
      page = await app.firstWindow();
      await expect(
        page.getByText(`MCP connected · 5 ${mode === 'coding' ? 'problems' : 'design briefs'}`),
      ).toBeVisible({ timeout: 20_000 });
      expect(conversation(await page.evaluate(() => window.interview.snapshot()), mode)).toEqual(
        completed,
      );
      if (mode === 'design') await page.getByRole('button', { name: 'coach', exact: true }).click();
      await expect(
        page
          .locator('.chat-history')
          .locator(':scope > .chat-message, :scope > .tool-activity, :scope > .system-message'),
      ).toHaveCount(200);
    } finally {
      await app.close().catch(() => {});
      await coach.close();
    }
  });
}

test('approval contains keyboard focus, accepts keyboard denial, and restores the prior composer focus', async () => {
  const coach = await controlledCoach(true);
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-approval-keyboard-')));
  let chat: Awaited<ReturnType<typeof gateIpc>> | undefined;
  let approve: Awaited<ReturnType<typeof gateIpc>> | undefined;
  try {
    const page = await app.firstWindow();
    const { composer, send } = await openCoach(page, coach.url);
    chat = await gateIpc(app, 'chat');
    await composer.fill('Ask for a submission decision.');
    await send.click();
    await expect.poll(() => chat!.calls()).toHaveLength(1);
    // The user can focus the composer while a pending request waits for the provider.
    await composer.focus();
    await chat.release(0);
    const dialog = page.getByRole('dialog', { name: 'Approve submission?' });
    await expect(dialog).toBeVisible();
    for (const key of ['Tab', 'Shift+Tab']) {
      for (let index = 0; index < 4; index++) {
        await page.keyboard.press(key);
        expect(
          await dialog.evaluate((element) => element.contains(document.activeElement)),
          `${key} step ${index + 1}: approval focus must stay in the dialog`,
        ).toBe(true);
      }
    }
    approve = await gateIpc(app, 'approve');
    await dialog.getByRole('button', { name: 'Keep practicing', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => approve!.calls()).toHaveLength(1);
    expect((await approve.calls())[0][1]).toBe(false);
    await approve.release(0);
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => coach.requests.length).toBe(2);
    await expect(composer).toBeFocused();
    expect((await page.evaluate(() => window.interview.snapshot())).sessions[0].submitted).toBe(
      false,
    );
    coach.finish(1, ' Continue with this draft.');
    await expect(page.getByRole('button', { name: 'Stop coach', exact: true })).toHaveCount(0);
  } finally {
    await approve?.restore().catch(() => {});
    await chat?.restore().catch(() => {});
    await app.close().catch(() => {});
    await coach.close();
  }
});
