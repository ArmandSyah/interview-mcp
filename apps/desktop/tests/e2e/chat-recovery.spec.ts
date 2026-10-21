import { expect, test } from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';
import { gateIpc } from './ipc-gate';
import { controlledCoach, openCoach } from './chat-fixture';

for (const mode of ['coding', 'design'] as const) {
  for (const failure of ['provider', 'malformed'] as const) {
    test(`${mode}: a ${failure} stream failure keeps chat evidence and permits another message`, async () => {
      const coach = await controlledCoach();
      const data = await mkdtemp(join(tmpdir(), 'interview-chat-stream-error-'));
      let app = await launch(data);
      try {
        let page = await app.firstWindow();
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        const { composer, send } = await openCoach(page, coach.url, mode);
        await composer.fill('Keep my first question.');
        await send.click();
        await expect(page.getByText('Fixture partial response 1.', { exact: true })).toBeVisible();
        await composer.fill('Keep my newer unsent question.');
        coach.fail(0, failure);
        await expect(page.getByRole('button', { name: 'Stop coach', exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Open settings' })).toBeEnabled();
        const failed = await page.evaluate(() => window.interview.snapshot());
        expect(failed.busy).toBe(false);
        expect(failed.chatId).toBeNull();
        expect(failed.error).toBeTruthy();
        await expect(page.getByRole('alert').filter({ hasText: failed.error! })).toBeVisible();
        await expect(page.getByText('Fixture partial response 1.', { exact: true })).toBeVisible();
        await expect(composer).toHaveValue('Keep my newer unsent question.');
        await expect(send).toBeEnabled();
        await send.click();
        await expect.poll(() => coach.requests).toHaveLength(2);
        coach.finish(1, ' Recovery answer.');
        await expect(page.getByRole('button', { name: 'Stop coach', exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Open settings' })).toBeEnabled();
        const recovered = await page.evaluate(() => window.interview.snapshot());
        expect(recovered.error).toBeNull();
        const history =
          mode === 'coding' ? recovered.sessions[0].chat : recovered.designSessions[0].chat;
        expect(history.filter((item) => item.role === 'user').map((item) => item.text)).toEqual([
          'Keep my first question.',
          'Keep my newer unsent question.',
        ]);
        expect(history.some((item) => item.role === 'system' && item.text === failed.error)).toBe(
          true,
        );
        expect(history.at(-1)?.text).toBe('Fixture partial response 2. Recovery answer.');
        expect(errors).toEqual([]);
        await app.close();
        app = await launch(data);
        page = await app.firstWindow();
        await expect(page.getByText(/MCP connected/)).toBeVisible({ timeout: 20_000 });
        const reopened = await page.evaluate(() => window.interview.snapshot());
        expect(
          mode === 'coding' ? reopened.sessions[0].chat : reopened.designSessions[0].chat,
        ).toEqual(history);
      } finally {
        await app.close().catch(() => {});
        await coach.close();
      }
    });
  }
}

for (const mode of ['welcome', 'coding'] as const) {
  test(`${mode}: a failed history clear preserves messages and a retry clears only that conversation`, async () => {
    const coach = await controlledCoach();
    const data = await mkdtemp(join(tmpdir(), 'interview-chat-clear-'));
    let app = await launch(data);
    let clear: Awaited<ReturnType<typeof gateIpc>> | undefined;
    let fault = false;
    const restore = () =>
      app.evaluate(({ ipcMain }) => {
        const ipc = ipcMain as Electron.IpcMain & {
          clearTestRename?: typeof import('node:fs/promises').rename;
        };
        if (!ipc.clearTestRename) return;
        process.getBuiltinModule('node:fs/promises').rename = ipc.clearTestRename;
        delete ipc.clearTestRename;
      });
    try {
      let page = await app.firstWindow();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const { composer, send } = await openCoach(page, coach.url, 'welcome');
      await composer.fill('Welcome conversation.');
      await send.click();
      await expect.poll(() => coach.requests).toHaveLength(1);
      coach.finish(0, ' Welcome answer.');
      await expect(page.getByRole('button', { name: 'Stop coach', exact: true })).toHaveCount(0);
      if (mode === 'coding') {
        await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
        await composer.fill('Practice conversation.');
        await send.click();
        await expect.poll(() => coach.requests).toHaveLength(2);
        coach.finish(1, ' Practice answer.');
        await expect(page.getByRole('button', { name: 'Stop coach', exact: true })).toHaveCount(0);
      }
      await expect(
        page.getByRole('button', { name: 'Clear conversation', exact: true }),
      ).toBeEnabled();
      const before = await page.evaluate(() => window.interview.snapshot());
      const disk = await readFile(join(data, 'workspace.json'), 'utf8');
      const history = mode === 'coding' ? before.sessions[0].chat : before.welcomeChat;
      await composer.fill('Keep this unsent message after the clear.');
      await app.evaluate(
        ({ ipcMain }, path) => {
          const fs = process.getBuiltinModule(
            'node:fs/promises',
          ) as typeof import('node:fs/promises');
          const ipc = ipcMain as Electron.IpcMain & { clearTestRename?: typeof fs.rename };
          ipc.clearTestRename = fs.rename;
          fs.rename = async (from, to) => {
            if (to === path) throw new Error('Fixture history write failure');
            return ipc.clearTestRename!(from, to);
          };
        },
        join(data, 'workspace.json'),
      );
      fault = true;
      clear = await gateIpc(app, 'clear-chat');
      const button = page.getByRole('button', { name: 'Clear conversation', exact: true });
      await button.evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });
      await expect.poll(() => clear!.calls()).toEqual([[]]);
      await page.evaluate(() => window.interview.snapshot());
      expect(await clear.calls()).toHaveLength(1);
      await expect(button).toBeDisabled();
      await clear.release(0);
      await expect(
        page.getByRole('alert').filter({ hasText: 'Fixture history write failure' }),
      ).toBeVisible();
      const failed = await page.evaluate(() => window.interview.snapshot());
      expect(
        mode === 'coding' ? failed.sessions[0].chat : failed.welcomeChat,
        'A failed clearChat() must retain the previous messages',
      ).toEqual(history);
      await expect(page.getByText(history.at(-1)!.text, { exact: true })).toBeVisible();
      expect(await readFile(join(data, 'workspace.json'), 'utf8')).toBe(disk);
      await expect(composer).toHaveValue('Keep this unsent message after the clear.');
      await restore();
      fault = false;
      await clear.restore();
      clear = undefined;
      await button.click();
      await expect(page.locator('.chat-message')).toHaveCount(0);
      await expect(button).toBeEnabled();
      const after = await page.evaluate(() => window.interview.snapshot());
      expect(mode === 'coding' ? after.sessions[0].chat : after.welcomeChat).toEqual([]);
      if (mode === 'coding') {
        expect(after.welcomeChat).toEqual(before.welcomeChat);
        expect(after.sessions[0].code).toBe(before.sessions[0].code);
      }
      await expect(composer).toHaveValue('Keep this unsent message after the clear.');
      expect(errors).toEqual([]);
      await app.close();
      app = await launch(data);
      page = await app.firstWindow();
      await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
      const reopened = await page.evaluate(() => window.interview.snapshot());
      expect(mode === 'coding' ? reopened.sessions[0].chat : reopened.welcomeChat).toEqual([]);
      if (mode === 'coding') expect(reopened.welcomeChat).toEqual(before.welcomeChat);
    } finally {
      if (fault) await restore().catch(() => {});
      await clear?.restore().catch(() => {});
      await app.close().catch(() => {});
      await coach.close();
    }
  });
}
