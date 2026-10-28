import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';
import { controlledCoach, openCoach } from './chat-fixture';
import { reviewJSON } from '../grading-fixture';
import { gateIpc } from './ipc-gate';

async function pasteCode(page: Page, text: string) {
  const input = page.getByTestId('code-editor').locator('textarea');
  await input.focus();
  await input.press('ControlOrMeta+a');
  await input.evaluate((element, value) => {
    const data = new DataTransfer();
    data.setData('text/plain', value);
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, text);
}

test('coding AI review captures one draft, preserves new edits and unsent text, and survives restart', async () => {
  const data = await mkdtemp(join(tmpdir(), 'interview-ai-review-code-'));
  const coach = await controlledCoach(false, false);
  let app = await launch(data);
  try {
    let page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'AI review', exact: true })).toBeDisabled();
    const { composer } = await openCoach(page, coach.url);
    await composer.fill('Keep this unsent question.');
    const before = await page.evaluate(() => window.interview.snapshot());
    const original = before.sessions[0]!.code;
    const hash = createHash('sha256').update(original).digest('hex');
    const button = page.getByRole('button', { name: 'AI review', exact: true });
    await button.evaluate((element) => {
      (element as HTMLButtonElement).click();
      (element as HTMLButtonElement).click();
    });
    await expect.poll(() => coach.requests.length).toBe(1);
    expect(coach.requests[0]!.payload.tools).toEqual([]);
    expect(coach.requests[0]!.payload.options).toEqual({ num_predict: 1500, num_ctx: 32768 });
    expect(coach.requests[0]!.payload.format).toMatchObject({ type: 'object' });
    const captured = JSON.parse(coach.requests[0]!.messages.at(-1)!.content);
    expect(captured.code).toBe(original);
    expect(captured.codeSha256).toBe(hash);
    await pasteCode(page, '# New candidate edit during AI review.');
    await expect
      .poll(async () => (await page.evaluate(() => window.interview.snapshot())).sessions[0]!.code)
      .toBe('# New candidate edit during AI review.');
    coach.finish(0, reviewJSON());
    await expect(page.getByRole('heading', { name: 'AI practice review' })).toBeVisible();
    await expect(
      page.getByText(`Attempt: ${before.sessions[0]!.attemptId}. Code SHA-256: ${hash}.`, {
        exact: true,
      }),
    ).toBeVisible();
    await expect(composer).toHaveValue('Keep this unsent question.');
    const after = await page.evaluate(() => window.interview.snapshot());
    expect(after.sessions[0]!.result).toEqual(before.sessions[0]!.result);
    expect(after.sessions[0]!.submitted).toBe(false);
    expect(after.sessions[0]!.hintDepth).toBe(0);
    expect(after.progress).toBe(before.progress);
    expect(coach.requests).toHaveLength(1);
    await page.screenshot({ path: 'test-results/ai-review-coding.png' });
    await app.close();
    app = await launch(data);
    page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('heading', { name: 'AI practice review' })).toBeVisible();
    expect((await page.evaluate(() => window.interview.snapshot())).sessions[0]!.code).toBe(
      '# New candidate edit during AI review.',
    );
  } finally {
    await app.close().catch(() => {});
    await coach.close();
  }
});

test('design AI review pins a checkpoint and keeps later notes separate from the estimate', async () => {
  const coach = await controlledCoach(false, false);
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-ai-review-design-')));
  try {
    const page = await app.firstWindow();
    await openCoach(page, coach.url, 'design');
    await page.getByRole('button', { name: 'notes', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Requirements', exact: true })
      .fill('Captured candidate requirements.');
    await page.getByRole('button', { name: 'AI review', exact: true }).click();
    await expect.poll(() => coach.requests.length).toBe(1);
    const captured = JSON.parse(coach.requests[0]!.messages.at(-1)!.content);
    expect(captured.checkpoint.notes.requirements).toBe('Captured candidate requirements.');
    await page.getByRole('button', { name: 'notes', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Requirements', exact: true })
      .fill('New notes after capture.');
    const activeId = (await page.evaluate(() => window.interview.snapshot()))
      .activeDesignSessionId!;
    await expect
      .poll(
        async () =>
          (await page.evaluate((id) => window.interview.loadDesignDraft(id), activeId)).notes
            .requirements,
      )
      .toBe('New notes after capture.');
    coach.finish(0, reviewJSON('design'));
    await expect(page.getByRole('button', { name: 'AI review', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'coach', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'AI practice review' })).toBeVisible();
    await expect(
      page.getByText(
        `Checkpoint: ${captured.checkpoint.id}. Scene SHA-256: ${captured.checkpoint.scene_digest}.`,
        { exact: true },
      ),
    ).toBeVisible();
    const after = await page.evaluate(() => window.interview.snapshot());
    const session = after.designSessions[0]!;
    expect(session.status).toBe('in_progress');
    expect(session.review).toBeNull();
    expect(session.hintDepth).toBe(0);
    const draft = await page.evaluate((id) => window.interview.loadDesignDraft(id), session.id);
    expect(draft.notes.requirements).toBe('New notes after capture.');
    const history = await page.evaluate(() => window.interview.designCheckpoints());
    expect(history).toHaveLength(1);
    expect(history[0]!.id).toBe(captured.checkpoint.id);
    expect(history[0]!.notes.requirements).toBe('Captured candidate requirements.');
    await page.screenshot({ path: 'test-results/ai-review-design.png' });
  } finally {
    await app.close();
    await coach.close();
  }
});

test('AI review rejects a tool request and invalid JSON, then permits an explicit retry', async () => {
  const coach = await controlledCoach(true, false);
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-ai-review-errors-')));
  try {
    const page = await app.firstWindow();
    await openCoach(page, coach.url);
    const button = page.getByRole('button', { name: 'AI review', exact: true });
    await button.click();
    await expect(
      page.getByText('AI review returned an unexpected tool request.', { exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByRole('dialog', { name: /approval/i })).toHaveCount(0);
    await button.click();
    await expect.poll(() => coach.requests.length).toBe(2);
    coach.finish(1, 'invalid JSON with a solution');
    await expect(
      page
        .getByText(
          'AI review returned invalid scores. The app saved no grade. Try the review again.',
          {
            exact: true,
          },
        )
        .first(),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'AI practice review' })).toHaveCount(0);
    await button.click();
    await expect.poll(() => coach.requests.length).toBe(3);
    coach.finish(2, reviewJSON());
    await expect(page.getByRole('heading', { name: 'AI practice review' })).toHaveCount(1);
    const after = await page.evaluate(() => window.interview.snapshot());
    expect(after.sessions[0]!.submitted).toBe(false);
    expect(after.sessions[0]!.result).toBeNull();
  } finally {
    await app.close();
    await coach.close();
  }
});

test('Stop cancels an AI review and a stale Stop ID cannot cancel the next review', async () => {
  const coach = await controlledCoach(false, false);
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-ai-review-stop-')));
  try {
    const page = await app.firstWindow();
    await openCoach(page, coach.url);
    const button = page.getByRole('button', { name: 'AI review', exact: true });
    await button.click();
    await expect.poll(() => coach.requests.length).toBe(1);
    const previousId = (await page.evaluate(() => window.interview.snapshot())).chatId!;
    await page.getByRole('button', { name: 'Stop coach', exact: true }).click();
    await expect(page.getByText('AI review stopped.', { exact: true })).toBeVisible();
    await expect.poll(() => coach.requests[0]!.closed).toBe(true);
    await button.click();
    await expect.poll(() => coach.requests.length).toBe(2);
    await page.evaluate((id) => window.interview.cancelChat(id), previousId);
    expect((await page.evaluate(() => window.interview.snapshot())).busy).toBe(true);
    coach.finish(1, reviewJSON());
    await expect(page.getByRole('heading', { name: 'AI practice review' })).toHaveCount(1);
    expect(
      (await page.evaluate(() => window.interview.snapshot())).sessions[0]!.chat.filter(
        (item) => item.role === 'assistant',
      ),
    ).toHaveLength(1);
  } finally {
    await app.close();
    await coach.close();
  }
});

test('native window close cancels AI review and retains the draft for restart', async () => {
  const data = await mkdtemp(join(tmpdir(), 'interview-ai-review-close-'));
  const coach = await controlledCoach(false, false);
  let app = await launch(data);
  let close: Awaited<ReturnType<typeof gateIpc>> | undefined;
  try {
    let page = await app.firstWindow();
    await openCoach(page, coach.url);
    await pasteCode(page, '# Saved candidate work before close.');
    await page.getByRole('button', { name: 'AI review', exact: true }).click();
    await expect.poll(() => coach.requests.length).toBe(1);
    close = await gateIpc(app, 'close-ready');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    await expect.poll(() => close!.calls()).toEqual([[true]]);
    await expect.poll(() => coach.requests[0]!.closed).toBe(true);
    expect((await page.evaluate(() => window.interview.snapshot())).busy).toBe(false);
    await close.restore();
    close = undefined;
    await app.close();
    app = await launch(data);
    page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    const after = await page.evaluate(() => window.interview.snapshot());
    expect(after.sessions[0]!.code).toBe('# Saved candidate work before close.');
    expect(after.sessions[0]!.chat.some((item) => item.text === 'AI review stopped.')).toBe(true);
    expect(after.sessions[0]!.chat.some((item) => item.role === 'assistant')).toBe(false);
    expect(after.busy).toBe(false);
  } finally {
    await close?.restore().catch(() => {});
    await app.close().catch(() => {});
    await coach.close();
  }
});

test('an oversized coding review keeps the draft and makes no model request', async () => {
  const coach = await controlledCoach(false, false);
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-ai-review-size-')));
  try {
    const page = await app.firstWindow();
    await openCoach(page, coach.url);
    const code = '# ' + 'x'.repeat(21_000);
    await pasteCode(page, code);
    await page.getByRole('button', { name: 'AI review', exact: true }).click();
    await expect(
      page
        .getByText(
          'AI review accepts at most 20000 evidence bytes. The app did not call the model.',
          { exact: true },
        )
        .first(),
    ).toBeVisible();
    expect(coach.requests).toHaveLength(0);
    const after = await page.evaluate(() => window.interview.snapshot());
    expect(after.sessions[0]!.code).toBe(code);
    expect(after.sessions[0]!.chat.some((item) => item.role === 'assistant')).toBe(false);
    expect(after.busy).toBe(false);
    await expect(page.getByRole('button', { name: 'AI review', exact: true })).toBeEnabled();
  } finally {
    await app.close();
    await coach.close();
  }
});
