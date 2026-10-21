import { expect, test, type Page } from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
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

test('window close waits for an active hint and saves edits entered during that wait', async () => {
  const data = await mkdtemp(join(tmpdir(), 'interview-close-action-'));
  let app = await launch(data);
  let hint: Awaited<ReturnType<typeof gateIpc>> | undefined;
  let close: Awaited<ReturnType<typeof gateIpc>> | undefined;
  try {
    let page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
    await expect(page.getByTestId('code-editor')).toBeVisible();
    hint = await gateIpc(app, 'hint');
    close = await gateIpc(app, 'close-ready');
    await page.getByRole('button', { name: 'Hint', exact: true }).click();
    await expect.poll(() => hint!.calls()).toHaveLength(1);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].close();
      BrowserWindow.getAllWindows()[0].close();
    });
    await page.evaluate(() => window.interview.snapshot());
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    expect(await close.calls(), 'Close must not commit while the hint request is pending').toEqual(
      [],
    );
    const latest = '# edit entered while close waits for the hint\n';
    await pasteCode(page, latest);
    await hint.release(0);
    await expect.poll(() => close!.calls()).toEqual([[true]]);
    expect(page.isClosed()).toBe(false);
    const snapshot = await page.evaluate(() => window.interview.snapshot());
    expect(snapshot.sessions[0].hintDepth).toBe(1);
    expect(snapshot.sessions[0].code).toBe(latest);
    await hint.restore();
    hint = undefined;
    await close.restore();
    close = undefined;
    await app.close();
    app = await launch(data);
    page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    const reopened = await page.evaluate(() => window.interview.snapshot());
    expect(reopened.sessions[0].hintDepth).toBe(1);
    expect(reopened.sessions[0].code).toBe(latest);
  } finally {
    await hint?.restore().catch(() => {});
    await close?.restore().catch(() => {});
    await app.close().catch(() => {});
  }
});

for (const view of ['coding', 'settings', 'design', 'queue'] as const) {
  test(`${view}: a final workspace write failure keeps the window open and permits another close`, async () => {
    const data = await mkdtemp(join(tmpdir(), 'interview-close-write-'));
    let app = await launch(data);
    let injected = false;
    const restoreWrite = () =>
      app.evaluate(({ ipcMain }) => {
        const ipc = ipcMain as Electron.IpcMain & {
          closeTestRename?: typeof import('node:fs/promises').rename;
        };
        if (ipc.closeTestRename) {
          process.getBuiltinModule('node:fs/promises').rename = ipc.closeTestRename;
          delete ipc.closeTestRename;
        }
      });
    try {
      let page = await app.firstWindow();
      await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
      await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
      await expect(page.getByTestId('code-editor')).toBeVisible();
      if (view === 'settings') {
        await page.getByRole('button', { name: 'Open settings' }).click();
        await page.getByLabel('Provider').selectOption('ollama');
      } else if (view === 'design') {
        await page.getByRole('button', { name: 'System design', exact: true }).click();
        await page
          .getByRole('button', { name: /Link Alias Service/ })
          .first()
          .click();
        await page
          .getByRole('textbox', { name: 'Requirements', exact: true })
          .fill('Design before the failed close.');
        await expect(page.getByText(/Saved locally/)).toBeVisible();
      } else if (view === 'queue') {
        await page.getByRole('button', { name: 'Practice queue', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Close practice queue' })).toBeEnabled();
      }
      const before = await readFile(join(data, 'workspace.json'), 'utf8');
      await app.evaluate(
        ({ ipcMain }, path) => {
          const fs = process.getBuiltinModule(
            'node:fs/promises',
          ) as typeof import('node:fs/promises');
          const ipc = ipcMain as Electron.IpcMain & { closeTestRename?: typeof fs.rename };
          ipc.closeTestRename = fs.rename;
          fs.rename = async (from, to) => {
            if (to === path) throw new Error('Fixture final workspace write failure');
            return ipc.closeTestRename!(from, to);
          };
        },
        join(data, 'workspace.json'),
      );
      injected = true;
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
      await expect(
        page.getByRole('dialog', { name: 'Cannot close workspace' }).getByRole('alert'),
      ).toBeVisible();
      expect(page.isClosed(), 'A failed final write must not destroy the window').toBe(false);
      expect(await readFile(join(data, 'workspace.json'), 'utf8')).toBe(before);
      if (view === 'settings')
        await page.screenshot({ path: 'test-results/workbench-close-recovery.png' });
      await restoreWrite();
      injected = false;
      await page.getByRole('button', { name: 'Continue practice', exact: true }).click();
      if (view === 'settings') {
        await expect(page.getByLabel('Provider')).toHaveValue('ollama');
        await page.getByRole('button', { name: 'Close settings' }).click();
        expect((await page.evaluate(() => window.interview.snapshot())).settings.provider).toBe(
          'disabled',
        );
      } else if (view === 'queue') {
        await page.getByRole('button', { name: 'Close practice queue' }).click();
      } else if (view === 'design') {
        await expect(page.getByRole('textbox', { name: 'Requirements', exact: true })).toHaveValue(
          'Design before the failed close.',
        );
        await page.getByRole('button', { name: 'Coding', exact: true }).click();
      }
      await expect(page.getByRole('button', { name: 'Hint', exact: true })).toBeEnabled();
      await pasteCode(page, '# draft after the failed close\n');
      await app.close();
      app = await launch(data);
      page = await app.firstWindow();
      await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
      expect((await page.evaluate(() => window.interview.snapshot())).sessions[0].code).toBe(
        '# draft after the failed close\n',
      );
    } finally {
      if (injected) await restoreWrite().catch(() => {});
      await app.close().catch(() => {});
    }
  });
}

test('a close cancellation failure releases the interface and permits a new close request', async () => {
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-close-cancel-failure-')));
  let cancel: Awaited<ReturnType<typeof gateIpc>> | undefined;
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
    await expect(page.getByTestId('code-editor')).toBeVisible();
    cancel = await gateIpc(app, 'cancel');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect.poll(() => cancel!.calls()).toHaveLength(1);
    await cancel.release(0, 'Fixture close cancellation failure');
    const error = page.getByRole('dialog', { name: 'Cannot close workspace' });
    await expect(error.getByRole('alert')).toContainText('Fixture close cancellation failure');
    await error.getByRole('button', { name: 'Continue practice' }).click();
    await page.getByRole('button', { name: 'Hint', exact: true }).click();
    await expect
      .poll(
        async () => (await page.evaluate(() => window.interview.snapshot())).sessions[0].hintDepth,
      )
      .toBe(1);
    await cancel.restore();
    cancel = undefined;
    await app.close();
    expect(page.isClosed()).toBe(true);
  } finally {
    await cancel?.restore().catch(() => {});
    await app.close().catch(() => {});
  }
});

test('window close pauses the design timer and freezes input during the final close check', async () => {
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-close-timer-')));
  let close: Awaited<ReturnType<typeof gateIpc>> | undefined;
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'System design', exact: true }).click();
    await page
      .getByRole('button', { name: /Link Alias Service/ })
      .first()
      .click();
    const notes = page.getByRole('textbox', { name: 'Requirements', exact: true });
    await notes.fill('Timer close requirements.');
    await expect(page.getByText(/Saved locally/)).toBeVisible();
    await page.clock.install();
    await page.getByRole('button', { name: 'Start timer' }).click();
    close = await gateIpc(app, 'close-ready');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect.poll(() => close!.calls()).toEqual([[true]]);
    const before = await page.evaluate(async () => {
      const snapshot = await window.interview.snapshot();
      return window.interview.loadDesignDraft(snapshot.activeDesignSessionId!);
    });
    await page.clock.fastForward(5000);
    await notes.evaluate((element: HTMLTextAreaElement) => element.focus());
    expect(
      await notes.evaluate((element) => element === document.activeElement),
      'The final close check must prevent a new editor focus',
    ).toBe(false);
    const after = await page.evaluate(async () => {
      const snapshot = await window.interview.snapshot();
      return window.interview.loadDesignDraft(snapshot.activeDesignSessionId!);
    });
    expect(after.elapsedSeconds, 'The timer must not produce drafts during the close check').toBe(
      before.elapsedSeconds,
    );
    expect(after.notes.requirements).toBe('Timer close requirements.');
    await close.restore();
    close = undefined;
  } finally {
    await close?.restore().catch(() => {});
    await app.close().catch(() => {});
  }
});
