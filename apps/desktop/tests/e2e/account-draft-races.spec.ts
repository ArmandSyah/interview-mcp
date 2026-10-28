import { expect, test } from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';
import { accountServer, connectAccount, pasteAccountDraft } from './account-fixture';
import { gateIpc } from './ipc-gate';

for (const saveFailure of [false, true]) {
  test(`design settings preserve pending account code (saveFailure=${saveFailure})`, async () => {
    const server = await accountServer();
    const data = await mkdtemp(join(tmpdir(), 'interview-account-draft-race-'));
    let app = await launch(data);
    let mode: Awaited<ReturnType<typeof gateIpc>> | undefined;
    let save: Awaited<ReturnType<typeof gateIpc>> | undefined;
    try {
      let page = await app.firstWindow();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
      await connectAccount(page, server.url, 'fixture-bob');
      await page.getByRole('button', { name: /Account fixture/ }).click();
      await pasteAccountDraft(page, '# Bob private code\n');
      const bob = await page.evaluate(() => window.interview.snapshot());
      await connectAccount(page, server.url, 'fixture-alice');
      await page.getByRole('button', { name: /Account fixture/ }).click();
      await pasteAccountDraft(page, '# Alice previous code\n');
      const alice = await page.evaluate(() => window.interview.snapshot());
      mode = await gateIpc(app, 'mode');
      await page.getByRole('button', { name: 'System design', exact: true }).click();
      await expect.poll(mode.calls).toEqual([['design']]);
      await page.clock.install();
      await page.clock.pauseAt(new Date());
      const editor = page.getByRole('textbox', { name: 'Python solution editor' });
      await editor.focus();
      await page.keyboard.press('ControlOrMeta+a');
      await editor.evaluate((element) => {
        const contents = new DataTransfer();
        contents.setData('text/plain', '# Alice pending private code\n');
        element.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: contents, bubbles: true, cancelable: true }),
        );
      });
      await mode.release(0);
      await expect(page.getByRole('button', { name: 'Coding', exact: true })).toBeVisible();
      await mode.restore();
      mode = undefined;
      if (saveFailure) {
        save = await gateIpc(app, 'save');
        const bobConnections = () =>
          server.requests.filter(
            (item) => item.name === 'get_connection_identity' && item.account === 'bob',
          ).length;
        const beforeConnections = bobConnections();
        await page.getByRole('button', { name: 'Open settings' }).click();
        const dialog = page.getByRole('dialog', { name: 'Workbench settings' });
        await dialog
          .getByLabel('MCP bearer key or account token', { exact: true })
          .fill('fixture-bob');
        await dialog
          .getByRole('button', { name: 'Save & connect' })
          .evaluate((button: HTMLButtonElement) => {
            button.click();
            button.click();
          });
        await expect
          .poll(save.calls)
          .toEqual([['fixture-account', '# Alice pending private code\n']]);
        await expect(dialog.getByRole('button', { name: 'Close settings' })).toBeDisabled();
        expect((await page.evaluate(() => window.interview.snapshot())).workspaceId).toBe(
          alice.workspaceId,
        );
        expect(bobConnections(), 'The account change must wait for the pending code write').toBe(
          beforeConnections,
        );
        await save.release(0, 'Fixture account draft write failure');
        await expect(dialog.getByRole('alert')).toContainText(
          'Fixture account draft write failure',
        );
        await expect(dialog.getByRole('button', { name: 'Save & connect' })).toBeEnabled();
        await expect(
          dialog.getByLabel('MCP bearer key or account token', { exact: true }),
        ).toHaveValue('fixture-bob');
        expect((await page.evaluate(() => window.interview.snapshot())).workspaceId).toBe(
          alice.workspaceId,
        );
        expect(bobConnections(), 'A failed draft write must not start a connection for Bob').toBe(
          beforeConnections,
        );
        expect(
          await readFile(
            join(data, 'practice', alice.workspaceId, 'fixture-account', 'solution.py'),
            'utf8',
          ),
        ).toBe('# Alice previous code\n');
        await page.screenshot({ path: 'test-results/account-draft-save-failure.png' });
        await dialog.getByRole('button', { name: 'Save & connect' }).click();
        await expect.poll(save.calls).toHaveLength(2);
        expect((await save.calls())[1]).toEqual((await save.calls())[0]);
        await save.restore();
        save = undefined;
        await expect(dialog).toHaveCount(0);
      } else await connectAccount(page, server.url, 'fixture-bob');
      await expect(page.getByRole('button', { name: 'Open settings' })).toBeEnabled();
      // Render the new editor before its 400-millisecond autosave deadline.
      await page.clock.runFor(100);
      await expect
        .soft(
          page.locator('.view-lines'),
          'Bob must not see Alice code after the design settings change',
        )
        .toContainText('Bob private code');
      await page.clock.runFor(1000);
      await page.clock.resume();
      const selected = await page.evaluate(() => window.interview.snapshot());
      expect(selected.workspaceId).toBe(bob.workspaceId);
      expect
        .soft(
          selected.sessions[0].code,
          'Autosave after the account change must not replace Bob code',
        )
        .toBe('# Bob private code\n');
      expect
        .soft(
          await readFile(
            join(data, 'practice', alice.workspaceId, 'fixture-account', 'solution.py'),
            'utf8',
          ),
          'The settings save must write the pending code to Alice before it changes accounts',
        )
        .toBe('# Alice pending private code\n');
      expect
        .soft(
          await readFile(
            join(data, 'practice', bob.workspaceId, 'fixture-account', 'solution.py'),
            'utf8',
          ),
          'Bob file must keep Bob code after Alice autosave',
        )
        .toBe('# Bob private code\n');
      await connectAccount(page, server.url, 'fixture-alice');
      await page.getByRole('button', { name: 'Coding', exact: true }).click();
      await expect.soft(page.locator('.view-lines')).toContainText('Alice pending private code');
      await app.close();
      app = await launch(data);
      page = await app.firstWindow();
      page.on('pageerror', (error) => errors.push(error.message));
      await expect(page.getByRole('button', { name: 'Open settings' })).toBeEnabled({
        timeout: 20_000,
      });
      await connectAccount(page, server.url, 'fixture-bob');
      await expect.soft(page.locator('.view-lines')).toContainText('Bob private code');
      expect(errors).toEqual([]);
    } finally {
      await mode?.restore().catch(() => {});
      await save?.restore().catch(() => {});
      await app.close().catch(() => {});
      await server.close();
    }
  });
}
