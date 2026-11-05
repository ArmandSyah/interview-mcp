import { expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../../src/main/storage';
import { launch } from './desktop';
import { pasteAccountDraft } from './account-fixture';
import {
  sandboxContainerId,
  sandboxRawError,
  sandboxSetupFixture,
  type SandboxSetupHost,
  type SandboxSetupState,
} from './sandbox-setup-fixture';

const code = '# Preserve this draft through sandbox setup and repair.\n';
const state = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as SandboxSetupHost).sandboxSetup.state);

async function openSandbox(initial: Parameters<typeof sandboxSetupFixture>[1] = {}) {
  const data = await mkdtemp(join(tmpdir(), 'interview-sandbox-setup-'));
  const fixture = await sandboxSetupFixture(data, initial);
  const app = await launch(data, '', fixture.entry);
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
    await pasteAccountDraft(page, code);
    const before = await page.evaluate(() => window.interview.snapshot());
    await page.getByRole('button', { name: 'Open settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Workbench settings' });
    const panel = dialog.locator('.sandbox-settings');
    const ready = async () => {
      await expect(panel.getByRole('status')).toContainText('Local execution is ready.');
      await expect(
        panel.getByRole('button', { name: 'Start / repair sandbox', exact: true }),
      ).toBeEnabled({ timeout: 20_000 });
      await expect(
        dialog.getByRole('checkbox', {
          name: 'Start the app-owned sandbox for local code execution',
        }),
      ).toBeChecked();
    };
    return { data, fixture, app, page, before, dialog, panel, ready };
  } catch (error) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    throw error;
  }
}

async function stopTest(app: ElectronApplication) {
  // Release only fixture work. The real manager still performs its normal owned cleanup.
  await app
    .evaluate(() => {
      const fixture = (globalThis as SandboxSetupHost).sandboxSetup;
      fixture.state.failStop = 0;
      fixture.release?.();
    })
    .catch(() => {});
  await app.close().catch(async () => {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  });
}

function expectOwnedCommands(value: SandboxSetupState) {
  expect(value.commands.every(({ args }) => !args.includes('down') && !args.includes('rm'))).toBe(
    true,
  );
  for (const { args } of value.commands.filter(({ args }) => args[0] === 'stop'))
    expect(args).toEqual(['stop', '--time', '10', sandboxContainerId]);
}

test.beforeEach(() => {
  test.skip(!!process.env.INTERVIEW_DESKTOP_EXECUTABLE, 'The fixture replaces source boundaries.');
});

test('consent controls setup and the panel shows image and runtime progress', async () => {
  const current = await openSandbox();
  const { app, page, dialog, panel } = current;
  try {
    expect((await state(app)).commands).toEqual([]);
    await app.evaluate(() => {
      (globalThis as SandboxSetupHost).sandboxSetup.state.answer = 0;
    });
    const enable = panel.getByRole('button', { name: 'Enable local execution', exact: true });
    await enable.click();
    await expect.poll(async () => (await state(app)).consents.length).toBe(1);
    await expect(enable).toBeEnabled();
    expect((await state(app)).commands).toEqual([]);
    expect((await state(app)).requests).toEqual([]);
    expect((await page.evaluate(() => window.interview.snapshot())).settings.managedSandbox).toBe(
      false,
    );
    await app.evaluate(() => {
      const fixture = (globalThis as SandboxSetupHost).sandboxSetup;
      fixture.state.answer = 1;
      fixture.state.hold = 'start';
    });
    await enable.click();
    await expect.poll(async () => (await state(app)).held).toBe('start');
    await expect(panel.getByRole('status')).toContainText('Starting the pinned local sandbox.');
    await expect(enable).toBeDisabled();
    await expect(panel.getByRole('button', { name: 'Stop app-owned sandbox' })).toBeDisabled();
    const consents = (await state(app)).consents;
    expect(consents).toHaveLength(2);
    expect(consents[1]).toMatchObject({
      title: 'Enable local code execution?',
      buttons: ['Keep practicing without execution', 'Enable local execution'],
      defaultId: 0,
      cancelId: 0,
    });
    await app.evaluate(() => {
      const fixture = (globalThis as SandboxSetupHost).sandboxSetup;
      fixture.state.hold = 'install';
      fixture.release!();
    });
    await expect.poll(async () => (await state(app)).held).toBe('install');
    await expect(panel.getByRole('status')).toContainText('Installing Python 3.12');
    await expect(
      dialog.getByRole('button', { name: 'Save & connect', exact: true }),
    ).toBeDisabled();
    await app.evaluate(() => {
      const fixture = (globalThis as SandboxSetupHost).sandboxSetup;
      delete fixture.state.hold;
      fixture.release!();
    });
    await current.ready();
    const snapshot = await page.evaluate(() => window.interview.snapshot());
    expect(snapshot.settings).toMatchObject({
      managedSandbox: true,
      pistonUrl: 'http://127.0.0.1:2000',
      provider: 'disabled',
    });
    expect(snapshot.sessions).toEqual(current.before.sessions);
    const evidence = await state(app);
    expect(evidence.commands.filter(({ args }) => args.includes('up'))).toHaveLength(1);
    expect(evidence.requests.filter(({ path }) => path === 'packages')).toHaveLength(1);
    expect(evidence.requests.filter(({ path }) => path === 'execute')).toHaveLength(1);
    expectOwnedCommands(evidence);
    const saved = new LocalStore(current.data);
    await saved.load();
    expect(saved.state.settings.managedSandbox).toBe(true);
  } finally {
    await stopTest(app);
  }
});

test('runtime setup failure hides raw errors and permits retry without another image start', async () => {
  const current = await openSandbox({ failInstall: 1 });
  const { app, page, panel } = current;
  try {
    const enable = panel.getByRole('button', { name: 'Enable local execution', exact: true });
    await enable.click();
    await expect(panel.getByRole('alert')).toContainText('Sandbox setup failed.');
    await expect(enable).toBeEnabled();
    expect(await panel.textContent()).not.toContain(sandboxRawError);
    const failed = await page.evaluate(() => window.interview.snapshot());
    expect(JSON.stringify(failed)).not.toContain(sandboxRawError);
    expect(failed.settings.managedSandbox).toBe(false);
    expect(failed.sessions).toEqual(current.before.sessions);
    expect((await state(app)).running).toBe(true);
    expect((await state(app)).python).toBe(false);
    await enable.click();
    await current.ready();
    await expect(panel.getByRole('alert')).toHaveCount(0);
    const evidence = await state(app);
    expect(evidence.consents).toHaveLength(2);
    expect(evidence.commands.filter(({ args }) => args.includes('up'))).toHaveLength(1);
    expect(evidence.requests.filter(({ path }) => path === 'packages')).toHaveLength(2);
    expect(evidence.python).toBe(true);
    expectOwnedCommands(evidence);
    expect((await page.evaluate(() => window.interview.snapshot())).sessions).toEqual(
      current.before.sessions,
    );
  } finally {
    await stopTest(app);
  }
});

test('repair reuses Python, owned stop permits retry, and opt-out survives restart', async () => {
  const current = await openSandbox({ owned: true, running: true, python: true });
  const { app, page, panel, dialog } = current;
  let reopened: ElectronApplication | undefined;
  try {
    await panel.getByRole('button', { name: 'Enable local execution', exact: true }).click();
    await current.ready();
    await app.evaluate(() => {
      const fixture = (globalThis as SandboxSetupHost).sandboxSetup;
      fixture.state.running = false;
      fixture.state.hold = 'start';
    });
    await panel.getByRole('button', { name: 'Start / repair sandbox', exact: true }).click();
    await expect.poll(async () => (await state(app)).held).toBe('start');
    await expect(panel.getByRole('status')).toContainText('Starting the pinned local sandbox.');
    await app.evaluate(() => {
      const fixture = (globalThis as SandboxSetupHost).sandboxSetup;
      delete fixture.state.hold;
      fixture.release!();
    });
    await current.ready();
    expect((await state(app)).commands.filter(({ args }) => args.includes('up'))).toHaveLength(1);
    expect((await state(app)).requests.filter(({ path }) => path === 'packages')).toEqual([]);
    expect((await state(app)).consents).toHaveLength(1);
    await app.evaluate(() => {
      (globalThis as SandboxSetupHost).sandboxSetup.state.failStop = 1;
    });
    const stop = panel.getByRole('button', { name: 'Stop app-owned sandbox', exact: true });
    await stop.click();
    await expect(panel.getByRole('alert')).toContainText('Sandbox setup failed.');
    expect(await panel.textContent()).not.toContain(sandboxRawError);
    expect((await state(app)).running).toBe(true);
    await expect(stop).toBeEnabled();
    await stop.click();
    await expect(panel.getByRole('status')).toContainText('App-owned sandbox stopped.');
    await expect(stop).toBeDisabled();
    await expect(panel.getByRole('alert')).toHaveCount(0);
    expect((await state(app)).python).toBe(true);
    await dialog
      .getByRole('checkbox', { name: 'Start the app-owned sandbox for local code execution' })
      .uncheck();
    await dialog.getByRole('button', { name: 'Save & connect', exact: true }).click();
    await expect(dialog).not.toBeVisible({ timeout: 20_000 });
    const snapshot = await page.evaluate(() => window.interview.snapshot());
    expect(snapshot.settings.managedSandbox).toBe(false);
    expect(snapshot.sessions).toEqual(current.before.sessions);
    await app.close();
    const evidence = JSON.parse(
      await readFile(current.fixture.evidence, 'utf8'),
    ) as SandboxSetupState;
    expect(evidence.running).toBe(false);
    expect(evidence.python).toBe(true);
    expect(evidence.commands.filter(({ args }) => args[0] === 'stop')).toHaveLength(2);
    expectOwnedCommands(evidence);
    reopened = await launch(current.data, '', current.fixture.entry);
    const restored = await reopened.firstWindow();
    await expect(restored.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    const saved = await restored.evaluate(() => window.interview.snapshot());
    expect(saved.settings.managedSandbox).toBe(false);
    expect(saved.sessions).toEqual(current.before.sessions);
    expect((await state(reopened)).commands).toEqual(evidence.commands);
  } finally {
    if (reopened) await stopTest(reopened);
    await stopTest(app);
  }
});

test('close during runtime installation cancels the request and stops only the owned container', async () => {
  const current = await openSandbox();
  const { app, panel } = current;
  try {
    await app.evaluate(() => {
      (globalThis as SandboxSetupHost).sandboxSetup.state.hold = 'install';
    });
    await panel.getByRole('button', { name: 'Enable local execution', exact: true }).click();
    await expect.poll(async () => (await state(app)).held).toBe('install');
    await expect(panel.getByRole('status')).toContainText('Installing Python 3.12');
    let closed = false;
    app.on('close', () => {
      closed = true;
    });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    await expect.poll(() => closed, { timeout: 5000 }).toBe(true);
    const evidence = JSON.parse(
      await readFile(current.fixture.evidence, 'utf8'),
    ) as SandboxSetupState;
    expect(evidence.aborted).toEqual(['install']);
    expect(evidence).toMatchObject({ owned: true, running: false, python: false });
    expect(evidence.commands.filter(({ args }) => args[0] === 'stop')).toEqual([
      expect.objectContaining({
        args: ['stop', '--time', '10', sandboxContainerId],
        cleanup: true,
      }),
    ]);
    expectOwnedCommands(evidence);
    const saved = new LocalStore(current.data);
    await saved.load();
    expect(saved.state.settings.managedSandbox).toBe(false);
    expect(Object.values(saved.state.workspaces).flatMap((item) => item.sessions)).toEqual(
      current.before.sessions,
    );
  } finally {
    await stopTest(app);
  }
});
