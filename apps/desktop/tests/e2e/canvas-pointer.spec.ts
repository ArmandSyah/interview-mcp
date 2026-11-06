import { expect, test, type Page } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';
import { gateIpc } from './ipc-gate';
import type { DesignDraft } from '../../src/shared/design';

async function openDesign(page: Page) {
  await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'System design', exact: true }).click();
  await page
    .getByRole('button', { name: /Link Alias Service/ })
    .first()
    .click();
  await expect(page.locator('canvas.excalidraw__canvas.interactive')).toBeVisible();
}

async function savedScene(page: Page) {
  return page.evaluate(async () => {
    const snapshot = await window.interview.snapshot();
    return (await window.interview.loadDesignDraft(snapshot.activeDesignSessionId!)).scene;
  });
}

async function draw(page: Page, tool: string) {
  await page.getByTestId(`toolbar-${tool}`).locator('..').click();
  const box = (await page.locator('canvas.excalidraw__canvas.interactive').boundingBox())!;
  const start = { x: box.x + box.width * 0.6, y: box.y + box.height * 0.45 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 80, start.y + 60, { steps: 8 });
  await page.mouse.up();
  return start;
}

for (const tool of ['rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw']) {
  test(`pointer-created ${tool} survives immediate navigation and restart`, async () => {
    const data = await mkdtemp(join(tmpdir(), 'interview-canvas-pointer-'));
    let app = await launch(data);
    try {
      let page = await app.firstWindow();
      await openDesign(page);
      await draw(page, tool);
      // Navigate immediately after the pointer edit and verify the saved scene.
      await page.getByRole('button', { name: 'Coding', exact: true }).click();
      await expect(page.getByRole('heading', { name: /Your next interview/ })).toBeVisible();
      const before = (await savedScene(page)).elements.filter((element) => !element.isDeleted);
      expect(before, `draw(${tool}), then Coding: expected one saved shape`).toHaveLength(1);
      expect(before[0].type).toBe(tool);
      if (['arrow', 'line', 'freedraw'].includes(tool)) {
        const points = before[0].points as number[][];
        expect(points.length).toBeGreaterThanOrEqual(2);
        expect(points.every((point) => point.length === 2 && point.every(Number.isFinite))).toBe(
          true,
        );
      }
      expect(Number(before[0].width)).toBeGreaterThan(30);
      expect(Number(before[0].height)).toBeGreaterThan(30);
      await app.close();
      app = await launch(data);
      page = await app.firstWindow();
      await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
      await page.getByRole('button', { name: 'System design', exact: true }).click();
      await expect(page.locator('canvas.excalidraw__canvas.interactive')).toBeVisible();
      const after = (await savedScene(page)).elements.filter((element) => !element.isDeleted);
      expect(after).toEqual(before);
    } finally {
      await app.close().catch(() => {});
    }
  });
}

test('pointer movement, text editing, deletion and undo preserve saved canvas evidence', async () => {
  const data = await mkdtemp(join(tmpdir(), 'interview-canvas-edit-'));
  let app = await launch(data);
  try {
    let page = await app.firstWindow();
    await openDesign(page);
    const start = await draw(page, 'rectangle');
    await expect.poll(async () => (await savedScene(page)).elements.length).toBe(1);
    const original = (await savedScene(page)).elements[0];
    await page.getByTestId('toolbar-selection').locator('..').click();
    await page.mouse.move(start.x + 40, start.y + 30);
    await page.mouse.down();
    await page.mouse.move(start.x + 80, start.y + 70, { steps: 8 });
    await page.mouse.up();
    await expect
      .poll(async () => Number((await savedScene(page)).elements[0].x))
      .toBeGreaterThan(Number(original.x) + 20);
    await page.mouse.dblclick(start.x + 80, start.y + 70);
    const text = page.locator('textarea.excalidraw-wysiwyg');
    await expect(text).toBeVisible();
    await text.fill('API service');
    await text.press('Escape');
    await expect
      .poll(async () =>
        (await savedScene(page)).elements.some((element) => element.originalText === 'API service'),
      )
      .toBe(true);
    await page.getByTestId('toolbar-selection').locator('..').click();
    await page.mouse.click(start.x + 80, start.y + 70);
    await page.keyboard.press('Delete');
    await expect
      .poll(
        async () =>
          (await savedScene(page)).elements.filter((element) => !element.isDeleted).length,
      )
      .toBe(0);
    await page.getByTestId('design-canvas').getByTestId('button-undo').click();
    await page.getByRole('button', { name: 'Coding', exact: true }).click();
    await expect(page.getByRole('heading', { name: /Your next interview/ })).toBeVisible();
    const before = (await savedScene(page)).elements.filter((element) => !element.isDeleted);
    expect(before).toHaveLength(2);
    const shape = before.find((element) => element.type === 'rectangle')!;
    const label = before.find((element) => element.type === 'text')!;
    expect(label.originalText).toBe('API service');
    expect(String(label.text).replace(/\s+/g, ' ')).toBe('API service');
    expect(label.containerId).toBe(shape.id);
    expect(Number(shape.x)).toBeGreaterThan(Number(original.x) + 20);
    expect(Number(shape.y)).toBeGreaterThan(Number(original.y) + 20);
    await app.close();
    app = await launch(data);
    page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    expect((await savedScene(page)).elements.filter((element) => !element.isDeleted)).toEqual(
      before,
    );
  } finally {
    await app.close().catch(() => {});
  }
});

for (const exit of ['navigation', 'native close'] as const) {
  test(`canvas edits during an older save finish before ${exit}`, async () => {
    const data = await mkdtemp(join(tmpdir(), 'interview-canvas-save-race-'));
    let app = await launch(data);
    let gate: Awaited<ReturnType<typeof gateIpc>> | undefined;
    try {
      let page = await app.firstWindow();
      await openDesign(page);
      const start = await draw(page, 'rectangle');
      await expect.poll(async () => (await savedScene(page)).elements.length).toBe(1);
      await expect(page.getByText(/Saved locally/)).toBeVisible();
      const original = (await savedScene(page)).elements[0];
      gate = await gateIpc(app, 'design-save');
      await page.getByTestId('toolbar-selection').locator('..').click();
      await page.mouse.move(start.x + 40, start.y + 30);
      await page.mouse.down();
      await page.mouse.move(start.x + 80, start.y + 70, { steps: 8 });
      await page.mouse.up();
      await expect.poll(() => gate!.calls()).toHaveLength(1);
      await page.mouse.dblclick(start.x + 80, start.y + 70);
      const text = page.locator('textarea.excalidraw-wysiwyg');
      await expect(text).toBeVisible();
      await text.fill('Latest API');
      await text.press('Escape');
      if (exit === 'navigation') {
        await page.getByRole('button', { name: 'Coding', exact: true }).click();
      } else {
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
      }
      await gate.release(0);
      await expect.poll(() => gate!.calls()).toHaveLength(2);
      const latest = ((await gate.calls())[1][1] as DesignDraft).scene.elements.filter(
        (element) => !element.isDeleted,
      );
      const shape = latest.find((element) => element.type === 'rectangle')!;
      const label = latest.find((element) => element.type === 'text')!;
      expect(
        latest,
        'The second save must include the moved shape and newer bound text',
      ).toHaveLength(2);
      expect(shape.id).toBe(original.id);
      expect(Number(shape.x)).toBeGreaterThan(Number(original.x) + 20);
      expect(Number(shape.y)).toBeGreaterThan(Number(original.y) + 20);
      expect(label.originalText).toBe('Latest API');
      expect(label.containerId).toBe(shape.id);
      // Neither route may finish while the latest save is held.
      expect(page.isClosed()).toBe(false);
      await expect(page.getByRole('button', { name: 'Coding', exact: true })).toBeVisible();
      await gate.release(1);
      if (exit === 'navigation') {
        await expect(page.getByRole('heading', { name: /Your next interview/ })).toBeVisible();
        await gate.restore();
      } else {
        await expect.poll(() => page.isClosed()).toBe(true);
      }
      gate = undefined;
      await app.close();
      app = await launch(data);
      page = await app.firstWindow();
      await expect(page.getByText(/MCP connected · 5 (problems|design briefs)/)).toBeVisible({
        timeout: 20_000,
      });
      expect((await savedScene(page)).elements.filter((element) => !element.isDeleted)).toEqual(
        latest,
      );
    } finally {
      await gate?.restore().catch(() => {});
      await app.close().catch(() => {});
    }
  });
}
