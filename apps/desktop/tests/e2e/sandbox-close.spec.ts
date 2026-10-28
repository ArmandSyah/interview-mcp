import { expect, test } from '@playwright/test';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';
import { gateIpc } from './ipc-gate';

for (const phase of ['before command', 'active command'] as const) {
  test(`native close cancels sandbox work: ${phase}`, async () => {
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
    let gate: Awaited<ReturnType<typeof gateIpc>> | undefined;
    try {
      const page = await app.firstWindow();
      await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
      await page.getByRole('button', { name: 'Open settings' }).click();
      if (phase === 'before command') gate = await gateIpc(app, 'sandbox-inspect');
      await page.getByRole('button', { name: 'Check local sandbox', exact: true }).click();
      if (gate) await expect.poll(async () => (await gate!.calls()).length).toBe(1);
      else await expect.poll(() => readFile(marker, 'utf8').catch(() => '')).toBe('started');
      let closed = false;
      app.on('close', () => {
        closed = true;
      });
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
      if (gate) await gate.release(0);
      await expect.poll(() => closed, { timeout: 5000 }).toBe(true);
      if (gate) await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await gate?.restore().catch(() => {});
      await app.close().catch(() => {});
    }
  });
}
