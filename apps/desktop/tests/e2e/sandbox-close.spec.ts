import { expect, test } from '@playwright/test';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';

test('native close cancels a pending Docker command before its command timeout', async () => {
  test.skip(process.platform !== 'linux', 'The fixture uses a Linux executable.');
  const data = await mkdtemp(join(tmpdir(), 'interview-sandbox-close-'));
  const marker = join(data, 'docker-started');
  const executable = join(data, 'docker');
  await writeFile(executable, `#!/bin/sh\nprintf started > '${marker}'\nexec sleep 120\n`);
  await chmod(executable, 0o700);
  const previousPath = process.env.PATH;
  process.env.PATH = `${data}:${previousPath}`;
  let app;
  try {
    app = await launch(data);
  } finally {
    process.env.PATH = previousPath;
  }
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Open settings' }).click();
    await page.getByRole('button', { name: 'Check local sandbox', exact: true }).click();
    await expect.poll(() => readFile(marker, 'utf8').catch(() => '')).toBe('started');
    let closed = false;
    app.on('close', () => {
      closed = true;
    });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    await expect.poll(() => closed, { timeout: 5000 }).toBe(true);
  } finally {
    await app.close().catch(() => {});
  }
});
