import { expect, test } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentFixture, type ContentFixtureState } from './content-fixture';
import { launch } from './desktop';
import { gateIpc } from './ipc-gate';

test('preview disables pack installation and hides checkout', async () => {
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-content-preview-')));
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Open settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Workbench settings' });
    await expect(dialog.getByText(/Paid packs are not configured in this preview/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Install pack & license' })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Open hosted checkout' })).toHaveCount(0);
  } finally {
    await app.close().catch(() => {});
  }
});

test('pack errors permit retry and verified installation refreshes both catalogs', async () => {
  test.skip(
    !!process.env.INTERVIEW_DESKTOP_EXECUTABLE,
    'Source fixture supplies an ephemeral trust key.',
  );
  const directory = await mkdtemp(join(tmpdir(), 'interview-content-install-'));
  const fixture = await contentFixture(directory);
  const app = await launch(join(directory, 'data'), '', fixture.entry);
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await page
      .getByRole('button', { name: /Training Mix Segment/ })
      .first()
      .click();
    await expect(page.getByTestId('code-editor')).toBeVisible();
    const before = await page.evaluate(() => window.interview.snapshot());
    expect(before.sessions).toHaveLength(1);
    await page.getByRole('button', { name: 'Open settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Workbench settings' });
    const install = dialog.getByRole('button', { name: 'Install pack & license' });
    await install.click();
    await expect(install).toBeEnabled();
    expect(
      await app.evaluate(
        () =>
          (globalThis as unknown as { contentFixture: ContentFixtureState }).contentFixture
            .selections,
      ),
    ).toBe(1);
    const canceled = await page.evaluate(() => window.interview.snapshot());
    expect(canceled.installedPacks).toEqual(before.installedPacks);
    expect(canceled.problems).toEqual(before.problems);
    expect(canceled.designProblems).toEqual(before.designProblems);
    expect(canceled.sessions).toEqual(before.sessions);
    for (const [paths, message] of [
      [[fixture.pack], 'Select exactly one signed pack'],
      [[join(directory, 'missing.json'), fixture.claims], 'ENOENT'],
      [[fixture.invalid, fixture.claims], 'Not a signed package or license'],
      [[fixture.corrupt, fixture.claims], 'Package signature or format is invalid'],
    ] as const) {
      await app.evaluate(
        (_electron, paths) => {
          Object.assign(
            (globalThis as unknown as { contentFixture: ContentFixtureState }).contentFixture,
            { canceled: false, paths },
          );
        },
        [...paths],
      );
      await install.click();
      await expect(dialog.getByRole('status').filter({ hasText: message })).toBeVisible();
      await expect(install).toBeEnabled();
      const after = await page.evaluate(() => window.interview.snapshot());
      expect(after.installedPacks).toEqual([]);
      expect(after.problems).toEqual(before.problems);
      expect(after.designProblems).toEqual(before.designProblems);
      expect(after.sessions).toEqual(before.sessions);
    }
    await app.evaluate(
      (_electron, paths) => {
        (globalThis as unknown as { contentFixture: ContentFixtureState }).contentFixture.paths =
          paths;
      },
      [fixture.claims, fixture.pack],
    );
    const gate = await gateIpc(app, 'install-pack');
    try {
      await install.evaluate((button) => {
        (button as HTMLButtonElement).click();
        (button as HTMLButtonElement).click();
      });
      await expect.poll(async () => (await gate.calls()).length).toBe(1);
      await expect(install).toBeDisabled();
      await expect(dialog.getByRole('button', { name: 'Open hosted checkout' })).toBeDisabled();
      await gate.release(0);
      await expect(
        dialog.getByText(/Fixture original pack · 1.0.0 · updates through/),
      ).toBeVisible();
      await expect(install).toBeEnabled();
      expect(await gate.calls()).toHaveLength(1);
    } finally {
      await gate.restore();
    }
    const after = await page.evaluate(() => window.interview.snapshot());
    expect(after.problems).toHaveLength(before.problems.length + 1);
    expect(after.designProblems).toHaveLength(before.designProblems.length + 1);
    expect(after.sessions).toEqual(before.sessions);
    expect(after.installedPacks).toHaveLength(1);
    await dialog.getByRole('button', { name: 'Close settings' }).click();
    await expect(page.getByRole('button', { name: /Pair Budget Match/ }).first()).toBeVisible();
    await page.getByRole('button', { name: 'System design', exact: true }).click();
    await expect(page.getByRole('button', { name: /Link Alias Service/ })).toHaveCount(2);
  } finally {
    await app.close().catch(() => {});
  }
});

test('configured checkout shows shell errors and retries the exact URL', async () => {
  test.skip(!!process.env.INTERVIEW_DESKTOP_EXECUTABLE, 'Source fixture supplies a checkout URL.');
  const directory = await mkdtemp(join(tmpdir(), 'interview-content-checkout-'));
  const fixture = await contentFixture(directory);
  const app = await launch(join(directory, 'data'), '', fixture.entry);
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Open settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Workbench settings' });
    const checkout = dialog.getByRole('button', { name: 'Open hosted checkout' });
    await app.evaluate(() => {
      (globalThis as unknown as { contentFixture: ContentFixtureState }).contentFixture.shellError =
        'Fixture browser unavailable';
    });
    await checkout.click();
    await expect(
      dialog.getByRole('status').filter({ hasText: 'Fixture browser unavailable' }),
    ).toBeVisible();
    await expect(checkout).toBeEnabled();
    await app.evaluate(() => {
      (globalThis as unknown as { contentFixture: ContentFixtureState }).contentFixture.shellError =
        '';
    });
    await checkout.click();
    await expect(checkout).toBeEnabled();
    await expect(
      dialog.getByRole('status').filter({ hasText: 'Fixture browser unavailable' }),
    ).toHaveCount(0);
    expect(
      await app.evaluate(
        () =>
          (globalThis as unknown as { contentFixture: ContentFixtureState }).contentFixture.opened,
      ),
    ).toEqual([fixture.checkout, fixture.checkout]);
  } finally {
    await app.close().catch(() => {});
  }
});
