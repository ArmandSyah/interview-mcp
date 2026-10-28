import { expect, test } from '@playwright/test';
import { mkdir, mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectionEvidence } from '../connection-evidence';
import { launch } from './desktop';

test('settings reconnection records backend phases without practice text or workspace paths', async () => {
  const data = await mkdtemp(join(tmpdir(), 'interview-connection-evidence-'));
  const app = await launch(data);
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
    await expect(page.getByTestId('code-editor')).toBeVisible();
    const privateText = '# fixture-private-practice-must-not-enter-connection-records';
    await page.evaluate(async (code) => {
      const snapshot = await window.interview.snapshot();
      await window.interview.saveCode(snapshot.activeProblemId!, code);
    }, privateText);
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Workbench settings' });
    await settings.getByRole('button', { name: 'Save & connect', exact: true }).click();
    await expect(settings).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible();

    const evidence = (await connectionEvidence(app))!;
    expect(evidence.version).toBe(1);
    expect(evidence.truncated).toBe(false);
    const children = evidence.entries.filter((row) =>
      ['child-observed-existing', 'child-spawn-request'].includes(row.event),
    );
    expect(children).toHaveLength(2);
    const [previous, next] = children;
    const finished = evidence.entries.find(
      (row) => row.event === 'stdin-finish' && row.childId === previous.childId,
    )!;
    expect(finished).toBeDefined();
    expect(finished.elapsedMs).toBeLessThanOrEqual(next.elapsedMs);
    const received = evidence.entries.find(
      (row) => row.event === 'stdout-first-data' && row.childId === next.childId,
    )!;
    expect(received).toBeDefined();
    expect(received.elapsedMs).toBeGreaterThanOrEqual(next.elapsedMs);
    expect(
      evidence.entries.some((row) => row.childId === next.childId && row.method === 'initialize'),
    ).toBe(true);
    expect(
      evidence.entries.some((row) => row.childId === next.childId && row.tool === 'list_problems'),
    ).toBe(true);
    expect(evidence.entries.filter((row) => row.event === 'snapshot').at(-1)).toMatchObject({
      connection: 'connected',
      busy: false,
      problems: 5,
      hasError: false,
    });
    expect(JSON.stringify(evidence)).not.toContain(privateText);
    expect(JSON.stringify(evidence)).not.toContain(data);
    expect((await page.evaluate(() => window.interview.snapshot())).sessions[0].code).toBe(
      privateText,
    );
  } finally {
    await app.close();
  }
});

test('a connection artifact write error keeps the Electron context trace available', async () => {
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-connection-artifact-error-')));
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    const info = test.info();
    const raw = (await readdir(info.outputDir)).find((name) => /^electron-.+-raw$/.test(name));
    expect(raw).toBeDefined();
    const name = raw!.slice(0, -4);
    await mkdir(info.outputPath(`${name}-connection.json`));
    await app.close();
    expect((await stat(info.outputPath(`${name}.zip`))).isFile()).toBe(true);
    expect(
      info.attachments
        .find((attachment) => attachment.name === `${name}-connection-error`)
        ?.body?.toString(),
    ).toBe('Connection artifact could not be saved.');
    expect(info.attachments.some((attachment) => attachment.name === `${name}-trace-error`)).toBe(
      false,
    );
  } finally {
    await app.close();
  }
});
