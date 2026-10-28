import { expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';
import { accountServer, connectAccount, pasteAccountDraft } from './account-fixture';
import { gateIpc } from './ipc-gate';

type ExportDialog = Electron.Dialog & {
  solutionExportStory?: {
    original: Electron.Dialog['showSaveDialog'];
    calls: number;
    release?: (value: Electron.SaveDialogReturnValue) => void;
  };
};

async function holdExportDialog(app: ElectronApplication, filePath: string) {
  await app.evaluate(({ dialog }) => {
    const target = dialog as ExportDialog;
    target.solutionExportStory = { original: dialog.showSaveDialog, calls: 0 };
    dialog.showSaveDialog = (() => {
      target.solutionExportStory!.calls++;
      return new Promise<Electron.SaveDialogReturnValue>((done) => {
        target.solutionExportStory!.release = done;
      });
    }) as typeof dialog.showSaveDialog;
  });
  return {
    calls: () => app.evaluate(({ dialog }) => (dialog as ExportDialog).solutionExportStory!.calls),
    release: (canceled: boolean) =>
      app.evaluate(
        ({ dialog }, value) => {
          (dialog as ExportDialog).solutionExportStory!.release?.(value);
        },
        { canceled, filePath },
      ),
    restore: () =>
      app.evaluate(({ dialog }) => {
        const target = dialog as ExportDialog;
        const state = target.solutionExportStory;
        if (!state) return;
        dialog.showSaveDialog = state.original;
        state.release?.({ canceled: true, filePath: '' });
        delete target.solutionExportStory;
      }),
  };
}

for (const longName of [false, true]) {
  test(`solution export preserves drafts and cancellation with a long filename=${longName}`, async () => {
    const server = await accountServer();
    const data = await mkdtemp(join(tmpdir(), 'interview-export-ui-'));
    const app = await launch(data);
    const path = join(data, longName ? `${'e'.repeat(220)}.py` : 'export.py');
    await writeFile(path, '# Previous export\n');
    const dialog = await holdExportDialog(app, path);
    const save = await gateIpc(app, 'save');
    try {
      const page = await app.firstWindow();
      await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
      await connectAccount(page, server.url, 'fixture-alice');
      await page.getByRole('button', { name: /Account fixture/ }).click();
      const edit = pasteAccountDraft(page, '# Export captured draft\n');
      await expect.poll(save.calls).toHaveLength(1);
      await page
        .getByRole('button', { name: 'Export solution' })
        .evaluate((button: HTMLButtonElement) => {
          button.click();
          button.click();
        });
      expect(await dialog.calls(), 'Export must wait for the draft write').toBe(0);
      await save.release(0);
      await edit;
      await save.restore();
      await expect.poll(dialog.calls).toBe(1);
      await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'System design', exact: true })).toBeDisabled();
      await pasteAccountDraft(page, '# Edit after export starts\n');
      await dialog.release(false);
      await expect(page.getByRole('button', { name: 'Export solution' })).toBeEnabled();
      expect(await readFile(path, 'utf8')).toBe('# Export captured draft\n');
      expect((await page.evaluate(() => window.interview.snapshot())).sessions[0].code).toBe(
        '# Edit after export starts\n',
      );
      await page.getByRole('button', { name: 'Export solution' }).click();
      await expect.poll(dialog.calls).toBe(2);
      await dialog.release(true);
      await expect(page.getByRole('button', { name: 'Export solution' })).toBeEnabled();
      expect(await readFile(path, 'utf8')).toBe('# Export captured draft\n');
      await page.getByRole('button', { name: 'Export solution' }).click();
      await expect.poll(dialog.calls).toBe(3);
      await dialog.release(false);
      await expect(page.getByRole('button', { name: 'Export solution' })).toBeEnabled();
      expect(await readFile(path, 'utf8')).toBe('# Edit after export starts\n');
    } finally {
      await save.restore().catch(() => {});
      await dialog.restore().catch(() => {});
      await app.close().catch(() => {});
      await server.close();
    }
  });
}

for (const kind of ['solution', 'design', 'backup'] as const) {
  test(`a ${kind} export write failure preserves an existing file and permits retry`, async () => {
    const server = await accountServer();
    const data = await mkdtemp(join(tmpdir(), 'interview-export-failure-'));
    const app = await launch(data);
    const path = join(data, 'export.py');
    await writeFile(path, '# Existing export\n');
    const dialog = await holdExportDialog(app, path);
    try {
      const page = await app.firstWindow();
      await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
      if (kind === 'solution') {
        await connectAccount(page, server.url, 'fixture-alice');
        await page.getByRole('button', { name: /Account fixture/ }).click();
      } else {
        await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
      }
      await pasteAccountDraft(page, '# Replacement export\n');
      if (kind === 'design') {
        await page.getByRole('button', { name: 'System design', exact: true }).click();
        await page
          .getByRole('button', { name: /Link Alias Service/ })
          .first()
          .click();
        await page
          .getByLabel('Requirements', { exact: true })
          .fill('Preserve design export notes.');
      }
      if (kind === 'backup') await page.getByRole('button', { name: 'Open settings' }).click();
      const exportAction = () =>
        kind === 'design'
          ? page.getByLabel('Export design').selectOption('workspace')
          : page
              .getByRole('button', {
                name: kind === 'backup' ? 'Export practice backup' : 'Export solution',
              })
              .click();
      await app.evaluate(async (_electron, path) => {
        const fs = process.getBuiltinModule('node:fs/promises');
        const originalWrite = fs.writeFile;
        const originalOpen = fs.open;
        const state = globalThis as typeof globalThis & { restoreExportWrite?: () => void };
        state.restoreExportWrite = () => {
          fs.writeFile = originalWrite;
          fs.open = originalOpen;
        };
        fs.writeFile = (async (target: Parameters<typeof fs.writeFile>[0], ...args: unknown[]) => {
          if (String(target) === path) {
            await originalWrite(target, '# Partial data');
            throw new Error('Fixture export write failure');
          }
          return Reflect.apply(originalWrite, fs, [target, ...args]);
        }) as typeof fs.writeFile;
        fs.open = (async (target: Parameters<typeof fs.open>[0], ...args: unknown[]) => {
          const file = await Reflect.apply(originalOpen, fs, [target, ...args]);
          if (String(target).includes('.interview-export-') && String(target).endsWith('.tmp')) {
            const original = file.writeFile.bind(file);
            file.writeFile = async () => {
              await original('# Partial data');
              throw new Error('Fixture export write failure');
            };
          }
          return file;
        }) as typeof fs.open;
      }, path);
      await exportAction();
      await expect.poll(dialog.calls).toBe(1);
      await dialog.release(false);
      await expect(
        page
          .getByRole(kind === 'backup' ? 'status' : 'alert')
          .filter({ hasText: 'Fixture export write failure' }),
      ).toBeVisible();
      expect(
        await readFile(path, 'utf8'),
        'A failed export must keep the previous file bytes',
      ).toBe('# Existing export\n');
      expect(
        (await readdir(data)).filter(
          (name) => name.startsWith('.interview-export-') && name.endsWith('.tmp'),
        ),
      ).toEqual([]);
      expect((await page.evaluate(() => window.interview.snapshot())).sessions[0].code).toBe(
        '# Replacement export\n',
      );
      await app.evaluate(() =>
        (
          globalThis as typeof globalThis & { restoreExportWrite?: () => void }
        ).restoreExportWrite?.(),
      );
      await exportAction();
      await expect.poll(dialog.calls).toBe(2);
      await dialog.release(false);
      await expect.poll(async () => readFile(path, 'utf8')).not.toBe('# Existing export\n');
      const contents = await readFile(path, 'utf8');
      if (kind === 'solution') expect(contents).toBe('# Replacement export\n');
      else if (kind === 'design')
        expect(JSON.parse(contents).draft.notes.requirements).toBe('Preserve design export notes.');
      else {
        const backup = JSON.parse(contents);
        expect(backup).toBeTruthy();
        expect(contents).toContain('# Replacement export');
      }
      await expect(
        page
          .getByRole(kind === 'backup' ? 'status' : 'alert')
          .filter({ hasText: 'Fixture export write failure' }),
      ).toHaveCount(0);
    } finally {
      await app
        .evaluate(() =>
          (
            globalThis as typeof globalThis & { restoreExportWrite?: () => void }
          ).restoreExportWrite?.(),
        )
        .catch(() => {});
      await dialog.restore().catch(() => {});
      await app.close().catch(() => {});
      await server.close();
    }
  });
}
