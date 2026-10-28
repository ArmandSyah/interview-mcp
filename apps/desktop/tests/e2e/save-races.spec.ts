import { expect, test, type Page } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';
import { gateIpc } from './ipc-gate';

async function pasteCode(page: Page, text: string) {
  const editor = page.getByRole('textbox', { name: 'Python solution editor' });
  await editor.focus();
  await page.keyboard.press('ControlOrMeta+a');
  await editor.evaluate((element, contents) => {
    const data = new DataTransfer();
    data.setData('text/plain', contents);
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, text);
}

test('coding draft stays visible when an older snapshot arrives during a save', async () => {
  const data = await mkdtemp(join(tmpdir(), 'interview-save-snapshot-'));
  const app = await launch(data);
  let gate: Awaited<ReturnType<typeof gateIpc>> | undefined;
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
    await expect(page.getByTestId('code-editor')).toBeVisible();
    const older = await page.evaluate(() => window.interview.snapshot());
    older.connection = 'disconnected';
    gate = await gateIpc(app, 'save');
    const draft = '# candidate draft must survive an older snapshot\n';
    await pasteCode(page, draft);
    await expect
      .poll(() => gate!.calls(), { message: 'saveCode must receive the edited draft' })
      .toEqual([[older.activeProblemId, draft]]);
    await app.evaluate(({ BrowserWindow }, snapshot) => {
      BrowserWindow.getAllWindows()[0].webContents.send('workbench:event', {
        type: 'snapshot',
        snapshot,
      });
    }, older);
    await expect(page.getByText('MCP disconnected', { exact: true })).toBeVisible();
    await expect(
      page.locator('.monaco-editor .view-lines'),
      'The older snapshot must not replace the draft while saveCode is pending',
    ).toContainText('candidate draft must survive an older snapshot');
    await gate.release(0);
    await expect
      .poll(async () => (await page.evaluate(() => window.interview.snapshot())).sessions[0].code)
      .toBe(draft);
  } finally {
    await gate?.restore();
    await app.close();
  }
});

test('a mode change waits for notes edited during an earlier save', async () => {
  const data = await mkdtemp(join(tmpdir(), 'interview-save-navigation-'));
  const app = await launch(data);
  let gate: Awaited<ReturnType<typeof gateIpc>> | undefined;
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'System design', exact: true }).click();
    await page
      .getByRole('button', { name: /Link Alias Service/ })
      .first()
      .click();
    const notes = page.getByRole('textbox', { name: 'Requirements', exact: true });
    await expect(notes).toBeVisible();
    // Let initial canvas events reach disk before the controlled edit.
    await expect(page.getByText(/Saved locally/)).toBeVisible();
    gate = await gateIpc(app, 'design-save');
    await notes.fill('First requirements draft.');
    await expect.poll(() => gate!.calls()).toHaveLength(1);
    await page.getByRole('button', { name: 'Coding', exact: true }).click();
    await notes.fill('Latest requirements draft, entered while the first save is pending.');
    await gate.release(0);
    await expect
      .poll(() => gate!.calls(), {
        message: 'The mode-change flush must save the latest notes before it leaves the design',
      })
      .toHaveLength(2);
    await expect(page.getByRole('button', { name: 'Coding', exact: true })).toBeVisible();
    await gate.release(1);
    await expect(page.getByRole('button', { name: 'System design', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'System design', exact: true }).click();
    await expect(notes).toHaveValue(
      'Latest requirements draft, entered while the first save is pending.',
    );
  } finally {
    await gate?.restore();
    await app.close();
  }
});

test('a failed coding save prevents navigation and a retry keeps the latest edit', async () => {
  const data = await mkdtemp(join(tmpdir(), 'interview-save-retry-'));
  const app = await launch(data);
  let gate: Awaited<ReturnType<typeof gateIpc>> | undefined;
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
    await expect(page.getByTestId('code-editor')).toBeVisible();
    gate = await gateIpc(app, 'save');
    await pasteCode(page, '# first draft\n');
    await expect.poll(() => gate!.calls()).toHaveLength(1);
    await page.getByRole('button', { name: 'System design', exact: true }).click();
    await gate.release(0, 'Fixture save failure');
    await expect(page.getByRole('alert').filter({ hasText: 'Fixture save failure' })).toBeVisible();
    await expect(page.getByText('Save failed', { exact: true })).toBeVisible();
    await expect(page.getByTestId('code-editor')).toBeVisible();
    const latest = '# latest draft after the failure\n';
    await pasteCode(page, latest);
    await page.getByRole('button', { name: 'System design', exact: true }).click();
    await expect.poll(() => gate!.calls()).toHaveLength(2);
    expect((await gate.calls())[1][1]).toBe(latest);
    await gate.release(1);
    await expect(page.getByRole('button', { name: 'Coding', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Coding', exact: true }).click();
    await expect(page.locator('.monaco-editor .view-lines')).toContainText(
      'latest draft after the failure',
    );
    expect((await page.evaluate(() => window.interview.snapshot())).sessions[0].code).toBe(latest);
    expect(errors).toEqual([]);
  } finally {
    await gate?.restore();
    await app.close();
  }
});

test('window close waits for a newer code edit and restores it after restart', async () => {
  const data = await mkdtemp(join(tmpdir(), 'interview-save-close-'));
  let app = await launch(data);
  let gate: Awaited<ReturnType<typeof gateIpc>> | undefined;
  try {
    let page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
    await expect(page.getByTestId('code-editor')).toBeVisible();
    gate = await gateIpc(app, 'save');
    await pasteCode(page, '# first draft\n');
    await expect.poll(() => gate!.calls()).toHaveLength(1);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    const latest = '# edit entered while the window waits for a save\n';
    await pasteCode(page, latest);
    await gate.release(0);
    await expect
      .poll(() => gate!.calls(), {
        message: 'Window close must wait for saveCode with the latest edit',
      })
      .toHaveLength(2);
    expect(page.isClosed(), 'The window must stay open until the last write succeeds').toBe(false);
    expect((await gate.calls())[1][1]).toBe(latest);
    await gate.restore();
    gate = undefined;
    await app.close();
    app = await launch(data);
    page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    expect((await page.evaluate(() => window.interview.snapshot())).sessions[0].code).toBe(latest);
    await expect(page.locator('.monaco-editor .view-lines')).toContainText(
      'edit entered while the window waits',
    );
  } finally {
    await gate?.restore();
    await app.close();
  }
});

test('a failed recall save keeps the dialog open and retains the latest answer on retry', async () => {
  const data = await mkdtemp(join(tmpdir(), 'interview-recall-save-retry-'));
  const app = await launch(data);
  let gate: Awaited<ReturnType<typeof gateIpc>> | undefined;
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
    await expect(page.getByTestId('code-editor')).toBeVisible();
    const initial = await page.evaluate(() => window.interview.snapshot());
    await page.getByRole('button', { name: 'Practice queue', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Practice queue', exact: true });
    await dialog
      .getByLabel('Practice to revisit')
      .selectOption(`coding:${initial.sessions[0].attemptId}`);
    await dialog.getByLabel('Reminder delay (days)').fill('0');
    await dialog.getByRole('button', { name: 'Add to queue', exact: true }).click();
    await dialog.getByRole('button', { name: 'Recall & reflect', exact: true }).click();
    const answer = dialog.getByLabel('Your recall answer');
    await expect(answer).toBeVisible();
    gate = await gateIpc(app, 'practice-draft-save');
    await answer.fill('First recall answer.');
    await expect.poll(() => gate!.calls()).toHaveLength(1);
    await dialog.getByRole('button', { name: 'Close practice queue', exact: true }).click();
    await gate.release(0, 'Fixture recall write failure');
    await expect(dialog.getByRole('alert')).toContainText('Fixture recall write failure');
    await expect(answer).toHaveValue('First recall answer.');
    const latest = 'Latest recall answer after the failed write.';
    await answer.fill(latest);
    await dialog.getByRole('button', { name: 'Close practice queue', exact: true }).click();
    await expect.poll(() => gate!.calls()).toHaveLength(2);
    await expect(dialog).toBeVisible();
    await gate.release(1);
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Practice queue', exact: true }).click();
    await dialog.getByRole('button', { name: 'Recall & reflect', exact: true }).click();
    await expect(answer).toHaveValue(latest);
  } finally {
    await gate?.restore();
    await app.close();
  }
});
