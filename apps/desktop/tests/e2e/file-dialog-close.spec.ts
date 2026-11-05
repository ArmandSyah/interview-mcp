import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../../src/main/storage';
import { launch } from './desktop';
import { pasteAccountDraft } from './account-fixture';
import { contentFixture } from './content-fixture';

type DialogFixture = {
  calls: number;
  release?: () => void;
};
type FixtureHost = typeof globalThis & { fileDialogFixture: DialogFixture };

for (const kind of ['solution', 'design', 'backup', 'corpus', 'pack'] as const) {
  for (const lateSelection of [false, true]) {
    test(`native close cancels ${kind} selection, late response=${lateSelection}`, async () => {
      test.skip(
        kind === 'pack' && !!process.env.INTERVIEW_DESKTOP_EXECUTABLE,
        'The signed pack fixture requires the source bundle.',
      );
      const data = await mkdtemp(join(tmpdir(), 'interview-file-dialog-close-'));
      const destination = join(data, 'existing-export.json');
      await writeFile(destination, 'Keep the existing export.\n');
      const fixture = kind === 'pack' ? await contentFixture(data) : undefined;
      const app = await launch(data, '', fixture?.entry);
      try {
        const page = await app.firstWindow();
        await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
        await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
        const code = '# Keep this draft when the file dialog closes.\n';
        await pasteAccountDraft(page, code);
        if (kind === 'design') {
          await page.getByRole('button', { name: 'System design', exact: true }).click();
          await page
            .getByRole('button', { name: /Link Alias Service/ })
            .first()
            .click();
          await page.getByLabel('Requirements', { exact: true }).fill('Keep these design notes.');
        }
        if (kind === 'backup' || kind === 'corpus' || kind === 'pack')
          await page.getByRole('button', { name: 'Open settings' }).click();
        const before = await page.evaluate(() => window.interview.snapshot());
        await app.evaluate(
          ({ dialog }, { destination, paths }) => {
            const state: DialogFixture = ((globalThis as FixtureHost).fileDialogFixture = {
              calls: 0,
            });
            dialog.showSaveDialog = (() => {
              state.calls++;
              return new Promise<Electron.SaveDialogReturnValue>((resolve) => {
                state.release = () => resolve({ canceled: false, filePath: destination });
              });
            }) as typeof dialog.showSaveDialog;
            dialog.showOpenDialog = (() => {
              state.calls++;
              return new Promise<Electron.OpenDialogReturnValue>((resolve) => {
                state.release = () => resolve({ canceled: false, filePaths: paths });
              });
            }) as typeof dialog.showOpenDialog;
          },
          { destination, paths: fixture ? [fixture.pack, fixture.claims] : [destination] },
        );
        if (kind === 'design') await page.getByLabel('Export design').selectOption('workspace');
        else
          await page
            .getByRole('button', {
              name:
                kind === 'backup'
                  ? 'Export practice backup'
                  : kind === 'pack'
                    ? 'Install pack & license'
                    : kind === 'corpus'
                      ? 'Browse'
                      : 'Export solution',
              exact: true,
            })
            .click();
        await expect
          .poll(() => app.evaluate(() => (globalThis as FixtureHost).fileDialogFixture.calls))
          .toBe(1);
        let closed = false;
        app.on('close', () => {
          closed = true;
        });
        await app.evaluate(({ BrowserWindow }, lateSelection) => {
          BrowserWindow.getAllWindows()[0]!.close();
          if (lateSelection) (globalThis as FixtureHost).fileDialogFixture.release!();
        }, lateSelection);
        await expect
          .poll(() => closed, {
            timeout: 5000,
            message: `${kind}: close must settle without a file selection`,
          })
          .toBe(true);
        expect(
          await readFile(destination, 'utf8'),
          `${kind}: cancelled selection must not replace a file`,
        ).toBe('Keep the existing export.\n');
        const saved = new LocalStore(data);
        await saved.load();
        const sessions = Object.values(saved.state.workspaces).flatMap(
          (workspace) => workspace.sessions,
        );
        expect(
          sessions.find((session) => session.problem.id === before.activeProblemId)?.code,
        ).toBe(code);
        expect(saved.state.settings.corpusPath).toBe(before.settings.corpusPath);
        if (kind === 'design') {
          const drafts = Object.values(saved.state.workspaces).flatMap(
            (workspace) => workspace.designSessions,
          );
          expect(drafts.map((session) => session.id)).toContain(before.activeDesignSessionId);
          const draft = JSON.parse(
            await readFile(
              join(data, 'design', before.workspaceId, before.activeDesignSessionId!, 'draft.json'),
              'utf8',
            ),
          );
          expect(draft.notes.requirements).toBe('Keep these design notes.');
        }
        if (fixture) {
          const reopened = await launch(data, '', fixture.entry);
          try {
            const restored = await reopened.firstWindow();
            await expect(restored.getByText('MCP connected · 5 problems')).toBeVisible({
              timeout: 20_000,
            });
            const snapshot = await restored.evaluate(() => window.interview.snapshot());
            expect(snapshot.installedPacks).toEqual(before.installedPacks);
            expect(snapshot.problems).toEqual(before.problems);
            expect(snapshot.designProblems).toEqual(before.designProblems);
          } finally {
            await reopened.close();
          }
        }
      } finally {
        await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
        await app.close().catch(() => {});
      }
    });
  }
}
