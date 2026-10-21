import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';
import { gateIpc } from './ipc-gate';

async function focusStaysInside(page: Page, dialog: Locator) {
  const inside = () => dialog.evaluate((element) => element.contains(document.activeElement));
  await expect.poll(inside, { message: 'The dialog must receive focus when it opens' }).toBe(true);
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let index = 0; index < 18; index++) {
      await page.keyboard.press(key);
      expect(
        await inside(),
        `${key} step ${index + 1} must not focus the background workspace`,
      ).toBe(true);
    }
  }
}

for (const mode of ['coding', 'design'] as const) {
  test(`${mode} settings contain keyboard focus and Escape discards unsaved settings`, async () => {
    const app = await launch(await mkdtemp(join(tmpdir(), 'interview-modal-focus-')));
    try {
      const page = await app.firstWindow();
      await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
      if (mode === 'design')
        await page.getByRole('button', { name: 'System design', exact: true }).click();
      const opener = page.getByRole('button', { name: 'Open settings' });
      await opener.click();
      const dialog = page.getByRole('dialog', { name: 'Workbench settings' });
      await focusStaysInside(page, dialog);
      await dialog.getByLabel('Provider').selectOption('ollama');
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(opener, 'Closing the dialog must restore focus to its opener').toBeFocused();
      expect((await page.evaluate(() => window.interview.snapshot())).settings.provider).toBe(
        'disabled',
      );
    } finally {
      await app.close();
    }
  });
}

test('settings prevent focus and edits in the code editor behind the dialog', async () => {
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-modal-editor-')));
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
    await expect(page.getByTestId('code-editor')).toBeVisible();
    await page.getByRole('button', { name: 'Open settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Workbench settings' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Close settings' }).focus();
    await page
      .locator('.monaco-editor textarea')
      .evaluate((element: HTMLTextAreaElement) => element.focus());
    expect(
      await dialog.evaluate((element) => element.contains(document.activeElement)),
      'A modal dialog must prevent programmatic focus in the background editor',
    ).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Python solution editor' }).focus();
    await expect(page.getByRole('textbox', { name: 'Python solution editor' })).toBeFocused();
  } finally {
    await app.close();
  }
});

for (const [kind, mode] of [
  ['queue', 'coding'],
  ['queue', 'design'],
  ['history', 'design'],
] as const) {
  test(`${mode} ${kind} dialog contains focus and Escape restores the previous control`, async () => {
    const app = await launch(await mkdtemp(join(tmpdir(), 'interview-secondary-modal-')));
    try {
      const page = await app.firstWindow();
      await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
      if (mode === 'design') {
        await page.getByRole('button', { name: 'System design', exact: true }).click();
      }
      if (kind === 'history') {
        await page
          .getByRole('button', { name: /Link Alias Service/ })
          .first()
          .click();
        await expect(
          page.getByRole('textbox', { name: 'Requirements', exact: true }),
        ).toBeVisible();
      }
      const opener = page.getByRole('button', {
        name: kind === 'queue' ? 'Practice queue' : 'History',
        exact: true,
      });
      await opener.click();
      const dialog = page.getByRole('dialog', {
        name: kind === 'queue' ? 'Practice queue' : 'Design checkpoint history',
        exact: true,
      });
      await expect(
        dialog.getByRole('button', {
          name: kind === 'queue' ? 'Close practice queue' : 'Close history',
        }),
      ).toBeEnabled();
      await focusStaysInside(page, dialog);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(opener).toBeFocused();
    } finally {
      await app.close();
    }
  });
}

test('settings and a long checkpoint history stay usable in a small desktop viewport', async () => {
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-modal-size-')));
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    // WSLg can ignore native resize requests. Set the renderer viewport explicitly.
    await page.setViewportSize({ width: 1040, height: 633 });
    await expect
      .poll(() => page.evaluate(() => innerWidth), {
        message: 'The renderer must reach the requested width before the layout check',
      })
      .toBeLessThanOrEqual(1040);
    await expect.poll(() => page.evaluate(() => innerHeight)).toBeLessThanOrEqual(660);
    await page.getByRole('button', { name: 'Open settings' }).click();
    const settings = page.getByRole('dialog', { name: 'Workbench settings' });
    await expect(settings).toBeVisible();
    const bounds = await settings.boundingBox();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
    await page.screenshot({ path: 'test-results/workbench-settings-minimum.png' });
    const save = settings.getByRole('button', { name: 'Save & connect' });
    await save.focus();
    await expect(save).toBeInViewport();
    await page.keyboard.press('Enter');
    await expect(settings).toHaveCount(0);
    await page.getByRole('button', { name: 'System design', exact: true }).click();
    await page
      .getByRole('button', { name: /Link Alias Service/ })
      .first()
      .click();
    const notes = page.getByRole('textbox', { name: 'Requirements', exact: true });
    await notes.fill('Requirements in the saved checkpoints.');
    await expect(page.getByText(/Saved locally/)).toBeVisible();
    // Seed real checkpoint records. The pointer and keyboard checks use the real dialog.
    await page.evaluate(async () => {
      for (let index = 0; index < 18; index++)
        await window.interview.checkpointDesign(`History record ${index + 1}`);
    });
    await notes.fill('Requirements before the history restore.');
    await page.getByRole('button', { name: 'History', exact: true }).click();
    const history = page.getByRole('dialog', { name: 'Design checkpoint history' });
    const restore = history.getByRole('button', { name: 'Restore', exact: true });
    await expect(restore).toHaveCount(18);
    await restore.first().hover();
    await page.mouse.wheel(0, 3000);
    await expect(restore.last(), 'The mouse wheel must reach the last checkpoint').toBeInViewport();
    await expect(history.getByRole('button', { name: 'Close history' })).toBeInViewport();
    await page.screenshot({ path: 'test-results/workbench-history-minimum.png' });
    await restore.last().click();
    await expect(history).toHaveCount(0);
    await expect(notes).toHaveValue('Requirements in the saved checkpoints.');
  } finally {
    await app.close();
  }
});

test('Escape cannot close settings while a save is pending', async () => {
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-modal-busy-')));
  let gate: Awaited<ReturnType<typeof gateIpc>> | undefined;
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Open settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Workbench settings' });
    gate = await gateIpc(app, 'settings');
    await dialog.getByRole('button', { name: 'Save & connect' }).click();
    await expect.poll(() => gate!.calls()).toHaveLength(1);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await page.mouse.click(10, 10);
    await expect(dialog).toBeVisible();
    await gate.release(0, 'Fixture settings failure');
    await expect(dialog.getByRole('alert')).toContainText('Fixture settings failure');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  } finally {
    await gate?.restore();
    await app.close();
  }
});

test('settings ignore a drag from inside the dialog and discard edits on a backdrop click', async () => {
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-modal-backdrop-')));
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    const opener = page.getByRole('button', { name: 'Open settings' });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Workbench settings' });
    await dialog.getByLabel('Provider').selectOption('ollama');
    const heading = await dialog.getByRole('heading', { name: 'Workbench settings' }).boundingBox();
    expect(heading).not.toBeNull();
    await page.mouse.move(heading!.x + 5, heading!.y + 5);
    await page.mouse.down();
    await page.mouse.move(10, 10);
    await page.mouse.up();
    await expect(dialog, 'A drag that starts in the dialog must not dismiss it').toBeVisible();
    await page.mouse.click(10, 10);
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    await opener.click();
    await expect(dialog.getByLabel('Provider')).toHaveValue('disabled');
  } finally {
    await app.close();
  }
});

for (const failure of [false, true]) {
  test(`a late initial snapshot ${failure ? 'failure' : 'response'} cannot replace a newer workspace event`, async () => {
    const app = await launch(await mkdtemp(join(tmpdir(), 'interview-startup-late-')));
    let gate: Awaited<ReturnType<typeof gateIpc>> | undefined;
    try {
      const page = await app.firstWindow();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
      gate = await gateIpc(app, 'snapshot', 'response');
      await page.reload();
      await expect.poll(() => gate!.calls()).toHaveLength(1);
      await page.evaluate(() => window.interview.setMode('design'));
      await expect(page.getByRole('button', { name: 'Coding', exact: true })).toBeVisible();
      await gate.release(0, failure ? 'Fixture late startup failure' : undefined);
      // A later IPC round trip follows the released response on the same renderer connection.
      await page.evaluate(() => window.interview.licenseNotices());
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      );
      await expect(page.getByRole('button', { name: 'Coding', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Retry workspace load' })).toHaveCount(0);
      expect(errors, 'A late initial request must not produce an unhandled rejection').toEqual([]);
    } finally {
      await gate?.restore();
      await app.close();
    }
  });
}

test('Escape preserves an unsaved recall answer when its write fails and saves it on retry', async () => {
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-recall-escape-')));
  let gate: Awaited<ReturnType<typeof gateIpc>> | undefined;
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
    await expect(page.getByTestId('code-editor')).toBeVisible();
    const initial = await page.evaluate(() => window.interview.snapshot());
    const opener = page.getByRole('button', { name: 'Practice queue', exact: true });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Practice queue', exact: true });
    await dialog
      .getByLabel('Practice to revisit')
      .selectOption(`coding:${initial.sessions[0].attemptId}`);
    await dialog.getByLabel('Reminder delay (days)').fill('0');
    await dialog.getByRole('button', { name: 'Add to queue', exact: true }).click();
    await dialog.getByRole('button', { name: 'Recall & reflect', exact: true }).click();
    const answer = dialog.getByLabel('Your recall answer');
    gate = await gateIpc(app, 'practice-draft-save');
    await answer.fill('Recall must survive Escape and a failed write.');
    await page.keyboard.press('Escape');
    await expect.poll(() => gate!.calls()).toHaveLength(1);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await gate.release(0, 'Fixture recall write failure');
    await expect(dialog.getByRole('alert')).toContainText('Fixture recall write failure');
    expect(
      await dialog.evaluate((element) => element.contains(document.activeElement)),
      'A failed save must keep keyboard focus in the dialog',
    ).toBe(true);
    await expect(answer).toHaveValue('Recall must survive Escape and a failed write.');
    await page.keyboard.press('Escape');
    await expect.poll(() => gate!.calls()).toHaveLength(2);
    await gate.release(1);
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    await opener.click();
    await dialog.getByRole('button', { name: 'Recall & reflect', exact: true }).click();
    await expect(answer).toHaveValue('Recall must survive Escape and a failed write.');
  } finally {
    await gate?.restore();
    await app.close();
  }
});

test('history exposes a failed restore inside the modal and permits a successful retry', async () => {
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-history-retry-')));
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
    await notes.fill('Checkpoint requirements.');
    await page.getByRole('button', { name: 'Checkpoint', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Checkpoint', exact: true })).toBeEnabled();
    await notes.fill('New requirements before restore.');
    const opener = page.getByRole('button', { name: 'History', exact: true });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Design checkpoint history' });
    gate = await gateIpc(app, 'design-restore');
    await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect.poll(() => gate!.calls()).toHaveLength(1);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await gate.release(0, 'Fixture checkpoint restore failure');
    await expect(dialog.getByRole('alert')).toContainText('Fixture checkpoint restore failure');
    const snapshot = await page.evaluate(() => window.interview.snapshot());
    expect(
      (
        await page.evaluate(
          (id) => window.interview.loadDesignDraft(id),
          snapshot.activeDesignSessionId!,
        )
      ).notes.requirements,
    ).toBe('New requirements before restore.');
    await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect.poll(() => gate!.calls()).toHaveLength(2);
    await gate.release(1);
    await expect(dialog).toHaveCount(0);
    await expect(notes).toHaveValue('Checkpoint requirements.');
    await expect(opener).toBeFocused();
    await expect(page.getByRole('alert')).toHaveCount(0);
  } finally {
    await gate?.restore();
    await app.close();
  }
});

test('a failed initial snapshot offers one retry and keeps the saved workspace', async () => {
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-startup-retry-')));
  let gate: Awaited<ReturnType<typeof gateIpc>> | undefined;
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
    await expect(page.getByTestId('code-editor')).toBeVisible();
    gate = await gateIpc(app, 'snapshot');
    await page.reload();
    await expect.poll(() => gate!.calls()).toHaveLength(1);
    await gate.release(0, 'Fixture startup snapshot failure');
    await expect(page.getByRole('alert')).toContainText('Fixture startup snapshot failure');
    const retry = page.getByRole('button', { name: 'Retry workspace load' });
    await retry.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    await expect.poll(() => gate!.calls()).toHaveLength(2);
    await gate.release(1);
    await expect(page.getByTestId('code-editor')).toBeVisible();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible();
    expect(
      await gate.calls(),
      'Repeated retry clicks must produce one new snapshot request',
    ).toHaveLength(2);
    expect(errors, 'Startup failure must not produce an unhandled promise rejection').toEqual([]);
  } finally {
    await gate?.restore();
    await app.close();
  }
});
