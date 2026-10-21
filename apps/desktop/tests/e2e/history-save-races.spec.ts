import { expect, test } from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';
import { controlledCoach, openCoach } from './chat-fixture';

type WriteGate = {
  original: typeof import('node:fs/promises').rename;
  calls: number;
  release?: (error?: string) => void;
};
type TestIpc = Electron.IpcMain & { historyWriteTest?: WriteGate };

for (const failure of [false, true]) {
  test(`code edits survive a pending history clear and restart (failure=${failure})`, async () => {
    const coach = await controlledCoach();
    const data = await mkdtemp(join(tmpdir(), 'interview-history-save-'));
    let app = await launch(data);
    let gated = false;
    const restore = () =>
      app.evaluate(({ ipcMain }) => {
        const ipc = ipcMain as TestIpc;
        const gate = ipc.historyWriteTest;
        if (!gate) return;
        process.getBuiltinModule('node:fs/promises').rename = gate.original;
        gate.release?.();
        delete ipc.historyWriteTest;
      });
    try {
      let page = await app.firstWindow();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const { composer, send } = await openCoach(page, coach.url);
      await composer.fill('History before the clear.');
      await send.click();
      await expect.poll(() => coach.requests).toHaveLength(1);
      coach.finish(0, ' Keep this evidence if the clear fails.');
      await expect(page.getByRole('button', { name: 'Stop coach', exact: true })).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'Clear conversation', exact: true }),
      ).toBeEnabled();
      const before = await page.evaluate(() => window.interview.snapshot());
      const disk = await readFile(join(data, 'workspace.json'), 'utf8');
      await app.evaluate(
        ({ ipcMain }, path) => {
          const fs = process.getBuiltinModule(
            'node:fs/promises',
          ) as typeof import('node:fs/promises');
          const gate: WriteGate = { original: fs.rename, calls: 0 };
          (ipcMain as TestIpc).historyWriteTest = gate;
          fs.rename = async (from, to) => {
            if (to === path && ++gate.calls === 1)
              await new Promise<void>((resolve, reject) => {
                gate.release = (error) => (error ? reject(new Error(error)) : resolve());
              });
            return gate.original(from, to);
          };
        },
        join(data, 'workspace.json'),
      );
      gated = true;
      await page.getByRole('button', { name: 'Clear conversation', exact: true }).click();
      await expect
        .poll(() => app.evaluate(({ ipcMain }) => !!(ipcMain as TestIpc).historyWriteTest?.release))
        .toBe(true);
      const code = '# code entered during history clear\n';
      const editor = page.getByRole('textbox', { name: 'Python solution editor' });
      await editor.focus();
      await page.keyboard.press('ControlOrMeta+a');
      await editor.evaluate((element, code) => {
        const clipboard = new DataTransfer();
        clipboard.setData('text/plain', code);
        element.dispatchEvent(
          new ClipboardEvent('paste', {
            clipboardData: clipboard,
            bubbles: true,
            cancelable: true,
          }),
        );
      }, code);
      await expect(page.getByText('Saving draft…', { exact: true })).toBeVisible();
      await expect(page.locator('.monaco-editor .view-lines')).toContainText(
        'code entered during history clear',
      );
      await expect(
        page.getByText(before.sessions[0].chat.at(-1)!.text, { exact: true }),
      ).toBeVisible();
      expect((await page.evaluate(() => window.interview.snapshot())).sessions[0].chat).toEqual(
        before.sessions[0].chat,
      );
      expect(await readFile(join(data, 'workspace.json'), 'utf8')).toBe(disk);
      await app.evaluate(({ ipcMain }, failure) => {
        (ipcMain as TestIpc).historyWriteTest!.release!(
          failure ? 'Fixture clear commit failure' : undefined,
        );
      }, failure);
      if (failure)
        await expect(
          page.getByRole('alert').filter({ hasText: 'Fixture clear commit failure' }),
        ).toBeVisible();
      await expect(page.getByText('Draft saved', { exact: true })).toBeVisible();
      const expected = failure ? before.sessions[0].chat : [];
      const after = await page.evaluate(() => window.interview.snapshot());
      expect(after.sessions[0].chat).toEqual(expected);
      expect(after.sessions[0].code).toBe(code);
      expect(after.busy).toBe(false);
      expect(errors).toEqual([]);
      await restore();
      gated = false;
      await app.close();
      app = await launch(data);
      page = await app.firstWindow();
      await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
      const reopened = await page.evaluate(() => window.interview.snapshot());
      expect(reopened.sessions[0].chat).toEqual(expected);
      expect(reopened.sessions[0].code).toBe(code);
    } finally {
      if (gated) await restore().catch(() => {});
      await app.close().catch(() => {});
      await coach.close();
    }
  });
}
