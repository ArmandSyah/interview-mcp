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
  await expect(page.getByTestId('design-canvas').locator('.excalidraw')).toBeVisible();
}

async function draft(page: Page) {
  return page.evaluate(async () => {
    const snapshot = await window.interview.snapshot();
    return window.interview.loadDesignDraft(snapshot.activeDesignSessionId!);
  });
}

async function flush(page: Page) {
  const previous = await page.evaluate(async () => {
    const snapshot = await window.interview.snapshot();
    return snapshot.designSessions.find((item) => item.id === snapshot.activeDesignSessionId)!
      .latestCheckpointId;
  });
  await page.getByRole('button', { name: 'Checkpoint', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const snapshot = await window.interview.snapshot();
        return snapshot.designSessions.find((item) => item.id === snapshot.activeDesignSessionId)!
          .latestCheckpointId;
      }),
    )
    .not.toBe(previous);
  await expect(page.getByRole('button', { name: 'Checkpoint', exact: true })).toBeEnabled();
  return draft(page);
}

function liveElements(value: Awaited<ReturnType<typeof draft>>) {
  return value.scene.elements
    .filter((element) => !element.isDeleted)
    .map((element) => ({
      id: element.id,
      type: element.type,
      text: element.text,
      kind: (element.customData as Record<string, unknown> | undefined)?.componentKind,
      containerId: element.containerId,
    }))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

test('remaining palette choices retain labels, and Clear canvas supports Cancel and Undo', async () => {
  const data = await mkdtemp(join(tmpdir(), 'interview-design-controls-'));
  let app = await launch(data);
  try {
    let page = await app.firstWindow();
    await openDesign(page);
    const notes = 'Keep these candidate notes when the canvas changes.';
    await page.getByRole('textbox', { name: 'Requirements', exact: true }).fill(notes);
    for (const choice of ['Queue', 'Worker', 'Object storage'])
      await page.getByRole('button', { name: `+ ${choice}`, exact: true }).click();
    const before = await flush(page);
    const elements = liveElements(before);
    expect(elements).toHaveLength(6);
    expect(
      elements
        .filter((element) => element.type !== 'text')
        .map((element) => element.kind)
        .sort(),
    ).toEqual(['object_storage', 'queue', 'worker']);
    expect(
      elements
        .filter((element) => element.type === 'text')
        .map((element) => element.text)
        .sort(),
    ).toEqual(['Object storage', 'Queue', 'Worker']);
    for (const label of elements.filter((element) => element.type === 'text'))
      expect(elements.some((element) => element.id === label.containerId)).toBe(true);
    const storageId = elements.find((element) => element.kind === 'object_storage')!.id;
    await page.getByTestId('design-canvas').getByTestId('button-undo').click();
    expect(liveElements(await flush(page))).toEqual(
      elements.filter((element) => element.id !== storageId && element.containerId !== storageId),
    );
    await page.getByTestId('design-canvas').getByTestId('button-redo').click();
    expect(liveElements(await flush(page))).toEqual(elements);
    await page.getByTestId('main-menu-trigger').click();
    await page.getByTestId('clear-canvas-button').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(liveElements(await flush(page))).toEqual(elements);
    await page.getByTestId('main-menu-trigger').click();
    await page.getByTestId('clear-canvas-button').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
    expect(liveElements(await flush(page))).toEqual([]);
    await page.getByTestId('design-canvas').getByTestId('button-undo').click();
    expect(liveElements(await flush(page))).toEqual(elements);
    await expect(page.getByRole('textbox', { name: 'Requirements', exact: true })).toHaveValue(
      notes,
    );
    await app.close();
    app = await launch(data);
    page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 design briefs')).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId('design-canvas').locator('.excalidraw')).toBeVisible();
    expect(liveElements(await draft(page))).toEqual(elements);
    await expect(page.getByRole('textbox', { name: 'Requirements', exact: true })).toHaveValue(
      notes,
    );
  } finally {
    await app.close().catch(() => {});
  }
});

test('Mock disables hints and the timer display stays at zero without finishing practice', async () => {
  const data = await mkdtemp(join(tmpdir(), 'interview-design-timer-zero-'));
  let app = await launch(data);
  let hint: Awaited<ReturnType<typeof gateIpc>> | undefined;
  try {
    let page = await app.firstWindow();
    await openDesign(page);
    await page.getByRole('button', { name: 'Coding', exact: true }).click();
    await expect(page.getByRole('heading', { name: /Your next interview/ })).toBeVisible();
    // Use the real save API while the design view is absent to start one second before its limit.
    const limit = await page.evaluate(async () => {
      const snapshot = await window.interview.snapshot();
      const session = snapshot.designSessions.find(
        (item) => item.id === snapshot.activeDesignSessionId,
      )!;
      const value = await window.interview.loadDesignDraft(session.id);
      const limit = session.brief.time_budget_minutes * 60;
      await window.interview.saveDesignDraft(session.id, { ...value, elapsedSeconds: limit - 1 });
      return limit;
    });
    await page.getByRole('button', { name: 'System design', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Start timer', exact: true })).toHaveText(
      '00:01 · Start',
    );
    hint = await gateIpc(app, 'design-hint');
    await page.getByLabel('Practice mode').selectOption('mock');
    const curated = page.getByRole('button', { name: 'One curated hint', exact: true });
    await expect(curated).toBeDisabled();
    await curated.evaluate((element: HTMLButtonElement) => element.click());
    await page.evaluate(() => window.interview.snapshot());
    expect(await hint.calls()).toEqual([]);
    await page.getByLabel('Practice mode').selectOption('guided');
    await expect(curated).toBeEnabled();
    await page.getByLabel('Practice mode').selectOption('mock');
    const pausedAt = new Date();
    await page.clock.install({ time: new Date(pausedAt.getTime() - 60_000) });
    await page.clock.pauseAt(pausedAt);
    await page.getByRole('button', { name: 'Start timer', exact: true }).click();
    await page.clock.runFor(3000);
    await expect(page.getByRole('button', { name: 'Pause timer', exact: true })).toHaveText(
      '00:00 · Pause',
    );
    await page.getByRole('button', { name: 'Pause timer', exact: true }).click();
    await page.clock.runFor(2000);
    const value = await flush(page);
    expect(value.elapsedSeconds).toBe(limit + 2);
    expect(value.practiceMode).toBe('mock');
    expect((await page.evaluate(() => window.interview.snapshot())).designSessions[0].status).toBe(
      'in_progress',
    );
    await expect(page.getByRole('textbox', { name: 'Requirements', exact: true })).toBeEditable();
    await hint.restore();
    hint = undefined;
    await app.close();
    app = await launch(data);
    page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 design briefs')).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole('button', { name: 'Start timer', exact: true })).toHaveText(
      '00:00 · Start',
    );
    await expect(page.getByLabel('Practice mode')).toHaveValue('mock');
    expect((await draft(page)).elapsedSeconds).toBe(limit + 2);
  } finally {
    await hint?.restore().catch(() => {});
    await app.close().catch(() => {});
  }
});
