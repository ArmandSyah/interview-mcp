import { expect, test, type ElectronApplication } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch } from './desktop';
import { desktopEnvironment } from '../desktop-environment';
import { pasteAccountDraft } from './account-fixture';
import { gateIpc } from './ipc-gate';
import { LocalStore } from '../../src/main/storage';

async function menuAction(app: ElectronApplication, role: string) {
  await app.evaluate(({ Menu, BrowserWindow }, role) => {
    const menu = Menu.getApplicationMenu();
    const item = menu?.items
      .flatMap((item) => item.submenu?.items ?? [])
      .find((item) => item.role?.toLowerCase() === role.toLowerCase());
    if (!item) throw new Error(`Missing menu role: ${role}`);
    const window = BrowserWindow.getAllWindows()[0]!;
    item.click({}, window, window.webContents);
  }, role);
}

test('native window size, maximize, full screen, and menu zoom preserve practice', async () => {
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-window-controls-')));
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
    await pasteAccountDraft(page, '# Preserve this practice through window changes.\n');
    const before = await page.evaluate(() => window.interview.snapshot());
    const native = () =>
      app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        return {
          bounds: window.getBounds(),
          maximized: window.isMaximized(),
          fullScreen: window.isFullScreen(),
          zoom: window.webContents.getZoomFactor(),
        };
      });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(400, 400));
    await expect.poll(async () => (await native()).bounds.width).toBeGreaterThanOrEqual(1040);
    await expect.poll(async () => (await native()).bounds.height).toBeGreaterThanOrEqual(660);
    await expect(page.getByRole('button', { name: 'Open settings' })).toBeVisible();
    const minimum = (await native()).bounds;
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.maximize());
    await expect.poll(async () => (await native()).maximized).toBe(true);
    expect((await native()).bounds.width).toBeGreaterThanOrEqual(minimum.width);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.unmaximize());
    await expect.poll(async () => (await native()).maximized).toBe(false);
    await expect.poll(async () => (await native()).bounds.width).toBe(minimum.width);
    await menuAction(app, 'togglefullscreen');
    await expect.poll(async () => (await native()).fullScreen).toBe(true);
    await menuAction(app, 'togglefullscreen');
    await expect.poll(async () => (await native()).fullScreen).toBe(false);
    await menuAction(app, 'zoomIn');
    await expect.poll(async () => (await native()).zoom).toBeGreaterThan(1);
    const enlarged = (await native()).zoom;
    await menuAction(app, 'zoomOut');
    await expect.poll(async () => (await native()).zoom).toBeLessThan(enlarged);
    await menuAction(app, 'resetZoom');
    await expect.poll(async () => (await native()).zoom).toBe(1);
    const after = await page.evaluate(() => window.interview.snapshot());
    expect(after.sessions).toEqual(before.sessions);
    expect(after.activeProblemId).toBe(before.activeProblemId);
    await expect(page.getByRole('button', { name: 'Hint', exact: true })).toBeEnabled();
  } finally {
    await app.close();
  }
});

for (const mode of ['coding', 'design'] as const) {
  test(`menu Quit waits for the pending ${mode} draft`, async () => {
    const data = await mkdtemp(join(tmpdir(), 'interview-menu-quit-'));
    const app = await launch(data);
    let gate: Awaited<ReturnType<typeof gateIpc>> | undefined;
    try {
      const page = await app.firstWindow();
      await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
      await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
      if (mode === 'design') {
        await page.getByRole('button', { name: 'System design', exact: true }).click();
        await page
          .getByRole('button', { name: /Link Alias Service/ })
          .first()
          .click();
        await expect(page.getByText(/Saved locally/)).toBeVisible();
      }
      const before = await page.evaluate(() => window.interview.snapshot());
      gate = await gateIpc(app, mode === 'coding' ? 'save' : 'design-save');
      const text = 'Keep this draft when the user selects Quit.';
      if (mode === 'coding') {
        const editor = page.getByRole('textbox', { name: 'Python solution editor' });
        await editor.focus();
        await page.keyboard.press('ControlOrMeta+a');
        await editor.evaluate((element, text) => {
          const data = new DataTransfer();
          data.setData('text/plain', text);
          element.dispatchEvent(
            new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
          );
        }, text);
      } else await page.getByRole('textbox', { name: 'Requirements', exact: true }).fill(text);
      await expect.poll(gate.calls).toHaveLength(1);
      let closed = false;
      app.on('close', () => {
        closed = true;
      });
      await menuAction(app, 'quit');
      await page.evaluate(() => window.interview.snapshot());
      expect(closed, 'Quit must wait for the pending draft').toBe(false);
      await gate.restore();
      gate = undefined;
      await expect.poll(() => closed, { timeout: 5000 }).toBe(true);
      if (mode === 'coding') {
        const saved = new LocalStore(data);
        await saved.load();
        expect(
          Object.values(saved.state.workspaces).flatMap((workspace) => workspace.sessions)[0].code,
        ).toBe(text);
      } else {
        const draft = JSON.parse(
          await readFile(
            join(data, 'design', before.workspaceId, before.activeDesignSessionId!, 'draft.json'),
            'utf8',
          ),
        );
        expect(draft.notes.requirements).toBe(text);
      }
    } finally {
      await gate?.restore().catch(() => {});
      await app.close().catch(() => {});
    }
  });
}

for (const state of ['minimized', 'maximized'] as const) {
  test(`second instance focuses the ${state} window without another backend`, async () => {
    test.skip(
      !!process.env.INTERVIEW_DESKTOP_EXECUTABLE,
      'The source bootstrap records both processes.',
    );
    const data = await mkdtemp(join(tmpdir(), 'interview-second-instance-'));
    const record = join(data, 'backend-spawns');
    const entry = join(data, 'instance-entry.cjs');
    await writeFile(
      entry,
      `
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const childProcess = require('node:child_process');
const electron = require('electron');
const requestLock = electron.app.requestSingleInstanceLock.bind(electron.app);
electron.app.requestSingleInstanceLock = (...args) => {
  const locked = requestLock(...args);
  fs.appendFileSync(${JSON.stringify(record + '.locks')}, JSON.stringify({ pid: process.pid, locked, argv: process.argv }) + '\\n');
  return locked;
};
const spawn = childProcess.spawn;
childProcess.spawn = (...args) => {
  const child = spawn(...args);
  fs.appendFileSync(${JSON.stringify(record)}, String(child.pid) + '\\n');
  return child;
};
const original = ${JSON.stringify(resolve('dist/main/index.cjs'))};
const loaded = new Module(original, module);
loaded.filename = original;
loaded.paths = Module._nodeModulePaths(path.dirname(original));
loaded._compile(fs.readFileSync(original, 'utf8'), original);
`,
    );
    const app = await launch(data, '', entry);
    let second: ReturnType<typeof spawn> | undefined;
    try {
      const page = await app.firstWindow();
      await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
      await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
      await pasteAccountDraft(page, '# Preserve the first instance draft.\n');
      const before = await page.evaluate(() => window.interview.snapshot());
      const spawned = await readFile(record, 'utf8');
      expect(spawned.trim().split('\n')).toHaveLength(1);
      await app.evaluate(({ BrowserWindow }, state) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        if (state === 'minimized') window.minimize();
        else window.maximize();
      }, state);
      await expect
        .poll(() =>
          app.evaluate(
            ({ BrowserWindow }, state) =>
              state === 'minimized'
                ? BrowserWindow.getAllWindows()[0]!.isMinimized()
                : BrowserWindow.getAllWindows()[0]!.isMaximized(),
            state,
          ),
        )
        .toBe(true);
      second = spawn(
        app.process().spawnfile,
        [
          entry,
          ...app.process().spawnargs.filter((arg) => arg === '--no-sandbox'),
          ...(process.platform === 'linux' ? ['--ozone-platform=x11'] : []),
        ],
        { env: desktopEnvironment(data, ''), stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let secondError = '';
      second.stderr?.on('data', (chunk: Buffer) => {
        secondError = (secondError + chunk.toString()).slice(-4000);
      });
      let secondExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      second.on('exit', (code, signal) => {
        secondExit = { code, signal };
      });
      await expect.poll(() => secondExit, { timeout: 10_000 }).toBeDefined();
      expect(
        secondExit,
        `Second instance exit. locks: ${await readFile(record + '.locks', 'utf8')}; launcher: ${JSON.stringify(app.process().spawnargs)}; stderr: ${secondError}`,
      ).toEqual({
        code: 0,
        signal: null,
      });
      const locks = (await readFile(record + '.locks', 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(locks).toEqual([
        expect.objectContaining({ pid: app.process().pid, locked: true }),
        expect.objectContaining({ pid: second.pid, locked: false }),
      ]);
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) => {
            const windows = BrowserWindow.getAllWindows();
            return {
              count: windows.length,
              minimized: windows[0]!.isMinimized(),
              maximized: windows[0]!.isMaximized(),
              focused: windows[0]!.isFocused(),
            };
          }),
        )
        .toEqual({ count: 1, minimized: false, maximized: state === 'maximized', focused: true });
      expect(await readFile(record, 'utf8'), 'The second process must not start a backend').toBe(
        spawned,
      );
      expect((await page.evaluate(() => window.interview.snapshot())).sessions).toEqual(
        before.sessions,
      );
    } finally {
      if (second && second.exitCode === null) second.kill();
      await app.close();
    }
  });
}
