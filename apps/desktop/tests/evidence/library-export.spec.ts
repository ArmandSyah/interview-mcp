import { expect, test, type Page } from '@playwright/test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from '../e2e/desktop';
import { recordJourney } from './recorder';

async function library(page: Page) {
  return page.evaluate(async () =>
    window.interview.loadDesignLibrary((await window.interview.snapshot()).workspaceId),
  );
}
async function elements(page: Page) {
  return page.evaluate(async () => {
    const state = await window.interview.snapshot();
    return (
      await window.interview.loadDesignDraft(state.activeDesignSessionId!)
    ).scene.elements.filter((element) => !element.isDeleted);
  });
}
async function closeLibrary(page: Page) {
  const close = page.locator('.sidebar').getByRole('button', { name: 'Close', exact: true });
  if (await close.isVisible()) await close.click();
}

test('reusable library items, design exports, restart, and library reset', async () => {
  const data = await mkdtemp(join(tmpdir(), 'interview-visual-library-'));
  let app = await launch(data);
  const paths = {
    json: join(data, 'design.json'),
    excalidraw: join(data, 'design.excalidraw'),
    png: join(data, 'design.png'),
  };
  try {
    let page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await app.evaluate(({ dialog }, outputs) => {
      dialog.showSaveDialog = (async (...args: unknown[]) => {
        const options = args.at(-1) as { defaultPath: string };
        const extension = options.defaultPath.split('.').at(-1) as keyof typeof outputs;
        return { canceled: false, filePath: outputs[extension] };
      }) as typeof dialog.showSaveDialog;
    }, paths);
    await recordJourney(
      page,
      'library-and-export',
      'Real local data and exports. Native save dialogs use test paths.',
      async (step) => {
        await step(
          'Open a design workspace',
          'The new design starts with an empty canvas and library.',
          async () => {
            await page.getByRole('button', { name: 'System design', exact: true }).click();
            await page
              .getByRole('button', { name: /Link Alias Service/ })
              .first()
              .click();
            await expect(page.locator('canvas.excalidraw__canvas.interactive')).toBeVisible();
            expect(await library(page)).toEqual([]);
          },
        );
        for (const component of ['Service', 'Cache']) {
          await step(
            `Add a ${component.toLowerCase()} component`,
            'The canvas saves the component and its label.',
            async () => {
              await page.getByRole('button', { name: `+ ${component}`, exact: true }).click();
              await expect
                .poll(async () => (await elements(page)).length)
                .toBe(component === 'Service' ? 2 : 4);
            },
          );
        }
        await step(
          'Select the diagram and open Library',
          'The Library offers the selected components as a new item.',
          async () => {
            await page
              .locator('canvas.excalidraw__canvas.interactive')
              .click({ position: { x: 450, y: 300 } });
            await page.keyboard.press('Control+a');
            await page.locator('.default-sidebar-trigger').click();
            await expect(page.locator('.library-unit__pulse')).toHaveCount(1);
          },
        );
        await step(
          'Add the selection to Personal Library',
          'The saved library item contains both components and their labels.',
          async () => {
            await page.locator('.library-unit__pulse').click();
            await expect(page.locator('.library-unit__pulse')).toHaveCount(0);
            await expect.poll(() => library(page)).toHaveLength(1);
            expect((await library(page))[0].elements).toHaveLength(4);
          },
        );
        await step(
          'Return to coding practice',
          'The library save finishes before the mode change.',
          async () => {
            await closeLibrary(page);
            await page.getByRole('button', { name: 'Coding', exact: true }).click();
            await expect(page.getByRole('heading', { name: /Your next interview/ })).toBeVisible();
            expect(await library(page)).toHaveLength(1);
          },
        );
        await step(
          'Return to system design',
          'The original diagram remains available.',
          async () => {
            await page.getByRole('button', { name: 'System design', exact: true }).click();
            await expect(page.locator('canvas.excalidraw__canvas.interactive')).toBeVisible();
            expect(await elements(page)).toHaveLength(4);
          },
        );
        await step(
          'Start a new design attempt',
          'The new attempt has a blank canvas and keeps the workspace library.',
          async () => {
            await page.getByRole('button', { name: 'New attempt', exact: true }).click();
            await expect
              .poll(
                async () =>
                  (await page.evaluate(() => window.interview.snapshot())).designSessions.length,
              )
              .toBe(2);
            await expect(page.locator('canvas.excalidraw__canvas.interactive')).toBeVisible();
            expect(await elements(page)).toEqual([]);
            expect(await library(page)).toHaveLength(1);
          },
        );
        await step(
          'Open the saved library item',
          'The saved Service and Cache item is available in the new attempt.',
          async () => {
            await page.locator('.default-sidebar-trigger').click();
            await expect(page.locator('.library-unit__active')).toHaveCount(1);
            await expect(page.locator('.library-unit__active')).toContainText('Service');
            await expect(page.locator('.library-unit__active')).toContainText('Cache');
          },
        );
        await step(
          'Insert the reusable diagram',
          'The new canvas receives independent copies of the saved elements.',
          async () => {
            await page.locator('.library-unit__active .library-unit__dragger').click();
            await expect.poll(async () => (await elements(page)).length).toBe(4);
            const copied = await elements(page);
            const stored = (await library(page))[0].elements;
            expect(
              copied.every((element) => stored.every((saved) => saved.id !== element.id)),
            ).toBe(true);
            for (const label of copied.filter((element) => element.type === 'text'))
              expect(copied.some((element) => element.id === label.containerId)).toBe(true);
            await closeLibrary(page);
          },
        );
        await step(
          'Export the design workspace',
          'The real JSON export contains the four copied elements and current notes.',
          async () => {
            await page
              .getByLabel('Requirements', { exact: true })
              .pressSequentially('Explain when cached data becomes stale.', { delay: 60 });
            await page.getByLabel('Export design').selectOption('workspace');
            await expect
              .poll(async () => {
                try {
                  return JSON.parse(await readFile(paths.json, 'utf8')).draft.notes.requirements;
                } catch {
                  return '';
                }
              })
              .toBe('Explain when cached data becomes stale.');
            expect(
              JSON.parse(await readFile(paths.json, 'utf8')).draft.scene.elements.filter(
                (element: { isDeleted?: boolean }) => !element.isDeleted,
              ),
            ).toHaveLength(4);
          },
        );
        await step(
          'Export an Excalidraw file',
          'The real scene export preserves the diagram elements.',
          async () => {
            await page.getByLabel('Export design').selectOption('excalidraw');
            await expect
              .poll(async () => {
                try {
                  return JSON.parse(await readFile(paths.excalidraw, 'utf8')).type;
                } catch {
                  return '';
                }
              })
              .toBe('excalidraw');
            expect(
              JSON.parse(await readFile(paths.excalidraw, 'utf8')).elements.filter(
                (element: { isDeleted?: boolean }) => !element.isDeleted,
              ),
            ).toHaveLength(4);
          },
        );
        await step(
          'Export a PNG image',
          'The export writes a real image of the diagram.',
          async () => {
            await page.getByLabel('Export design').selectOption('png');
            await expect
              .poll(async () => {
                try {
                  return (await readFile(paths.png)).subarray(0, 8).toString('hex');
                } catch {
                  return '';
                }
              })
              .toBe('89504e470d0a1a0a');
            const size = await app.evaluate(
              ({ nativeImage }, path) => nativeImage.createFromPath(path).getSize(),
              paths.png,
            );
            expect(size.width).toBeGreaterThan(100);
            expect(size.height).toBeGreaterThan(40);
            await test
              .info()
              .attach('Exported reusable diagram', { path: paths.png, contentType: 'image/png' });
          },
        );
        await step(
          'Cancel an export',
          'Cancellation preserves an existing file and keeps the canvas usable.',
          async () => {
            const sentinel = join(data, 'cancelled.json');
            await writeFile(sentinel, 'Keep the existing export.');
            await app.evaluate(({ dialog }, path) => {
              dialog.showSaveDialog = async () => ({ canceled: true, filePath: path });
            }, sentinel);
            await page.getByLabel('Export design').selectOption('workspace');
            await expect(page.getByLabel('Export design')).toBeEnabled();
            expect(await readFile(sentinel, 'utf8')).toBe('Keep the existing export.');
            expect(await elements(page)).toHaveLength(4);
          },
        );
      },
    );
    await app.close();
    app = await launch(data);
    page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 design briefs')).toBeVisible({
      timeout: 20_000,
    });
    await recordJourney(
      page,
      'library-restart-and-reset',
      'Real app restart and saved Personal Library. AI off.',
      async (step) => {
        await step(
          'Inspect Personal Library after restart',
          'The reusable item and inserted diagram both survive restart.',
          async () => {
            await page.locator('.default-sidebar-trigger').click();
            await expect(page.locator('.library-unit__active')).toHaveCount(1);
            expect(await library(page)).toHaveLength(1);
            expect(await elements(page)).toHaveLength(4);
          },
        );
        await step(
          'Inspect Library options',
          'The library menu offers import, export, and reset.',
          async () => {
            await page.locator('.library-menu-dropdown-container button').first().click();
            await expect(page.getByTestId('lib-dropdown--load')).toBeVisible();
            await expect(page.getByTestId('lib-dropdown--export')).toBeVisible();
            await expect(
              page.getByRole('button', { name: 'Reset library', exact: true }),
            ).toBeVisible();
          },
        );
        await step(
          'Cancel a library reset',
          'Cancellation keeps the saved reusable item.',
          async () => {
            await page.getByRole('button', { name: 'Reset library', exact: true }).click();
            await page
              .getByRole('dialog')
              .getByRole('button', { name: 'Cancel', exact: true })
              .click();
            expect(await library(page)).toHaveLength(1);
            await expect(page.locator('.library-unit__active')).toHaveCount(1);
          },
        );
        await step(
          'Reset Personal Library',
          'The library becomes empty while the inserted diagram remains intact.',
          async () => {
            await page.locator('.library-menu-dropdown-container button').first().click();
            await page.getByRole('button', { name: 'Reset library', exact: true }).click();
            await page
              .getByRole('dialog')
              .getByRole('button', { name: 'Confirm', exact: true })
              .click();
            await expect.poll(() => library(page)).toEqual([]);
            await expect(page.locator('.library-unit__active')).toHaveCount(0);
            expect(await elements(page)).toHaveLength(4);
          },
        );
      },
    );
  } finally {
    await app.close().catch(() => {});
  }
});
