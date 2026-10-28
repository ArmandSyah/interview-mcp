import { expect, test } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';
import { gateIpc } from './ipc-gate';
import { controlledCoach, openCoach } from './chat-fixture';

for (const mode of ['coding', 'design'] as const) {
  for (const failure of [false, true]) {
    test(`${mode}: a delayed Stop ${failure ? 'failure' : 'request'} cannot affect a later chat`, async () => {
      const coach = await controlledCoach();
      const app = await launch(await mkdtemp(join(tmpdir(), 'interview-stop-late-')));
      let cancel: Awaited<ReturnType<typeof gateIpc>> | undefined;
      try {
        const page = await app.firstWindow();
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        const { composer, send } = await openCoach(page, coach.url, mode);
        await composer.fill('First chat.');
        await send.click();
        await expect(page.getByText('Fixture partial response 1.', { exact: true })).toBeVisible();
        cancel = await gateIpc(app, 'cancel');
        await page.getByRole('button', { name: 'Stop coach', exact: true }).click();
        await expect.poll(() => cancel!.calls()).toHaveLength(1);
        coach.finish(0, ' First chat finished before cancellation.');
        await expect(page.getByRole('button', { name: 'Stop coach', exact: true })).toHaveCount(0);
        await composer.fill('Second chat must stay active.');
        await send.click();
        await expect(page.getByText('Fixture partial response 2.', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Stop coach', exact: true })).toBeEnabled();
        await cancel.release(0, failure ? 'Fixture obsolete cancellation failure' : undefined);
        await page.evaluate(() => window.interview.snapshot());
        coach.finish(1, ' Second chat completed.');
        await expect(
          page.getByText('Fixture partial response 2. Second chat completed.', { exact: true }),
        ).toBeVisible();
        await expect(page.getByRole('button', { name: 'Stop coach', exact: true })).toHaveCount(0);
        const snapshot = await page.evaluate(() => window.interview.snapshot());
        const history =
          mode === 'coding' ? snapshot.sessions[0].chat : snapshot.designSessions[0].chat;
        expect(
          history.some((item) => item.text === 'Coach stopped.'),
          'An old Stop request must not stop the next chat',
        ).toBe(false);
        await expect(
          page.getByRole('alert').filter({ hasText: 'Fixture obsolete cancellation failure' }),
        ).toHaveCount(0);
        expect(errors).toEqual([]);
      } finally {
        await cancel?.restore().catch(() => {});
        await app.close();
        await coach.close();
      }
    });
  }

  test(`${mode}: Stop handles a failed cancel request and permits another chat`, async () => {
    const coach = await controlledCoach();
    const app = await launch(await mkdtemp(join(tmpdir(), 'interview-stop-retry-')));
    let cancel: Awaited<ReturnType<typeof gateIpc>> | undefined;
    try {
      const page = await app.firstWindow();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const { composer, send } = await openCoach(page, coach.url, mode);
      await composer.fill('Start the controlled chat.');
      await send.click();
      await expect(page.getByText('Fixture partial response 1.', { exact: true })).toBeVisible();
      await composer.fill('Keep this newer unsent question.');
      cancel = await gateIpc(app, 'cancel');
      const stop = page.getByRole('button', { name: 'Stop coach', exact: true });
      await stop.evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });
      await expect.poll(() => cancel!.calls()).not.toHaveLength(0);
      await page.evaluate(() => window.interview.snapshot());
      expect(
        await cancel.calls(),
        'Repeated Stop clicks must send one pending cancel request',
      ).toHaveLength(1);
      await cancel.release(0, 'Fixture cancellation failure');
      await expect(
        page.getByRole('alert').filter({ hasText: 'Fixture cancellation failure' }),
      ).toBeVisible();
      await expect(stop).toBeEnabled();
      await stop.click();
      await expect.poll(() => cancel!.calls()).toHaveLength(2);
      await cancel.release(1);
      await expect.poll(() => coach.requests[0].closed).toBe(true);
      await expect(stop).toHaveCount(0);
      await expect(composer).toHaveValue('Keep this newer unsent question.');
      await expect(send).toBeEnabled();
      await send.click();
      await expect.poll(() => coach.requests).toHaveLength(2);
      coach.finish(1, ' Recovery response.');
      await expect(
        page.getByText('Fixture partial response 2. Recovery response.', { exact: true }),
      ).toBeVisible();
      await expect(stop).toHaveCount(0);
      expect(errors, 'Cancellation failures must not cause an unhandled rejection').toEqual([]);
    } finally {
      await cancel?.restore().catch(() => {});
      await app.close();
      await coach.close();
    }
  });
}

for (const stage of ['stream', 'approval', 'queued'] as const) {
  test(`window close cancels a ${stage} chat and does not start a later model request`, async () => {
    const coach = await controlledCoach(stage === 'approval');
    const data = await mkdtemp(join(tmpdir(), 'interview-close-chat-'));
    let app = await launch(data);
    let chat: Awaited<ReturnType<typeof gateIpc>> | undefined;
    let close: Awaited<ReturnType<typeof gateIpc>> | undefined;
    try {
      let page = await app.firstWindow();
      const { composer, send } = await openCoach(page, coach.url);
      if (stage === 'queued') chat = await gateIpc(app, 'chat');
      close = await gateIpc(app, 'close-ready');
      await composer.fill('Please discuss this draft.');
      await send.click();
      if (stage === 'queued') await expect.poll(() => chat!.calls()).toHaveLength(1);
      else if (stage === 'approval')
        await expect(page.getByRole('dialog', { name: 'Approve submission?' })).toBeVisible();
      else
        await expect(page.getByText('Fixture partial response 1.', { exact: true })).toBeVisible();
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
      if (chat) await chat.release(0);
      await expect.poll(() => close!.calls()).toEqual([[true]]);
      const snapshot = await page.evaluate(() => window.interview.snapshot());
      expect(snapshot.busy).toBe(false);
      expect(snapshot.sessions[0].submitted).toBe(false);
      expect(coach.requests).toHaveLength(stage === 'queued' ? 0 : 1);
      if (stage !== 'queued')
        expect(snapshot.sessions[0].chat.some((item) => item.text === 'Coach stopped.')).toBe(true);
      if (stage === 'stream') expect(coach.requests[0].closed).toBe(true);
      await expect(page.getByRole('dialog', { name: 'Approve submission?' })).toHaveCount(0);
      await chat?.restore();
      chat = undefined;
      await close.restore();
      close = undefined;
      await app.close();
      app = await launch(data);
      page = await app.firstWindow();
      await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
      const reopened = await page.evaluate(() => window.interview.snapshot());
      expect(reopened.sessions[0].submitted).toBe(false);
      expect(reopened.sessions[0].chat).toEqual(snapshot.sessions[0].chat);
      expect(coach.requests).toHaveLength(stage === 'queued' ? 0 : 1);
    } finally {
      await chat?.restore().catch(() => {});
      await close?.restore().catch(() => {});
      await app.close().catch(() => {});
      await coach.close();
    }
  });
}
