import { expect, test, type Page } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from '../e2e/desktop';
import { recordJourney } from './recorder';

async function savedScene(page: Page) {
  return page.evaluate(async () => {
    const state = await window.interview.snapshot();
    return (await window.interview.loadDesignDraft(state.activeDesignSessionId!)).scene;
  });
}

async function liveElements(page: Page) {
  return (await savedScene(page)).elements.filter((element) => !element.isDeleted);
}

function withoutActiveStroke(elements: Record<string, unknown>[]) {
  // Excalidraw resets this pointer field on restore. The saved points define the visible stroke.
  return elements.map(({ lastCommittedPoint: _lastCommittedPoint, ...element }) => element);
}

test('whiteboard pointer tools, labels, undo, zoom, clear, and restart', async () => {
  const data = await mkdtemp(join(tmpdir(), 'interview-visual-whiteboard-'));
  let app = await launch(data);
  try {
    let page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    let start = { x: 0, y: 0 };
    let rectangleId = '';
    let rectangleX = 0;
    const notes = 'Keep the notes when the diagram changes.';
    await recordJourney(
      page,
      'whiteboard-tools',
      'AI off. Real pointer edits and local canvas saves.',
      async (step) => {
        await step(
          'Open a blank whiteboard',
          'The design brief opens with an empty canvas.',
          async () => {
            await page.getByRole('button', { name: 'System design', exact: true }).click();
            await page
              .getByRole('button', { name: /Link Alias Service/ })
              .first()
              .click();
            await expect(page.locator('canvas.excalidraw__canvas.interactive')).toBeVisible();
            expect(await liveElements(page)).toEqual([]);
          },
        );
        const tools = ['rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw'];
        for (const [index, tool] of tools.entries()) {
          await step(
            `Draw a ${tool === 'freedraw' ? 'freehand stroke' : tool}`,
            'The local scene saves the shape made with the pointer.',
            async () => {
              await page.getByTestId(`toolbar-${tool}`).locator('..').click();
              const box = (await page
                .locator('canvas.excalidraw__canvas.interactive')
                .boundingBox())!;
              const point = {
                x: box.x + box.width * (0.4 + (index % 3) * 0.18),
                y: box.y + box.height * (index < 3 ? 0.3 : 0.58),
              };
              await page.mouse.move(point.x, point.y);
              await page.mouse.down();
              // Separate pointer moves make the drawing action visible in the GIF.
              for (let part = 1; part <= 8; part++) {
                await page.mouse.move(point.x + part * 10, point.y + part * 7.5);
                await page.waitForTimeout(90);
              }
              await page.mouse.up();
              await expect.poll(async () => (await liveElements(page)).length).toBe(index + 1);
              const shape = (await liveElements(page)).find((element) => element.type === tool)!;
              expect(shape).toBeDefined();
              expect(Number(shape.width)).toBeGreaterThan(30);
              expect(Number(shape.height)).toBeGreaterThan(30);
              if (index === 0) {
                start = point;
                rectangleId = String(shape.id);
                rectangleX = Number(shape.x);
              }
            },
          );
        }
        await step(
          'Move the rectangle',
          'The same rectangle moves right and retains its identity.',
          async () => {
            await page.getByTestId('toolbar-selection').locator('..').click();
            // An unfilled shape is selected at its outline, not its empty center.
            await page.mouse.click(start.x, start.y + 30);
            await page.mouse.move(start.x + 40, start.y + 30);
            await page.mouse.down();
            for (let part = 1; part <= 8; part++) {
              await page.mouse.move(start.x + 40 + part * 5, start.y + 30 + part * 5);
              await page.waitForTimeout(90);
            }
            await page.mouse.up();
            await expect
              .poll(async () =>
                Number((await liveElements(page)).find((element) => element.id === rectangleId)!.x),
              )
              .toBeGreaterThan(rectangleX + 20);
          },
        );
        await step(
          'Add a label inside the rectangle',
          'The saved label belongs to the rectangle.',
          async () => {
            await page.mouse.dblclick(start.x + 80, start.y + 70);
            const editor = page.locator('textarea.excalidraw-wysiwyg');
            await expect(editor).toBeVisible();
            await editor.pressSequentially('API service', { delay: 100 });
            await editor.press('Escape');
            await expect
              .poll(
                async () =>
                  (await liveElements(page)).find(
                    (element) => element.originalText === 'API service',
                  )?.containerId,
              )
              .toBe(rectangleId);
          },
        );
        await step(
          'Delete the labeled rectangle',
          'The rectangle and its label leave the active scene together.',
          async () => {
            await page.getByTestId('toolbar-selection').locator('..').click();
            await page.mouse.click(start.x + 80, start.y + 70);
            await page.keyboard.press('Delete');
            await expect.poll(async () => (await liveElements(page)).length).toBe(5);
            expect(
              (await liveElements(page)).some(
                (element) => element.id === rectangleId || element.containerId === rectangleId,
              ),
            ).toBe(false);
          },
        );
        await step(
          'Undo the deletion',
          'Undo restores the rectangle and its bound label.',
          async () => {
            await page.getByTestId('design-canvas').getByTestId('button-undo').click();
            await expect.poll(async () => (await liveElements(page)).length).toBe(7);
            expect(
              (await liveElements(page)).find((element) => element.originalText === 'API service')
                ?.containerId,
            ).toBe(rectangleId);
          },
        );
        await step('Redo the deletion', 'Redo removes the same two elements again.', async () => {
          await page.getByTestId('design-canvas').getByTestId('button-redo').click();
          await expect.poll(async () => (await liveElements(page)).length).toBe(5);
        });
        await step(
          'Restore the labeled rectangle',
          'Undo returns all seven active elements.',
          async () => {
            await page.getByTestId('design-canvas').getByTestId('button-undo').click();
            await expect.poll(async () => (await liveElements(page)).length).toBe(7);
          },
        );
        await step(
          'Zoom in',
          'The saved view zoom increases without changing the elements.',
          async () => {
            await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
            await expect
              .poll(async () => ((await savedScene(page)).appState.zoom as { value: number }).value)
              .toBeGreaterThan(1);
            expect(await liveElements(page)).toHaveLength(7);
          },
        );
        await step('Zoom out', 'The saved view returns to its original scale.', async () => {
          await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
          await expect
            .poll(async () => ((await savedScene(page)).appState.zoom as { value: number }).value)
            .toBe(1);
        });
        await step('Reset the zoom', 'Reset zoom restores a 100 percent view.', async () => {
          await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
          await expect
            .poll(async () => ((await savedScene(page)).appState.zoom as { value: number }).value)
            .toBeLessThan(1);
          await page.getByRole('button', { name: 'Reset zoom', exact: true }).click();
          await expect
            .poll(async () => ((await savedScene(page)).appState.zoom as { value: number }).value)
            .toBe(1);
        });
        await step(
          'Save notes beside the diagram',
          'The notes are saved separately from the canvas elements.',
          async () => {
            await page
              .getByLabel('Requirements', { exact: true })
              .pressSequentially(notes, { delay: 65 });
            await expect(page.getByText(/Saved locally/)).toBeVisible();
          },
        );
        await step(
          'Inspect the Clear canvas confirmation',
          'Clear canvas requires a choice before removing the diagram.',
          async () => {
            await page.getByTestId('main-menu-trigger').click();
            await page.getByTestId('clear-canvas-button').click();
            await expect(
              page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }),
            ).toBeVisible();
            expect(await liveElements(page)).toHaveLength(7);
          },
        );
        await step(
          'Cancel Clear canvas',
          'All seven elements remain after cancellation.',
          async () => {
            await page
              .getByRole('dialog')
              .getByRole('button', { name: 'Cancel', exact: true })
              .click();
            await expect(
              page.getByRole('dialog').filter({
                has: page.getByRole('button', { name: 'Confirm', exact: true }),
              }),
            ).toBeHidden();
            expect(await liveElements(page)).toHaveLength(7);
          },
        );
        await step(
          'Confirm Clear canvas',
          'The canvas becomes empty and the notes remain.',
          async () => {
            await page.getByTestId('main-menu-trigger').click();
            await page.getByTestId('clear-canvas-button').click();
            await page
              .getByRole('dialog')
              .getByRole('button', { name: 'Confirm', exact: true })
              .click();
            await expect.poll(() => liveElements(page)).toEqual([]);
            await expect(page.getByLabel('Requirements', { exact: true })).toHaveValue(notes);
          },
        );
        await step(
          'Undo Clear canvas',
          'The complete diagram returns beside the unchanged notes.',
          async () => {
            await page.getByTestId('design-canvas').getByTestId('button-undo').click();
            await expect.poll(async () => (await liveElements(page)).length).toBe(7);
            await expect(page.getByLabel('Requirements', { exact: true })).toHaveValue(notes);
          },
        );
        await step(
          'Save a design checkpoint',
          'The real backend stores a checkpoint of the diagram and notes.',
          async () => {
            await page.getByRole('button', { name: 'Checkpoint', exact: true }).click();
            await expect
              .poll(
                async () =>
                  (await page.evaluate(() => window.interview.snapshot())).designSessions[0]
                    .latestCheckpointId,
              )
              .toBeTruthy();
            await expect(
              page.getByRole('button', { name: 'Checkpoint', exact: true }),
            ).toBeEnabled();
          },
        );
      },
    );
    const before = withoutActiveStroke(await liveElements(page));
    await app.close();
    app = await launch(data);
    page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 design briefs')).toBeVisible({
      timeout: 20_000,
    });
    await recordJourney(
      page,
      'whiteboard-restart',
      'Real app restart. Same saved diagram and notes.',
      async (step) => {
        await step(
          'Inspect the restored diagram',
          'All elements, labels, positions, and notes survive restart.',
          async () => {
            await expect(page.locator('canvas.excalidraw__canvas.interactive')).toBeVisible();
            expect(withoutActiveStroke(await liveElements(page))).toEqual(before);
            await expect(page.getByLabel('Requirements', { exact: true })).toHaveValue(notes);
          },
        );
        await step(
          'Inspect checkpoint history',
          'The saved checkpoint remains available after restart.',
          async () => {
            await page.getByRole('button', { name: 'History', exact: true }).click();
            await expect(
              page.getByRole('dialog', { name: 'Design checkpoint history' }),
            ).toBeVisible();
            await expect(page.getByRole('button', { name: 'Restore', exact: true })).toBeVisible();
          },
        );
      },
    );
  } finally {
    await app.close().catch(() => {});
  }
});
