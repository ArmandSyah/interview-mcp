import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { Snapshot } from '../../src/shared/types';

const appRoot = resolve('.');

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
async function launch(data: string): Promise<ElectronApplication> {
  return electron.launch({
    ...(process.env.INTERVIEW_DESKTOP_EXECUTABLE
      ? { executablePath: process.env.INTERVIEW_DESKTOP_EXECUTABLE }
      : {}),
    args: [
      ...(process.env.INTERVIEW_DESKTOP_EXECUTABLE ? [] : [appRoot]),
      ...(process.platform === 'linux' ? ['--ozone-platform=x11'] : []),
    ],
    env: {
      ...process.env,
      INTERVIEW_DESKTOP_DATA_DIR: data,
      INTERVIEW_DESKTOP_PROBLEMS_DIR: '',
      INTERVIEW_DESKTOP_DEV_URL: '',
    },
    timeout: 30_000,
  });
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
