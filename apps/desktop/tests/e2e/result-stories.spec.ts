import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';
import { accountServer, connectAccount, pasteAccountDraft } from './account-fixture';
import { testReport } from '../test-report-fixture';
import type { TestRun } from '../../src/shared/types';
import { controlledCoach } from './chat-fixture';

test('an invalid test report keeps the desktop usable and the previous result unchanged', async () => {
  const server = await accountServer(async () => ({ tests_total: 1, tests_passed: 0 }));
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-result-ui-')));
  const errors: string[] = [];
  try {
    const page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await connectAccount(page, server.url, 'fixture-alice');
    await page.getByRole('button', { name: /Account fixture/ }).click();
    await pasteAccountDraft(page, '# Result validation draft\n');
    await page.getByRole('button', { name: 'Run tests', exact: true }).click();
    await expect
      .poll(async () => (await page.evaluate(() => window.interview.snapshot())).busy)
      .toBe(false);
    expect(errors, 'Invalid report must not cause a renderer exception').toEqual([]);
    await expect(page.getByRole('button', { name: 'Run tests', exact: true })).toBeEnabled();
    await expect(page.getByRole('alert').filter({ hasText: 'Invalid test report' })).toBeVisible();
    expect((await page.evaluate(() => window.interview.snapshot())).sessions[0]).toMatchObject({
      result: null,
      submitted: false,
      code: '# Result validation draft\n',
    });
  } finally {
    // A renderer crash cannot acknowledge the normal close request.
    if (errors.length) await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    await server.close();
  }
});

test('result controls preserve the captured draft and display pass, wrong answer, and execution errors', async () => {
  let release: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  let passing = false;
  const server = await accountServer(async (name, args) => {
    const result = testReport(String(args.attempt_id), 'fixture-account', passing);
    if (!passing) {
      result.tests = [
        { ...result.tests[0], passed: true, actual: 2 },
        { ...result.tests[0], index: 1, actual: 7, user_stdout: '<img src=x onerror=alert(1)>' },
        {
          ...result.tests[0],
          index: 2,
          error: 'Fixture execution error',
          user_stderr: 'Fixture stderr',
        },
      ];
      result.tests_total = 3;
      result.tests_passed = 1;
    }
    result.execution_source = 'local_report';
    result.verification = 'not_server_verified';
    await gate;
    return name === 'submit_solution'
      ? {
          completed: result.all_passed,
          test_run: result,
          followup_questions: result.all_passed ? 'Explain the test result.' : null,
          message: 'Fixture submission',
        }
      : result;
  });
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-result-controls-')));
  const errors: string[] = [];
  try {
    const page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await connectAccount(page, server.url, 'fixture-alice');
    await page.getByRole('button', { name: /Account fixture/ }).click();
    await pasteAccountDraft(page, '# Captured draft\n');
    gate = new Promise<void>((done) => {
      release = done;
    });
    await page
      .getByRole('button', { name: 'Run tests', exact: true })
      .evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
        Array.from(document.querySelectorAll('button'))
          .find((item) => item.textContent?.trim() === 'Submit')
          ?.click();
      });
    await expect
      .poll(() => server.requests.filter((call) => call.name === 'run_tests'))
      .toHaveLength(1);
    await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Open settings' })).toBeDisabled();
    await pasteAccountDraft(page, '# Newer draft\n');
    expect(server.requests.find((call) => call.name === 'run_tests')?.args.code).toBe(
      '# Captured draft\n',
    );
    expect(server.requests.filter((call) => call.name === 'submit_solution')).toHaveLength(0);
    release!();
    gate = undefined;
    await expect(page.getByText('1 of 3 tests passed', { exact: true })).toBeVisible();
    await expect(page.getByText('Results are for an older draft', { exact: true })).toBeVisible();
    await expect(
      page.getByText('Local report — not server verified', { exact: true }),
    ).toBeVisible();
    const cases = page.locator('.test-case');
    await expect(cases).toHaveCount(3);
    await expect(cases.nth(0)).not.toHaveAttribute('open');
    await cases.nth(0).locator('summary').click();
    await expect(cases.nth(0)).toHaveAttribute('open', '');
    await expect(cases.nth(0).locator('.test-detail')).toContainText('Expected2');
    await expect(cases.nth(1)).toHaveAttribute('open', '');
    await expect(cases.nth(1)).toContainText('Wrong answer');
    await expect(
      cases.nth(1).getByText('<img src=x onerror=alert(1)>', { exact: true }),
    ).toBeVisible();
    await expect(cases.nth(1).locator('img')).toHaveCount(0);
    await expect(cases.nth(2)).toContainText('Fixture execution error');
    await expect(cases.nth(2)).toContainText('Fixture stderr');
    await cases.nth(2).locator('summary').click();
    await expect(cases.nth(2)).not.toHaveAttribute('open');
    await page.getByRole('button', { name: 'PROGRESS', exact: true }).click();
    await expect(page.getByText('Fixture progress for alice', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /TEST RESULTS/ }).click();
    await expect(page.getByText('1 of 3 tests passed', { exact: true })).toBeVisible();
    passing = true;
    await page.getByRole('button', { name: 'Run tests', exact: true }).click();
    await expect(page.getByText('1 of 1 tests passed', { exact: true })).toBeVisible();
    await expect(page.getByText('Results are for an older draft', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Attempt completed', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(page.getByText('Attempt completed', { exact: true })).toBeVisible();
    await expect(page.getByText('Explain the test result.', { exact: true })).toHaveCount(1);
    passing = false;
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(page.getByText('1 of 3 tests passed', { exact: true })).toBeVisible();
    await expect(page.getByText('Attempt completed', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    release?.();
    if (errors.length) await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    await server.close();
  }
});

test('invalid submissions preserve the previous report and history through restart and retry', async () => {
  let invalid = false;
  const server = await accountServer(async (_name, args) => ({
    completed: true,
    test_run: testReport(String(args.attempt_id), 'fixture-account', true),
    followup_questions: invalid ? { wrong: 'not text' } : 'Explain your result.',
    message: 'Fixture submission',
  }));
  const data = await mkdtemp(join(tmpdir(), 'interview-result-retry-'));
  let app = await launch(data);
  const errors: string[] = [];
  try {
    let page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await connectAccount(page, server.url, 'fixture-alice');
    await page.getByRole('button', { name: /Account fixture/ }).click();
    await pasteAccountDraft(page, '# Submission draft\n');
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Open settings' })).toBeEnabled();
    const previous = (await page.evaluate(() => window.interview.snapshot())).sessions[0];
    invalid = true;
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Invalid submission report' }),
    ).toBeVisible();
    expect((await page.evaluate(() => window.interview.snapshot())).sessions[0]).toEqual(previous);
    await expect(page.getByText('1 of 1 tests passed', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Dismiss error' }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Invalid submission report' }),
    ).toHaveCount(0);
    await app.close();
    app = await launch(data);
    page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByRole('button', { name: 'Open settings' })).toBeEnabled({
      timeout: 20_000,
    });
    await connectAccount(page, server.url, 'fixture-alice');
    expect((await page.evaluate(() => window.interview.snapshot())).sessions[0]).toEqual(previous);
    invalid = false;
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Open settings' })).toBeEnabled();
    await expect(page.getByText('Explain your result.', { exact: true })).toHaveCount(2);
    expect(errors).toEqual([]);
  } finally {
    if (errors.length) await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    await server.close();
  }
});

test('an invalid saved report leaves drafts available and a new run replaces the report', async () => {
  const server = await accountServer(async (_name, args) =>
    testReport(String(args.attempt_id), 'fixture-account', true),
  );
  const data = await mkdtemp(join(tmpdir(), 'interview-saved-report-'));
  let app = await launch(data);
  const errors: string[] = [];
  try {
    let page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await connectAccount(page, server.url, 'fixture-alice');
    await page.getByRole('button', { name: /Account fixture/ }).click();
    await pasteAccountDraft(page, '# Preserved saved draft\n');
    await app.close();
    const path = join(data, 'workspace.json');
    const state = JSON.parse(await readFile(path, 'utf8'));
    const workspace = Object.values(state.workspaces).find(
      (item) => (item as { sessions: unknown[] }).sessions.length,
    ) as { sessions: { result: unknown }[] };
    workspace.sessions[0].result = { tests_total: { invalid: true }, tests: null };
    await writeFile(path, JSON.stringify(state));
    app = await launch(data);
    page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByRole('button', { name: 'Open settings' })).toBeEnabled({
      timeout: 20_000,
    });
    await connectAccount(page, server.url, 'fixture-alice');
    await expect(
      page.getByRole('alert').filter({ hasText: 'Cannot display the saved test report' }),
    ).toBeVisible();
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('Preserved saved draft');
    expect((await page.evaluate(() => window.interview.snapshot())).sessions[0].result).toEqual(
      workspace.sessions[0].result,
    );
    await page.getByRole('button', { name: 'Run tests', exact: true }).click();
    await expect(page.getByText('1 of 1 tests passed', { exact: true })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'Cannot display' })).toHaveCount(0);
    const result = (await page.evaluate(() => window.interview.snapshot())).sessions[0]
      .result as TestRun;
    expect(result.all_passed).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    if (errors.length) await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    await server.close();
  }
});

test('the coach rejects invalid saved counts and releases its controls after each reply', async () => {
  const server = await accountServer();
  const coach = await controlledCoach();
  const data = await mkdtemp(join(tmpdir(), 'interview-report-coach-'));
  let app = await launch(data);
  try {
    let page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await connectAccount(page, server.url, 'fixture-alice');
    await page.getByRole('button', { name: /Account fixture/ }).click();
    await pasteAccountDraft(page, '# Coach must preserve this draft\n');
    await app.close();
    const path = join(data, 'workspace.json');
    const state = JSON.parse(await readFile(path, 'utf8'));
    const workspace = Object.values(state.workspaces).find(
      (item) => (item as { sessions: unknown[] }).sessions.length,
    ) as { sessions: { result: unknown }[] };
    const invalid = { tests_passed: { toString: null, valueOf: null }, tests_total: 3 };
    workspace.sessions[0].result = invalid;
    await writeFile(path, JSON.stringify(state));
    app = await launch(data);
    page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Open settings' })).toBeEnabled({
      timeout: 20_000,
    });
    await connectAccount(page, server.url, 'fixture-alice');
    await page.getByRole('button', { name: 'Open settings' }).click();
    await page.getByLabel('Provider').selectOption('ollama');
    await page.getByLabel('Ollama URL').fill(coach.url);
    await page.getByRole('button', { name: 'Save & connect' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const composer = page.getByRole('textbox', { name: 'Message the coach', exact: true });
    for (const index of [0, 1]) {
      await composer.fill(`Explain my draft ${index}.`);
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect.poll(() => coach.requests).toHaveLength(index + 1);
      expect(coach.requests[index].messages.at(-1)?.content).toContain(
        'Last tests: Saved report is invalid. Run tests again.',
      );
      expect(coach.requests[index].messages.at(-1)?.content).toContain(
        '# Coach must preserve this draft',
      );
      coach.finish(index, ' Fixture final reply.');
      await expect(page.getByRole('button', { name: 'Open settings' })).toBeEnabled();
      const snapshot = await page.evaluate(() => window.interview.snapshot());
      expect(snapshot).toMatchObject({ busy: false, chatId: null, error: null });
      expect(snapshot.sessions[0].result).toEqual(invalid);
      expect(snapshot.sessions[0].code).toBe('# Coach must preserve this draft\n');
    }
  } finally {
    await app.close().catch(() => {});
    await server.close();
    await coach.close();
  }
});
