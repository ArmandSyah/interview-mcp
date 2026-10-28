import { expect, test, type Page } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { Snapshot } from '../../src/shared/types';
import { launch } from './desktop';

async function pasteCode(page: Page, text: string): Promise<void> {
  const editor = page.locator('.monaco-editor textarea');
  await editor.focus();
  await page.keyboard.press('Control+a');
  // Exercise the editor's paste handler without overwriting the user's OS clipboard.
  // insertText simulates typing, which applies Python auto-indent to every newline.
  await editor.evaluate((element, contents) => {
    const data = new DataTransfer();
    data.setData('text/plain', contents);
    element.dispatchEvent(
      new ClipboardEvent('paste', {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, text);
}
test('real desktop: browse, edit, hints, save/reopen, and a model-to-MCP tool loop', async () => {
  const data = await mkdtemp(join(tmpdir(), 'interview-desktop-e2e-'));
  let app = await launch(data);
  let server: Server | undefined;
  try {
    let page = await app.firstWindow();
    const consoleErrors: string[] = [];
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('heading', { name: /Your next interview/ })).toBeVisible();
    expect(
      await page.evaluate(() => ({
        require: typeof (window as unknown as { require?: unknown }).require,
        process: typeof (window as unknown as { process?: unknown }).process,
      })),
    ).toEqual({ require: 'undefined', process: 'undefined' });
    await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
    await expect(page.getByTestId('code-editor')).toBeVisible();
    await page.getByRole('button', { name: 'problem.md', exact: true }).click();
    await expect(page.getByRole('heading', { name: /Delivery Hold Clusters/ })).toBeVisible();
    await page.getByRole('button', { name: 'solution.py', exact: true }).click();
    const editor = page.locator('.monaco-editor textarea');
    const draft =
      '# saved interview draft\ndef merge_delivery_holds(holds, grace_days):\n    pass\n';
    await pasteCode(page, draft);
    await expect
      .poll(async () => (await page.evaluate(() => window.interview.snapshot())).sessions[0]?.code)
      .toBe(draft);
    await page.getByRole('button', { name: 'Hint', exact: true }).click();
    await expect
      .poll(
        async () => (await page.evaluate(() => window.interview.snapshot())).sessions[0]?.hintDepth,
      )
      .toBe(1);
    await expect(page.locator('.chat-message.assistant')).toHaveCount(1);
    await page.screenshot({ path: 'test-results/workbench-practice.png', fullPage: true });

    let requestCount = 0;
    server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      expect(
        payload.tools.some(
          (tool: { function: { name: string } }) => tool.function.name === 'get_hint',
        ),
      ).toBe(true);
      response.setHeader('Content-Type', 'application/x-ndjson');
      if (++requestCount === 1) {
        expect(JSON.stringify(payload.messages)).toContain('# saved interview draft');
        response.end(
          JSON.stringify({
            message: {
              content: '',
              tool_calls: [
                {
                  function: {
                    name: 'get_hint',
                    arguments: {
                      attempt_id: 'forged',
                      current_code: 'model replacement code',
                      depth: 2,
                    },
                  },
                },
              ],
            },
            done: true,
          }) + '\n',
        );
      } else {
        expect(payload.messages.some((message: { role: string }) => message.role === 'tool')).toBe(
          true,
        );
        response.end(
          JSON.stringify({
            message: { content: 'What invariant must remain true as you scan the holds?' },
            done: true,
          }) + '\n',
        );
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test model address');
    await page.getByRole('button', { name: 'Open settings' }).click();
    await page.getByLabel('Provider').selectOption('ollama');
    await page.getByLabel('Ollama URL').fill(`http://127.0.0.1:${address.port}`);
    await page.getByRole('button', { name: 'Save & connect' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page
      .getByRole('textbox', { name: 'Message the coach' })
      .fill('Give me the next small hint');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(
      page.getByText('What invariant must remain true as you scan the holds?'),
    ).toBeVisible();
    await expect.poll(() => requestCount).toBe(2);
    const state = await page.evaluate(() => window.interview.snapshot());
    expect(state.sessions[0].hintDepth).toBe(2);
    expect(state.sessions[0].code).toContain('# saved interview draft');
    expect(state.sessions[0].code).not.toContain('model replacement code');
    expect(
      state.sessions[0].chat.some((item) => item.tool === 'get_hint' && item.status === 'done'),
    ).toBe(true);
    await page.screenshot({ path: 'test-results/workbench-coach.png', fullPage: true });
    expect(consoleErrors).toEqual([]);

    // Close immediately after an edit; the main process must request a final flush.
    await editor.focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('# immediate close saved\n');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await app.close();
    app = await launch(data);
    page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    const restored = await page.evaluate(() => window.interview.snapshot());
    expect(restored.activeProblemId).toBe('0015-delivery-hold-clusters');
    expect(restored.sessions[0].code).toContain('# immediate close saved');
    expect(restored.sessions[0].chat.some((item) => item.text.includes('What invariant'))).toBe(
      true,
    );
  } finally {
    await app.close();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }
});

test('offline design canvas: components, notes, immutable reviews, history and final-close save', async () => {
  const data = await mkdtemp(join(tmpdir(), 'interview-design-e2e-'));
  let app = await launch(data);
  try {
    let page = await app.firstWindow();
    const errors: string[] = [];
    const external: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (/^https?:/.test(request.url())) external.push(request.url());
    });
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'System design', exact: true }).click();
    await expect(page.getByText('MCP connected · 5 design briefs')).toBeVisible();
    await page
      .getByRole('button', { name: /Link Alias Service/ })
      .first()
      .click();
    await expect(page.getByTestId('design-canvas').locator('.excalidraw')).toBeVisible();
    await page.getByRole('button', { name: '+ Client', exact: true }).click();
    await page.getByRole('button', { name: '+ Service', exact: true }).click();
    await page.getByRole('button', { name: '+ Database', exact: true }).click();
    const requirement =
      'Candidate-owned requirement: aliases must be isolated by owner, and disabling an alias has an explicit visibility guarantee.';
    await page.getByRole('textbox', { name: 'Requirements', exact: true }).fill(requirement);
    await page
      .getByRole('textbox', { name: 'Decisions & tradeoffs', exact: true })
      .fill(
        'I will compare a simple initial deployment against the observed traffic before adding more components.',
      );
    await expect
      .poll(async () => {
        const state = await page.evaluate(() => window.interview.snapshot());
        if (!state.activeDesignSessionId) return 0;
        return (
          await page.evaluate(
            (id) => window.interview.loadDesignDraft(id),
            state.activeDesignSessionId,
          )
        ).scene.elements.filter((element) => !element.isDeleted).length;
      })
      .toBe(6);
    await page.getByRole('button', { name: 'Checkpoint', exact: true }).click();
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Discussion coverage', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('A reflection checklist, not a correctness score or hiring grade.'),
    ).toBeVisible();
    const state = await page.evaluate(() => window.interview.snapshot());
    expect(state.settings.provider).toBe('disabled');
    const reviewed = state.designSessions[0].review!;
    expect(reviewed.items[0].status).toBe('discussed');
    await expect(page.getByRole('button', { name: 'Finish practice', exact: true })).toBeEnabled();
    // Non-evidence changes must not make an immutable review stale.
    await page.getByLabel('Practice mode').selectOption('mock');
    await expect(page.getByRole('button', { name: 'Finish practice', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Start timer', exact: true }).click();
    await expect
      .poll(async () => {
        const snapshot = await page.evaluate(() => window.interview.snapshot());
        const draft = await page.evaluate(
          (id) => window.interview.loadDesignDraft(id),
          snapshot.activeDesignSessionId!,
        );
        return draft.elapsedSeconds;
      })
      .toBeGreaterThanOrEqual(2);
    await expect(page.getByText('Older checkpoint—review again after your edits.')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Finish practice', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Pause timer', exact: true }).click();
    await page.getByLabel('Practice mode').selectOption('guided');
    await page.getByRole('button', { name: 'notes', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Requirements', exact: true })
      .fill(requirement + ' A newer edit.');
    await page.getByRole('button', { name: 'review', exact: true }).click();
    await expect(page.getByText('Older checkpoint—review again after your edits.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Finish practice', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Design checkpoint history' })).toBeVisible();
    await page
      .locator('.design-history-item')
      .filter({ hasText: 'Review' })
      .getByRole('button', { name: 'Restore' })
      .click();
    await page.getByRole('button', { name: 'notes', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Requirements', exact: true })).toHaveValue(
      requirement,
    );
    await page.getByRole('button', { name: 'One curated hint', exact: true }).click();
    await expect(page.locator('.chat-message.assistant')).toHaveCount(1);
    await page.screenshot({ path: 'test-results/workbench-design.png', fullPage: true });
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
    // Close before the debounce runs. Parent and canvas must share one flush barrier.
    await page.getByRole('button', { name: 'notes', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Failure modes', exact: true })
      .fill('Immediate-close evidence: partial failures must have observable, bounded recovery.');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await app.close();
    app = await launch(data);
    page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 design briefs')).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole('textbox', { name: 'Failure modes', exact: true })).toHaveValue(
      /Immediate-close evidence/,
    );
    const restored = await page.evaluate(async () => {
      const state = await window.interview.snapshot();
      return window.interview.loadDesignDraft(state.activeDesignSessionId!);
    });
    expect(restored.scene.elements.filter((element) => !element.isDeleted)).toHaveLength(6);
  } finally {
    await app.close();
  }
});

test('practice queue: coding/design recall, final-close draft save, self-rating, history and editable reminders', async () => {
  const data = await mkdtemp(join(tmpdir(), 'interview-practice-queue-ui-'));
  let app = await launch(data);
  try {
    let page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
    await expect(page.getByTestId('code-editor')).toBeVisible();
    await expect
      .poll(async () => (await page.evaluate(() => window.interview.snapshot())).sessions.length)
      .toBe(1);
    const initial = await page.evaluate(() => window.interview.snapshot());
    await page.getByRole('button', { name: 'Practice queue', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Practice queue', exact: true });
    await dialog
      .getByLabel('Practice to revisit')
      .selectOption(`coding:${initial.sessions[0].attemptId}`);
    await dialog.getByLabel('Reminder delay (days)').fill('0');
    await dialog.getByRole('button', { name: 'Add to queue', exact: true }).click();
    await expect(dialog.locator('.practice-queue-card')).toHaveCount(1);
    await dialog.getByRole('button', { name: 'Recall & reflect', exact: true }).click();
    await expect(dialog.getByLabel('Your recall answer')).toBeVisible();
    const answer =
      'Immediate-close recall: I can explain my contract, invariant, and one boundary case in plain English.';
    await dialog.getByLabel('Your recall answer').fill(answer);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await app.close();
    app = await launch(data);
    page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Practice queue', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Practice queue', exact: true });
    await dialog.getByRole('button', { name: 'Recall & reflect', exact: true }).click();
    await expect(dialog.getByLabel('Your recall answer')).toHaveValue(answer);
    await dialog.getByLabel('Your self-rating').selectOption('recalled');
    await dialog
      .getByLabel('What needed help or surprised you?')
      .fill('Separating the contract from my implementation took one hint.');
    await dialog.getByLabel('Next independent step').fill('State the invariant before coding.');
    await dialog
      .getByRole('button', { name: 'Save reflection & next review', exact: true })
      .click();
    await expect(dialog.getByText(/Reflection saved\. Next reminder:/)).toBeVisible();
    const queue = await page.evaluate(() => window.interview.practiceQueue());
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]).toMatchObject({ review_count: 1, interval_days: 3, paused: false });
    expect((await page.evaluate(() => window.interview.snapshot())).sessions[0].submitted).toBe(
      false,
    );
    await dialog.locator('.practice-reflection-history summary').click();
    await expect(dialog.locator('.practice-reflection-history')).toContainText(answer);
    await dialog.getByRole('button', { name: 'Upcoming', exact: true }).click();
    await dialog.getByRole('button', { name: 'Pause reminder', exact: true }).click();
    await dialog.getByRole('button', { name: 'Paused', exact: true }).click();
    await expect(dialog.getByLabel('Your recall answer')).toBeDisabled();
    await dialog.getByRole('button', { name: 'Resume reminder', exact: true }).click();
    await dialog.getByRole('button', { name: 'Upcoming', exact: true }).click();
    await dialog.getByLabel('Reminder delay (days)').fill('0');
    await dialog.getByRole('button', { name: 'Move reminder', exact: true }).click();
    await dialog.getByRole('button', { name: /^Due now/ }).click();
    await expect(dialog.locator('.practice-queue-card')).toHaveCount(1);
    await dialog.getByRole('button', { name: 'Close practice queue', exact: true }).click();
    await page.getByRole('button', { name: 'System design', exact: true }).click();
    await page
      .getByRole('button', { name: /Link Alias Service/ })
      .first()
      .click();
    await expect(page.locator('.excalidraw')).toBeVisible();
    await expect
      .poll(
        async () => (await page.evaluate(() => window.interview.snapshot())).designSessions.length,
      )
      .toBe(1);
    const design = (await page.evaluate(() => window.interview.snapshot())).designSessions[0];
    await page.getByRole('button', { name: 'Practice queue', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Practice queue', exact: true });
    await dialog.getByLabel('Practice to revisit').selectOption(`design:${design.id}`);
    await dialog.getByLabel('Reminder delay (days)').fill('0');
    await dialog.getByRole('button', { name: 'Add to queue', exact: true }).click();
    await expect(dialog.locator('.practice-queue-card')).toHaveCount(2);
    await dialog.getByLabel('Practice type').selectOption('design');
    await expect(dialog.locator('.practice-queue-card')).toHaveCount(1);
    await page.screenshot({ path: 'test-results/workbench-practice-queue.png', fullPage: true });
    expect((await page.evaluate(() => window.interview.snapshot())).settings.provider).toBe(
      'disabled',
    );
  } finally {
    await app.close();
  }
});

test('sandbox onboarding stays optional and refuses a remote Docker context', async () => {
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-sandbox-ui-')));
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    expect(await page.evaluate(() => window.interview.sandboxInfo())).toMatchObject({
      phase: 'unchecked',
      managed: false,
    });
    expect((await page.evaluate(() => window.interview.snapshot())).settings.managedSandbox).toBe(
      false,
    );
    await app.evaluate(({ dialog }) => {
      process.env.DOCKER_HOST = 'tcp://example.invalid:2375';
      dialog.showMessageBox = (async () => ({
        response: 0,
        checkboxChecked: false,
      })) as typeof dialog.showMessageBox;
    });
    await page.getByRole('button', { name: 'Open settings' }).click();
    await expect(
      page.getByText(/Optional execution uses a privileged Docker container/),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Enable local execution', exact: true }).click();
    expect((await page.evaluate(() => window.interview.snapshot())).settings.managedSandbox).toBe(
      false,
    );
    await page.getByRole('button', { name: 'Check local sandbox', exact: true }).click();
    await expect(page.locator('.sandbox-settings').getByRole('alert')).toContainText(
      'Remote Docker endpoints are not allowed',
    );
    expect((await page.evaluate(() => window.interview.sandboxInfo())).phase).toBe('unsupported');
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await page.getByRole('button', { name: 'System design', exact: true }).click();
    await expect(page.getByText('MCP connected · 5 design briefs')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('desktop run/submit against a real local Piston sandbox', async ({}, testInfo) => {
  test.skip(
    process.env.INTERVIEW_DESKTOP_TEST_PISTON !== '1',
    'Real Docker/Piston execution is enabled in desktop CI',
  );
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-desktop-piston-')));
  const page = await app.firstWindow();
  try {
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
    await pasteCode(page, 'def merge_delivery_holds(holds, grace_days): return []');
    await page.getByRole('button', { name: 'Run tests', exact: true }).click();
    await expect
      .poll(
        async () => {
          const state = await page.evaluate(() => window.interview.snapshot());
          return !state.busy && !!(state.error || state.sessions[0]?.result);
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    const failed = await page.evaluate(() => window.interview.snapshot());
    expect(failed.error).toBeNull();
    expect(failed.sessions[0].result?.all_passed).toBe(false);
    const solution =
      'def merge_delivery_holds(holds, grace_days):\n    merged = []\n    for start, end in sorted(holds):\n        if merged and start - merged[-1][1] <= grace_days:\n            merged[-1][1] = max(merged[-1][1], end)\n        else:\n            merged.append([start, end])\n    return merged\n';
    await pasteCode(page, solution);
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect
      .poll(
        async () => {
          const state = await page.evaluate(() => window.interview.snapshot());
          return (
            !state.busy &&
            !!(state.error || (state.sessions[0]?.result && !state.sessions[0].resultStale))
          );
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    const snapshot: Snapshot = await page.evaluate(() => window.interview.snapshot());
    expect(snapshot.error).toBeNull();
    expect(snapshot.sessions[0].code).toBe(solution);
    expect(snapshot.sessions[0].result).toMatchObject({
      all_passed: true,
      tests_passed: 7,
      tests_total: 7,
    });
    expect(snapshot.sessions[0].submitted).toBe(true);
    await expect(page.getByText('Attempt completed', { exact: true })).toBeVisible();
    await expect(page.getByText('7 of 7 tests passed')).toBeVisible();
    expect(snapshot.progress).toContain('completed');
    await page.screenshot({ path: 'test-results/workbench-tests-passed.png', fullPage: true });
  } catch (error) {
    await testInfo.attach('sandbox-workspace', {
      body: JSON.stringify(await page.evaluate(() => window.interview.snapshot()), null, 2),
      contentType: 'application/json',
    });
    await page.screenshot({ path: 'test-results/workbench-tests-failed.png', fullPage: true });
    throw error;
  } finally {
    await app.close();
  }
});
