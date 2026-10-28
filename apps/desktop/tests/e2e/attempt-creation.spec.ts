import { expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';
import { gateIpc } from './ipc-gate';
import { pasteAccountDraft } from './account-fixture';

type CreationGate = {
  original: typeof import('node:fs/promises').rename;
  calls: { path: string; resolve: () => void; reject: (error: Error) => void }[];
};
type CreationIpc = Electron.IpcMain & { creationGate?: CreationGate };

async function holdCreationWrite(
  app: ElectronApplication,
  data: string,
  mode: 'coding' | 'design',
  phase: 'draft' | 'workspace',
  targetId: string,
  previousId: string | null,
) {
  await app.evaluate(
    ({ ipcMain }, options) => {
      const fs = process.getBuiltinModule('node:fs/promises');
      const ipc = ipcMain as CreationIpc;
      const gate: CreationGate = { original: fs.rename, calls: [] };
      ipc.creationGate = gate;
      fs.rename = async (from, to) => {
        const path = String(to).replaceAll('\\', '/');
        const root = options.data.replaceAll('\\', '/');
        const matches =
          options.phase === 'workspace'
            ? path === `${root}/workspace.json`
            : options.mode === 'coding'
              ? path.endsWith(`/${options.targetId}/solution.py`)
              : path.endsWith('/draft.json') && !path.includes(`/${options.previousId}/`);
        if (path.startsWith(`${root}/`) && matches && gate.calls.length === 0)
          await new Promise<void>((resolve, reject) => gate.calls.push({ path, resolve, reject }));
        return gate.original(from, to);
      };
    },
    { data, mode, phase, targetId, previousId },
  );
  return {
    calls: () =>
      app.evaluate(({ ipcMain }) =>
        (ipcMain as CreationIpc).creationGate!.calls.map((call) => call.path),
      ),
    fail: () =>
      app.evaluate(({ ipcMain }) => {
        (ipcMain as CreationIpc).creationGate!.calls[0].reject(
          new Error('Fixture attempt creation failure'),
        );
      }),
    restore: () =>
      app.evaluate(({ ipcMain }) => {
        const ipc = ipcMain as CreationIpc;
        const gate = ipc.creationGate;
        if (!gate) return;
        process.getBuiltinModule('node:fs/promises').rename = gate.original;
        for (const call of gate.calls) call.resolve();
        delete ipc.creationGate;
      }),
  };
}

for (const mode of ['coding', 'design'] as const) {
  for (const phase of ['draft', 'workspace'] as const) {
    test(`${mode}: a new attempt ${phase} write failure preserves edits, selection, and retry`, async () => {
      const data = await mkdtemp(join(tmpdir(), 'interview-attempt-creation-'));
      let app = await launch(data);
      let write: Awaited<ReturnType<typeof holdCreationWrite>> | undefined;
      let draft: Awaited<ReturnType<typeof gateIpc>> | undefined;
      try {
        let page = await app.firstWindow();
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
        if (mode === 'coding') {
          await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
          await pasteAccountDraft(page, '# Previous attempt draft\n');
        } else {
          await page.getByRole('button', { name: 'System design', exact: true }).click();
          await page
            .getByRole('button', { name: /Link Alias Service/ })
            .first()
            .click();
          await page
            .getByRole('textbox', { name: 'Requirements', exact: true })
            .fill('Previous attempt notes');
          await expect(page.getByText(/Saved locally/)).toBeVisible();
        }
        await expect(page.getByRole('button', { name: 'Open settings' })).toBeEnabled();
        const before = await page.evaluate(() => window.interview.snapshot());
        const target =
          mode === 'coding'
            ? before.problems.find((problem) => problem.title === 'Training Mix Segment')!.id
            : before.designSessions[0].problem_id;
        write = await holdCreationWrite(
          app,
          data,
          mode,
          phase,
          target,
          before.activeDesignSessionId,
        );
        draft = await gateIpc(app, mode === 'coding' ? 'save' : 'design-save');
        const create = () =>
          page.getByRole('button', {
            name: mode === 'coding' ? /Training Mix Segment/ : 'New attempt',
            exact: mode === 'design',
          });
        await create().evaluate((button: HTMLButtonElement) => {
          button.click();
          button.click();
        });
        await expect.poll(write.calls).toHaveLength(1);
        const pending = await page.evaluate(() => window.interview.snapshot());
        expect(pending.activeProblemId).toBe(before.activeProblemId);
        expect(pending.activeDesignSessionId).toBe(before.activeDesignSessionId);
        expect(pending.sessions).toEqual(before.sessions);
        expect(pending.designSessions).toEqual(before.designSessions);
        expect(pending.busy).toBe(true);
        if (mode === 'coding') {
          const editor = page.getByRole('textbox', { name: 'Python solution editor' });
          await editor.focus();
          await page.keyboard.press('ControlOrMeta+a');
          await editor.evaluate((element) => {
            const contents = new DataTransfer();
            contents.setData('text/plain', '# Edit during attempt creation\n');
            element.dispatchEvent(
              new ClipboardEvent('paste', {
                clipboardData: contents,
                bubbles: true,
                cancelable: true,
              }),
            );
          });
        } else {
          await page
            .getByRole('textbox', { name: 'Requirements', exact: true })
            .fill('Notes during attempt creation');
        }
        await expect.poll(draft.calls).toHaveLength(1);
        await draft.release(0);
        await write.fail();
        await expect(
          page.getByRole('alert').filter({ hasText: 'Fixture attempt creation failure' }),
        ).toBeVisible();
        const errorText = page.locator('.error-bar > span');
        await expect(errorText).toHaveText('Fixture attempt creation failure');
        await expect
          .poll(() =>
            errorText.evaluate((element) => {
              const box = element.getBoundingClientRect();
              const hit = document.elementFromPoint(box.left + 1, box.top + box.height / 2);
              return (
                box.top >= 0 &&
                box.bottom <= innerHeight &&
                (hit === element || (hit !== null && element.contains(hit)))
              );
            }),
          )
          .toBe(true);
        await expect(create()).toBeEnabled();
        if (mode === 'coding')
          await expect(page.getByText('Draft saved', { exact: true })).toBeVisible();
        else await expect(page.getByText(/Saved locally/)).toBeVisible();
        const failed = await page.evaluate(() => window.interview.snapshot());
        expect(failed.activeProblemId).toBe(before.activeProblemId);
        expect(failed.activeDesignSessionId).toBe(before.activeDesignSessionId);
        expect(failed.sessions).toHaveLength(before.sessions.length);
        expect(failed.designSessions).toHaveLength(before.designSessions.length);
        expect(failed.busy).toBe(false);
        const state = JSON.parse(await readFile(join(data, 'workspace.json'), 'utf8'));
        expect(state.workspaces[before.workspaceId].activeProblemId).toBe(before.activeProblemId);
        expect(state.workspaces[before.workspaceId].activeDesignSessionId).toBe(
          before.activeDesignSessionId,
        );
        if (mode === 'coding') {
          expect(failed.sessions[0].code).toBe('# Edit during attempt creation\n');
          expect(state.workspaces[before.workspaceId].sessions).toEqual(failed.sessions);
        } else {
          const saved = await page.evaluate(
            (id) => window.interview.loadDesignDraft(id),
            before.activeDesignSessionId!,
          );
          expect(saved.notes.requirements).toBe('Notes during attempt creation');
          expect(state.workspaces[before.workspaceId].designSessions).toEqual(
            failed.designSessions,
          );
        }
        if (phase === 'workspace') {
          await expect(errorText).toHaveText('Fixture attempt creation failure');
          await errorText.screenshot({ path: `test-results/creation-${mode}-error-text.png` });
          await page.screenshot({ path: `test-results/creation-${mode}-failure.png` });
        }
        await draft.restore();
        await write.restore();
        await create().click();
        await expect(create()).toBeEnabled();
        await expect
          .poll(async () => {
            const snapshot = await page.evaluate(() => window.interview.snapshot());
            return mode === 'coding' ? snapshot.sessions.length : snapshot.designSessions.length;
          })
          .toBe(2);
        if (mode === 'design') await expect(page.getByText(/Saved locally/)).toBeVisible();
        await app.close();
        app = await launch(data);
        page = await app.firstWindow();
        page.on('pageerror', (error) => errors.push(error.message));
        await expect(
          page.getByText(
            mode === 'coding' ? 'MCP connected · 5 problems' : 'MCP connected · 5 design briefs',
          ),
        ).toBeVisible({ timeout: 20_000 });
        const restored = await page.evaluate(() => window.interview.snapshot());
        if (mode === 'coding') {
          expect(restored.activeProblemId).toBe(target);
          expect(restored.sessions).toHaveLength(2);
          expect(restored.sessions[0].code).toBe('# Edit during attempt creation\n');
          await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
          await expect(page.locator('.view-lines')).toContainText('# Edit during attempt creation');
        } else {
          expect(restored.designSessions).toHaveLength(2);
          expect(restored.activeDesignSessionId).not.toBe(before.activeDesignSessionId);
          await page.locator('.design-attempts summary').click();
          await page.locator('.design-attempts button').last().click();
          await expect(
            page.getByRole('textbox', { name: 'Requirements', exact: true }),
          ).toHaveValue('Notes during attempt creation');
        }
        expect(errors).toEqual([]);
      } finally {
        await draft?.restore().catch(() => {});
        await write?.restore().catch(() => {});
        await app.close().catch(() => {});
      }
    });
  }
}
