import { expect, test, type Page } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';
import { gateIpc } from './ipc-gate';

async function openDesign(page: Page) {
  await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'System design', exact: true }).click();
  await page
    .getByRole('button', { name: /Link Alias Service/ })
    .first()
    .click();
  await expect(page.locator('canvas.excalidraw__canvas.interactive')).toBeVisible();
}

async function addServiceToLibrary(page: Page) {
  await page.getByRole('button', { name: '+ Service', exact: true }).click();
  await page
    .locator('canvas.excalidraw__canvas.interactive')
    .click({ position: { x: 450, y: 300 } });
  await page.keyboard.press('Control+a');
  await page.locator('.default-sidebar-trigger').click();
  await expect(page.locator('.library-unit__pulse')).toHaveCount(1);
  await page.locator('.library-unit__pulse').click();
  await expect(page.locator('.library-unit__pulse')).toHaveCount(0);
  await expect(page.locator('.library-unit__active')).toHaveCount(1);
}

test('Personal Library retains a saved component through mode changes and restart', async () => {
  const data = await mkdtemp(join(tmpdir(), 'interview-library-restart-'));
  let app = await launch(data);
  try {
    let page = await app.firstWindow();
    await openDesign(page);
    await addServiceToLibrary(page);
    await page.locator('.sidebar').getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Coding', exact: true }).click();
    await page.getByRole('button', { name: 'System design', exact: true }).click();
    const saved = await page.evaluate(async () => {
      const state = await window.interview.snapshot();
      return window.interview.loadDesignLibrary(state.workspaceId);
    });
    expect(saved).toHaveLength(1);
    await page.locator('.default-sidebar-trigger').click();
    await expect(
      page.locator('.library-unit__active'),
      'Add Service to Personal Library, switch to Coding, then return: expected the saved library item',
    ).toHaveCount(1);
    await page.locator('.sidebar').getByRole('button', { name: 'Close', exact: true }).click();
    await app.close();
    app = await launch(data);
    page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 design briefs')).toBeVisible({
      timeout: 20_000,
    });
    await page.locator('.default-sidebar-trigger').click();
    await expect(
      page.locator('.library-unit__active'),
      'Restart after saving the library: expected one reusable Service item',
    ).toHaveCount(1);
    await expect(page.locator('.library-unit__active')).toContainText('Service');
  } finally {
    await app.close().catch(() => {});
  }
});

test('a failed library save blocks navigation and preserves the pending item for retry', async () => {
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-library-save-failure-')));
  let gate: Awaited<ReturnType<typeof gateIpc>> | undefined;
  try {
    const page = await app.firstWindow();
    await openDesign(page);
    gate = await gateIpc(app, 'design-library-save');
    await addServiceToLibrary(page);
    await expect.poll(() => gate!.calls()).toHaveLength(1);
    await page.getByLabel('Requirements', { exact: true }).fill('Keep draft saves independent.');
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const state = await window.interview.snapshot();
          return (await window.interview.loadDesignDraft(state.activeDesignSessionId!)).notes
            .requirements;
        }),
      )
      .toBe('Keep draft saves independent.');
    await page.getByRole('button', { name: 'Coding', exact: true }).click();
    expect((await page.evaluate(() => window.interview.snapshot())).mode).toBe('design');
    await gate.release(0, 'Fixture library save failure');
    await expect(page.getByText(/Fixture library save failure/).first()).toBeVisible();
    expect((await page.evaluate(() => window.interview.snapshot())).mode).toBe('design');
    const stored = await page.evaluate(async () =>
      window.interview.loadDesignLibrary((await window.interview.snapshot()).workspaceId),
    );
    expect(stored).toEqual([]);
    await gate.restore();
    gate = undefined;
    await page.getByRole('button', { name: 'Coding', exact: true }).click();
    await expect(page.getByRole('heading', { name: /Your next interview/ })).toBeVisible();
    await page.getByRole('button', { name: 'System design', exact: true }).click();
    await page.locator('.default-sidebar-trigger').click();
    await expect(page.locator('.library-unit__active')).toHaveCount(1);
    expect(
      await page.evaluate(async () =>
        window.interview.loadDesignLibrary((await window.interview.snapshot()).workspaceId),
      ),
    ).toHaveLength(1);
  } finally {
    await gate?.restore().catch(() => {});
    await app.close().catch(() => {});
  }
});

test('native close waits for the latest library edit while an older save is pending', async () => {
  const data = await mkdtemp(join(tmpdir(), 'interview-library-close-'));
  let app = await launch(data);
  let gate: Awaited<ReturnType<typeof gateIpc>> | undefined;
  try {
    let page = await app.firstWindow();
    await openDesign(page);
    gate = await gateIpc(app, 'design-library-save');
    await addServiceToLibrary(page);
    await expect.poll(() => gate!.calls()).toHaveLength(1);
    await page.locator('.sidebar').getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: '+ Cache', exact: true }).click();
    await page
      .locator('canvas.excalidraw__canvas.interactive')
      .click({ position: { x: 450, y: 300 } });
    await page.keyboard.press('Control+a');
    await page.locator('.default-sidebar-trigger').click();
    await page.locator('.library-unit__pulse').click();
    await expect(page.locator('.library-unit__pulse')).toHaveCount(0);
    await expect(page.locator('.library-unit__active')).toHaveCount(2);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    expect(page.isClosed()).toBe(false);
    await gate.release(0);
    await expect.poll(() => gate!.calls()).toHaveLength(2);
    expect((await gate.calls())[1][1]).toHaveLength(2);
    expect(page.isClosed()).toBe(false);
    await gate.release(1);
    await expect.poll(() => page.isClosed()).toBe(true);
    gate = undefined;
    await app.close();
    app = await launch(data);
    page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 design briefs')).toBeVisible({
      timeout: 20_000,
    });
    await page.locator('.default-sidebar-trigger').click();
    await expect(page.locator('.library-unit__active')).toHaveCount(2);
    expect(
      await page.evaluate(async () =>
        window.interview.loadDesignLibrary((await window.interview.snapshot()).workspaceId),
      ),
    ).toHaveLength(2);
  } finally {
    await gate?.restore().catch(() => {});
    await app.close().catch(() => {});
  }
});
