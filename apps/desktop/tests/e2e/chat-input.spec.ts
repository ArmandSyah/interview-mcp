import { expect, test, type Page } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';
import { gateIpc } from './ipc-gate';
import { controlledCoach, openCoach } from './chat-fixture';

async function editCode(page: Page, text: string) {
  const editor = page.getByRole('textbox', { name: 'Python solution editor' });
  await editor.focus();
  await page.keyboard.press('ControlOrMeta+a');
  await editor.evaluate((element, text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, text);
}

for (const mode of ['coding', 'design'] as const) {
  test(`${mode}: a chat keeps text entered while its draft save is pending`, async () => {
    const coach = await controlledCoach();
    const app = await launch(await mkdtemp(join(tmpdir(), 'interview-chat-draft-wait-')));
    let save: Awaited<ReturnType<typeof gateIpc>> | undefined;
    try {
      const page = await app.firstWindow();
      const { composer, send } = await openCoach(page, coach.url, mode);
      save = await gateIpc(app, mode === 'coding' ? 'save' : 'design-save');
      if (mode === 'coding') await editCode(page, '# draft before the message\n');
      else {
        await page.getByRole('button', { name: 'notes', exact: true }).click();
        await page
          .getByRole('textbox', { name: 'Requirements', exact: true })
          .fill('Draft before the message.');
        await page.getByRole('button', { name: 'coach', exact: true }).click();
      }
      await expect.poll(() => save!.calls()).toHaveLength(1);
      await composer.fill('Send this first question.');
      await send.click();
      await expect(send).toBeDisabled();
      await composer.fill('Keep this newer unsent question.');
      await save.restore();
      save = undefined;
      await expect.poll(() => coach.requests).toHaveLength(1);
      expect(coach.requests[0].messages.at(-1)?.content).toMatch(/^Send this first question\./);
      await expect(composer, 'A draft-save wait must not discard newer composer text').toHaveValue(
        'Keep this newer unsent question.',
      );
      coach.finish(0, ' First answer.');
      await expect(page.getByRole('button', { name: 'Stop coach', exact: true })).toHaveCount(0);
      await expect(composer).toHaveValue('Keep this newer unsent question.');
      await send.click();
      await expect.poll(() => coach.requests).toHaveLength(2);
      expect(coach.requests[1].messages.at(-1)?.content).toMatch(
        /^Keep this newer unsent question\./,
      );
      coach.finish(1, ' Second answer.');
      await expect(page.getByRole('button', { name: 'Stop coach', exact: true })).toHaveCount(0);
    } finally {
      await save?.restore().catch(() => {});
      await app.close();
      await coach.close();
    }
  });

  test(`${mode}: repeated form submits start one chat and preserve the next message`, async () => {
    const coach = await controlledCoach();
    const app = await launch(await mkdtemp(join(tmpdir(), 'interview-chat-repeat-')));
    let chat: Awaited<ReturnType<typeof gateIpc>> | undefined;
    try {
      const page = await app.firstWindow();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const { composer, send } = await openCoach(page, coach.url, mode);
      chat = await gateIpc(app, 'chat');
      await composer.fill('Only one request.');
      await composer.evaluate((element) => {
        const form = element.closest('form')!;
        form.requestSubmit();
        form.requestSubmit();
        form.querySelector<HTMLButtonElement>('button')!.click();
      });
      await expect.poll(() => chat!.calls()).toHaveLength(1);
      await page.evaluate(() => window.interview.snapshot());
      expect(await chat.calls()).toEqual([['Only one request.']]);
      await expect(send).toBeDisabled();
      await composer.fill('My next question.');
      await chat.release(0);
      await expect.poll(() => coach.requests).toHaveLength(1);
      await composer.evaluate((element) => element.closest('form')!.requestSubmit());
      if (mode === 'coding') await composer.press('Enter');
      await page.evaluate(() => window.interview.snapshot());
      expect(await chat.calls(), 'An active chat must prevent another send').toHaveLength(1);
      await expect(composer).toHaveValue('My next question.');
      coach.finish(0, ' One answer.');
      await expect(page.getByRole('button', { name: 'Stop coach', exact: true })).toHaveCount(0);
      await expect(send).toBeEnabled();
      const snapshot = await page.evaluate(() => window.interview.snapshot());
      const history =
        mode === 'coding' ? snapshot.sessions[0].chat : snapshot.designSessions[0].chat;
      expect(history.filter((item) => item.role === 'user').map((item) => item.text)).toEqual([
        'Only one request.',
      ]);
      expect(errors).toEqual([]);
    } finally {
      await chat?.restore().catch(() => {});
      await app.close();
      await coach.close();
    }
  });

  test(`${mode}: whitespace stays unsent and the composer enforces its character limit`, async () => {
    const coach = await controlledCoach();
    const app = await launch(await mkdtemp(join(tmpdir(), 'interview-chat-length-')));
    let chat: Awaited<ReturnType<typeof gateIpc>> | undefined;
    try {
      const page = await app.firstWindow();
      const { composer, send } = await openCoach(page, coach.url, mode);
      chat = await gateIpc(app, 'chat');
      await composer.fill('  \n  ');
      await expect(send).toBeDisabled();
      await composer.evaluate((element) => element.closest('form')!.requestSubmit());
      await page.evaluate(() => window.interview.snapshot());
      expect(await chat.calls()).toEqual([]);
      await composer.fill('');
      await composer.focus();
      await page.keyboard.insertText('x'.repeat(8001));
      await expect(composer).toHaveValue('x'.repeat(8000));
      await send.click();
      await expect.poll(() => chat!.calls()).toHaveLength(1);
      expect((await chat.calls())[0]).toEqual(['x'.repeat(8000)]);
      await chat.release(0);
      await expect.poll(() => coach.requests).toHaveLength(1);
      coach.finish(0, ' Length accepted.');
      await expect(page.getByRole('button', { name: 'Stop coach', exact: true })).toHaveCount(0);
      await composer.focus();
      await page.keyboard.insertText('🙂'.repeat(4001));
      await expect(composer).toHaveValue('🙂'.repeat(4000));
      await send.click();
      await expect.poll(() => chat!.calls()).toHaveLength(2);
      expect((await chat.calls())[1]).toEqual(['🙂'.repeat(4000)]);
      await chat.release(1);
      await expect.poll(() => coach.requests).toHaveLength(2);
      coach.finish(1, ' Unicode length accepted.');
      await expect(page.getByRole('button', { name: 'Stop coach', exact: true })).toHaveCount(0);
    } finally {
      await chat?.restore().catch(() => {});
      await app.close();
      await coach.close();
    }
  });
}

test('coding: composition Enter does not send, Shift+Enter inserts a line, and Enter sends', async () => {
  const coach = await controlledCoach();
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-chat-composition-')));
  let chat: Awaited<ReturnType<typeof gateIpc>> | undefined;
  try {
    const page = await app.firstWindow();
    const { composer } = await openCoach(page, coach.url);
    chat = await gateIpc(app, 'chat');
    await composer.fill('入力途中');
    const accepted = await composer.evaluate((element) => {
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      const accepted = element.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      element.dispatchEvent(
        new CompositionEvent('compositionend', { bubbles: true, data: '入力完了' }),
      );
      return accepted;
    });
    await page.evaluate(() => window.interview.snapshot());
    expect(await chat.calls(), 'Enter must not send the unfinished composition text').toEqual([]);
    expect(accepted, 'The input method must retain its Enter event').toBe(true);
    await composer.fill('入力完了');
    await composer.press('End');
    await composer.press('Shift+Enter');
    await composer.pressSequentially('Second line.');
    await expect(composer).toHaveValue('入力完了\nSecond line.');
    expect(await chat.calls()).toEqual([]);
    await composer.press('Enter');
    await expect.poll(() => chat!.calls()).toEqual([['入力完了\nSecond line.']]);
    await chat.release(0);
    await expect.poll(() => coach.requests).toHaveLength(1);
    coach.finish(0, ' Complete question received.');
    await expect(page.getByRole('button', { name: 'Stop coach', exact: true })).toHaveCount(0);
  } finally {
    await chat?.restore().catch(() => {});
    await app.close();
    await coach.close();
  }
});

test('design: Enter keeps a multiline question until the user selects Send', async () => {
  const coach = await controlledCoach();
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-design-chat-keyboard-')));
  try {
    const page = await app.firstWindow();
    const { composer, send } = await openCoach(page, coach.url, 'design');
    await composer.fill('First line.');
    await composer.press('End');
    await composer.press('Enter');
    await composer.pressSequentially('Second line.');
    await expect(composer).toHaveValue('First line.\nSecond line.');
    await page.evaluate(() => window.interview.snapshot());
    expect(coach.requests).toEqual([]);
    await send.click();
    await expect.poll(() => coach.requests).toHaveLength(1);
    expect(coach.requests[0].messages.at(-1)?.content).toMatch(/^First line\.\nSecond line\./);
    coach.finish(0, ' Question received.');
    await expect(page.getByRole('button', { name: 'Stop coach', exact: true })).toHaveCount(0);
  } finally {
    await app.close();
    await coach.close();
  }
});
