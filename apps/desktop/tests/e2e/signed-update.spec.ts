import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';
import { signedUpdateFixture, type UpdateFixture } from './signed-update-fixture';

test('signed update rejects tampering, retries downloads, and requires confirmation and backup before installer opening', async () => {
  test.skip(
    Boolean(process.env.INTERVIEW_DESKTOP_EXECUTABLE),
    'The ephemeral trust key fixture compiles the source bundle.',
  );
  const data = await mkdtemp(join(tmpdir(), 'interview-signed-update-'));
  const fixture = await signedUpdateFixture(data);
  const app = await launch(data, '', fixture.entry);
  const state = () =>
    app.evaluate(
      () => (globalThis as typeof globalThis & { updateFixture: UpdateFixture }).updateFixture,
    );
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await page
      .getByRole('button', { name: /Training Mix Segment/ })
      .first()
      .click();
    await expect(page.getByTestId('code-editor')).toBeVisible();
    const before = await page.evaluate(() => window.interview.snapshot());
    expect(before.sessions.length).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Open settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Workbench settings' });
    const check = dialog.getByRole('button', { name: 'Check for signed updates', exact: true });
    await check.click();
    await expect(
      dialog.getByRole('status').filter({ hasText: 'Release signature is invalid' }),
    ).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Download verified installer', exact: true }),
    ).toHaveCount(0);
    await check.click();
    const download = dialog.getByRole('button', {
      name: 'Download verified installer',
      exact: true,
    });
    await download.click();
    await expect(
      dialog.getByRole('status').filter({ hasText: 'Installer checksum failed' }),
    ).toBeVisible();
    expect(await readdir(join(data, 'updates', '99.0.0'))).toEqual([]);
    await download.click();
    const install = dialog.getByRole('button', { name: 'Back up & open installer', exact: true });
    await expect(install).toBeEnabled();
    expect(await readFile(join(data, 'updates', '99.0.0', fixture.installerName))).toEqual(
      fixture.bytes,
    );
    await install.click();
    await expect.poll(async () => (await state()).confirmations).toBe(1);
    await expect(install).toBeEnabled();
    expect((await state()).opened).toEqual([]);
    await expect(readdir(join(data, 'backups'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(join(data, 'backups'), 'Fixture backup path obstruction');
    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { updateFixture: UpdateFixture }
      ).updateFixture.confirmation = 1;
    });
    await install.click();
    await expect.poll(async () => (await state()).confirmations).toBe(2);
    await expect(install).toBeEnabled();
    await expect(
      dialog.getByRole('status').filter({ hasText: /EEXIST|ENOTDIR|EPERM/ }),
    ).toBeVisible();
    expect((await state()).opened).toEqual([]);
    await unlink(join(data, 'backups'));
    await install.click();
    await expect.poll(async () => (await state()).opened.length).toBe(1);
    expect((await state()).backupsAtOpen).toHaveLength(1);
    expect((await state()).backupsAtOpen[0]).toContain(before.sessions[0]!.attemptId);
    const backups = await readdir(join(data, 'backups'));
    expect(backups).toHaveLength(1);
    const backup = await readFile(join(data, 'backups', backups[0]!), 'utf8');
    expect(backup).toContain(before.sessions[0]!.attemptId);
    expect((await page.evaluate(() => window.interview.snapshot())).sessions).toEqual(
      before.sessions,
    );
  } finally {
    await app.close().catch(() => {});
  }
});
