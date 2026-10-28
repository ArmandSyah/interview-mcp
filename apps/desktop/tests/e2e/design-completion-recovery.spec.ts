import { expect, test, type Page } from '@playwright/test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch } from './desktop';
import { gateIpc } from './ipc-gate';

async function review(page: Page) {
  await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'System design', exact: true }).click();
  await page
    .getByRole('button', { name: /Link Alias Service/ })
    .first()
    .click();
  await page
    .getByRole('textbox', { name: 'Requirements', exact: true })
    .fill('Keep the saved recovery notes.');
  await page.getByRole('button', { name: '+ Database', exact: true }).click();
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Finish practice', exact: true })).toBeEnabled();
}

test('restart reconciles an older local status before it displays editable design notes', async () => {
  const data = await mkdtemp(join(tmpdir(), 'interview-design-status-restart-'));
  let app = await launch(data);
  let gate: Awaited<ReturnType<typeof gateIpc>> | undefined;
  try {
    let page = await app.firstWindow();
    await review(page);
    const before = await page.evaluate(() => window.interview.snapshot());
    const id = before.activeDesignSessionId!;
    const original = before.designSessions.find((item) => item.id === id)!;
    const draft = await page.evaluate((id) => window.interview.loadDesignDraft(id), id);
    await page.getByRole('button', { name: 'Finish practice', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Session finished', exact: true }),
    ).toBeDisabled();
    const completed = (await page.evaluate(() => window.interview.snapshot())).designSessions.find(
      (item) => item.id === id,
    )!;
    await page.getByRole('button', { name: 'Coding', exact: true }).click();
    await app.close();
    // Restore the exact pre-finish local record. The real backend keeps its completion.
    // This is the disk state after process loss before the final local write.
    const path = join(data, 'workspace.json');
    const state = JSON.parse(await readFile(path, 'utf8'));
    state.workspaces[before.workspaceId].designSessions = [original];
    await writeFile(path, JSON.stringify(state));
    app = await launch(data);
    page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    gate = await gateIpc(app, 'design-load');
    await page.getByRole('button', { name: 'System design', exact: true }).click();
    await expect.poll(gate.calls).toEqual([[id]]);
    await expect(page.getByRole('textbox', { name: 'Requirements', exact: true })).toHaveCount(0);
    await expect(page.getByTestId('design-canvas').locator('.excalidraw')).toHaveCount(0);
    await gate.release(0, 'Fixture status read failure');
    await expect(
      page.getByRole('alert').filter({ hasText: 'Fixture status read failure' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Retry canvas load', exact: true }).click();
    await expect.poll(gate.calls).toEqual([[id], [id]]);
    await gate.release(1);
    await expect(page.getByRole('textbox', { name: 'Requirements', exact: true })).toHaveValue(
      'Keep the saved recovery notes.',
    );
    await expect(page.getByRole('textbox', { name: 'Requirements', exact: true })).toBeDisabled();
    const recovered = await page.evaluate(() => window.interview.snapshot());
    expect(recovered.designSessions.find((item) => item.id === id)).toEqual(completed);
    await gate.restore();
    gate = undefined;
    expect(await page.evaluate((id) => window.interview.loadDesignDraft(id), id)).toEqual(draft);
  } finally {
    await gate?.restore();
    await app.close().catch(() => {});
  }
});

test('lost backend completion response locks notes and offers a status retry', async () => {
  test.skip(
    !!process.env.INTERVIEW_DESKTOP_EXECUTABLE,
    'Source fixture intercepts the backend response.',
  );
  const directory = await mkdtemp(join(tmpdir(), 'interview-design-status-response-'));
  const entry = join(directory, 'entry.cjs');
  await writeFile(
    entry,
    `
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const original = ${JSON.stringify(resolve('dist/main/index.cjs'))};
const source = fs.readFileSync(original, 'utf8');
const fixture = ${JSON.stringify(`
const savedCall = McpConnection.prototype.call;
McpConnection.prototype.call = async function(name, args, signal) {
  const result = await savedCall.call(this, name, args, signal);
  if (name === "finish_design_session") throw new Error("Fixture backend completion response lost");
  return result;
};
`)};
if (!source.includes('var McpConnection = class')) throw new Error('Backend fixture marker missing');
const loaded = new Module(original, module);
loaded.filename = original;
loaded.paths = Module._nodeModulePaths(path.dirname(original));
loaded._compile(source + fixture, original);
`,
  );
  const app = await launch(join(directory, 'data'), '', entry);
  try {
    const page = await app.firstWindow();
    await review(page);
    await page.getByRole('button', { name: 'Finish practice', exact: true }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Fixture backend completion response lost' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'notes', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Requirements', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '+ Database', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Retry canvas load', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Requirements', exact: true })).toHaveValue(
      'Keep the saved recovery notes.',
    );
    await expect(page.getByRole('textbox', { name: 'Requirements', exact: true })).toBeDisabled();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByRole('button', { name: 'review', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Session finished', exact: true }),
    ).toBeDisabled();
    const after = await page.evaluate(() => window.interview.snapshot());
    expect(after.designSessions[0].status).toBe('completed');
    expect(after.designSessions[0].completed_at).toBeTruthy();
    expect(after.designSessionVerified).toBe(true);
  } finally {
    await app.close().catch(() => {});
  }
});
