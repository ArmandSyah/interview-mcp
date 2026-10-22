import { expect, test } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';
import { gateIpc } from './ipc-gate';
import { pasteAccountDraft } from './account-fixture';

for (const mode of ['coding', 'design'] as const) {
  for (const transition of ['attempt', 'mode'] as const) {
    test(`${mode}: an edit after the ${transition} navigation flush reaches its previous attempt`, async () => {
      const data = await mkdtemp(join(tmpdir(), 'interview-late-navigation-'));
      let app = await launch(data);
      let navigation: Awaited<ReturnType<typeof gateIpc>> | undefined;
      try {
        let page = await app.firstWindow();
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
        if (mode === 'coding') {
          await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
          await pasteAccountDraft(page, '# Previous code\n');
        } else {
          await page.getByRole('button', { name: 'System design', exact: true }).click();
          await page
            .getByRole('button', { name: /Link Alias Service/ })
            .first()
            .click();
          await page
            .getByRole('textbox', { name: 'Requirements', exact: true })
            .fill('Previous notes');
          await expect(page.getByText(/Saved locally/)).toBeVisible();
        }
        const before = await page.evaluate(() => window.interview.snapshot());
        navigation = await gateIpc(
          app,
          transition === 'mode' ? 'mode' : mode === 'coding' ? 'start' : 'design-start',
        );
        await page
          .getByRole('button', {
            name:
              transition === 'mode'
                ? mode === 'coding'
                  ? 'System design'
                  : 'Coding'
                : mode === 'coding'
                  ? /Training Mix Segment/
                  : 'New attempt',
            exact: transition === 'mode' || mode === 'design',
          })
          .click();
        await expect.poll(navigation.calls).toHaveLength(1);
        // Stop the autosave deadline. Change the draft after the first navigation flush.
        await page.clock.install();
        await page.clock.pauseAt(new Date());
        if (mode === 'coding') {
          const editor = page.getByRole('textbox', { name: 'Python solution editor' });
          await editor.focus();
          await page.keyboard.press('ControlOrMeta+a');
          await editor.evaluate((element) => {
            const data = new DataTransfer();
            data.setData('text/plain', '# Late navigation code\n');
            element.dispatchEvent(
              new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
            );
          });
        } else {
          await page
            .getByRole('textbox', { name: 'Requirements', exact: true })
            .fill('Late navigation notes');
        }
        await navigation.release(0);
        await expect
          .poll(async () => {
            const after = await page.evaluate(() => window.interview.snapshot());
            return transition === 'mode'
              ? after.mode !== mode
              : mode === 'coding'
                ? after.activeProblemId !== before.activeProblemId
                : after.activeDesignSessionId !== before.activeDesignSessionId;
          })
          .toBe(true);
        await page.clock.runFor(2000);
        await page.clock.resume();
        // Read service state before a subsequent action can save the edit.
        await expect
          .poll(
            async () => {
              if (mode === 'design')
                return page.evaluate(
                  (id) =>
                    window.interview.loadDesignDraft(id).then((draft) => draft.notes.requirements),
                  before.activeDesignSessionId!,
                );
              return page.evaluate(
                async (id) =>
                  (await window.interview.snapshot()).sessions.find(
                    (session) => session.problem.id === id,
                  )!.code,
                before.activeProblemId!,
              );
            },
            {
              message: `${mode} ${transition}: the edit after the first flush must reach the previous attempt without another action`,
            },
          )
          .toBe(mode === 'coding' ? '# Late navigation code\n' : 'Late navigation notes');
        if (transition === 'attempt') {
          const selected = await page.evaluate(() => window.interview.snapshot());
          if (mode === 'coding') {
            expect(selected.sessions).toHaveLength(before.sessions.length + 1);
            const created = selected.sessions.find(
              (session) => session.problem.id === selected.activeProblemId,
            )!;
            expect(created.code, 'The new attempt must keep its starter code').not.toContain(
              'Late navigation code',
            );
            expect(created.code.length).toBeGreaterThan(0);
          } else {
            expect(selected.designSessions).toHaveLength(before.designSessions.length + 1);
            const created = await page.evaluate(
              (id) => window.interview.loadDesignDraft(id),
              selected.activeDesignSessionId!,
            );
            expect(created.notes.requirements, 'The new attempt must keep its empty notes').toBe(
              '',
            );
          }
        }
        await navigation.restore();
        navigation = undefined;
        await app.close();
        app = await launch(data);
        page = await app.firstWindow();
        page.on('pageerror', (error) => errors.push(error.message));
        await expect(page.getByText(/MCP connected · 5 (problems|design briefs)/)).toBeVisible({
          timeout: 20_000,
        });
        const after = await page.evaluate(() => window.interview.snapshot());
        if (after.mode !== mode)
          await page
            .getByRole('button', {
              name: mode === 'coding' ? 'Coding' : 'System design',
              exact: true,
            })
            .click();
        if (mode === 'coding') {
          await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
          await expect(page.locator('.view-lines')).toContainText('# Late navigation code');
        } else {
          if (transition === 'attempt') {
            await page.locator('.design-attempts summary').click();
            await page.locator('.design-attempts button').last().click();
          }
          await expect(
            page.getByRole('textbox', { name: 'Requirements', exact: true }),
          ).toHaveValue('Late navigation notes');
        }
        expect(errors).toEqual([]);
      } finally {
        await navigation?.restore().catch(() => {});
        await app.close().catch(() => {});
      }
    });
  }
}
