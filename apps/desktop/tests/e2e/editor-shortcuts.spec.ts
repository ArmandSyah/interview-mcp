import { expect, test, type Page } from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';
import { gateIpc } from './ipc-gate';

async function paste(page: Page, text: string) {
  const editor = page.getByRole('textbox', { name: 'Python solution editor' });
  await editor.focus();
  await page.keyboard.press('ControlOrMeta+a');
  await editor.evaluate((element, code) => {
    const data = new DataTransfer();
    data.setData('text/plain', code);
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, text);
}

test('editor save and test shortcuts serialize requests and preserve drafts through file navigation', async () => {
  const data = await mkdtemp(join(tmpdir(), 'interview-editor-shortcuts-'));
  const app = await launch(data);
  let save: Awaited<ReturnType<typeof gateIpc>> | undefined;
  let run: Awaited<ReturnType<typeof gateIpc>> | undefined;
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Files explorer' }).click();
    await expect(page.getByText('Open a problem to create a practice workspace.')).toBeVisible();
    await page.getByRole('button', { name: 'Problem explorer' }).click();
    await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
    await expect(page.getByTestId('code-editor')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open settings' })).toBeEnabled();
    const first = '# first keyboard draft\n';
    const latest = '# latest keyboard draft\n';
    save = await gateIpc(app, 'save');
    await paste(page, first);
    await page.keyboard.press('ControlOrMeta+s');
    await page.keyboard.press('ControlOrMeta+s');
    await expect.poll(() => save!.calls()).toEqual([['0015-delivery-hold-clusters', first]]);
    await paste(page, latest);
    await page.keyboard.press('ControlOrMeta+s');
    expect(await save.calls()).toHaveLength(1);
    await save.release(0);
    await expect
      .poll(() => save!.calls())
      .toEqual([
        ['0015-delivery-hold-clusters', first],
        ['0015-delivery-hold-clusters', latest],
      ]);
    await save.release(1);
    await expect(page.getByText('Draft saved', { exact: true })).toBeVisible();
    await save.restore();
    save = undefined;
    const saved = await page.evaluate(() => window.interview.snapshot());
    expect(
      await readFile(
        join(data, 'practice', saved.workspaceId, saved.activeProblemId!, 'solution.py'),
        'utf8',
      ),
    ).toBe(latest);

    run = await gateIpc(app, 'run');
    await page.getByRole('button', { name: 'Show progress', exact: true }).click();
    await page.getByRole('textbox', { name: 'Python solution editor' }).focus();
    await page.keyboard.press('ControlOrMeta+Enter');
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect.poll(() => run!.calls()).toEqual([[false]]);
    await expect(page.getByRole('button', { name: 'Run tests', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'TEST RESULTS', exact: true })).toHaveClass(
      /active/,
    );
    await run.release(0, 'Fixture shortcut execution failure');
    await expect(
      page.getByRole('alert').filter({ hasText: 'Fixture shortcut execution failure' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run tests', exact: true })).toBeEnabled();
    await run.restore();
    run = undefined;

    await page.getByRole('button', { name: /Training Mix Segment/ }).click();
    await expect(page.locator('.breadcrumb')).toContainText('Training Mix Segment');
    const second = '# different problem draft\n';
    await paste(page, second);
    await page.getByRole('button', { name: 'Files explorer' }).click();
    await page
      .locator('.file-tree')
      .getByRole('button', { name: 'problem.md', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Training Mix Segment', exact: true }),
    ).toBeVisible();
    await page
      .locator('.file-tree')
      .getByRole('button', { name: /Delivery Hold Clusters/ })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Delivery Hold Clusters', exact: true }),
    ).toBeVisible();
    await page
      .locator('.file-tree')
      .getByRole('button', { name: 'solution.py', exact: true })
      .click();
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('latest keyboard draft');
    await page.getByRole('button', { name: /Training Mix Segment/ }).click();
    await expect(page.locator('.monaco-editor .view-lines')).toContainText(
      'different problem draft',
    );
    const after = await page.evaluate(() => window.interview.snapshot());
    expect(after.sessions.map((session) => session.code)).toEqual([latest, second]);
    expect(errors).toEqual([]);
  } finally {
    await save?.restore().catch(() => {});
    await run?.restore().catch(() => {});
    await app.close();
  }
});
