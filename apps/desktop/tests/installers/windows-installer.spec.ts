import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { launch } from '../e2e/desktop';

const execute = promisify(execFile);

async function pasteCode(page: Page, text: string) {
  const editor = page.locator('.monaco-editor textarea');
  await editor.focus();
  await page.keyboard.press('Control+a');
  await editor.evaluate((element, value) => {
    const data = new DataTransfer();
    data.setData('text/plain', value);
    element.dispatchEvent(
      new ClipboardEvent('paste', {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, text);
}

test('the Windows installer preserves practice after removal and reinstallation', async () => {
  expect(process.platform, 'NSIS installation is available only on Windows').toBe('win32');
  expect(process.env.GITHUB_ACTIONS, 'Use a temporary GitHub runner').toBe('true');
  expect(process.env.RUNNER_ENVIRONMENT, 'A GitHub-hosted runner is necessary').toBe(
    'github-hosted',
  );
  const installer = process.env.INTERVIEW_DESKTOP_INSTALLER;
  expect(installer, 'Select the generated NSIS executable').toBeTruthy();
  expect(process.env.APPDATA, 'Windows must supply its application-data directory').toBeTruthy();
  const root = await mkdtemp(join(tmpdir(), 'interview-nsis-'));
  const destination = join(root, 'Interview Workbench');
  const data = join(root, 'Practice data');
  await mkdir(data);
  const setup = join(root, 'setup.exe');
  await copyFile(installer!, setup);
  const executable = join(destination, 'Interview Workbench.exe');
  const uninstaller = join(destination, 'Uninstall Interview Workbench.exe');
  const markers: string[] = [];
  for (const name of ['Interview Workbench', 'interview-workbench']) {
    const folder = join(process.env.APPDATA!, name);
    expect(
      existsSync(folder),
      `The disposable profile must have no previous data at ${folder}`,
    ).toBe(false);
    await mkdir(folder);
    const marker = join(folder, 'installer-retention-probe.txt');
    await writeFile(marker, 'Keep application data after removal.');
    markers.push(marker);
  }
  async function nsis(action: 'install' | 'uninstall') {
    await execute(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-File',
        resolve('scripts/windows-installer-action.ps1'),
        '-Action',
        action,
        '-Executable',
        action === 'install' ? setup : uninstaller,
        '-Destination',
        destination,
        '-TestRoot',
        root,
      ],
      { timeout: 90_000, windowsHide: true },
    );
  }
  async function retained() {
    for (const marker of markers)
      expect(await readFile(marker, 'utf8'), `Removal must retain ${marker}`).toBe(
        'Keep application data after removal.',
      );
  }
  let app: ElectronApplication | undefined;
  let needsCleanup = false;
  const previousExecutable = process.env.INTERVIEW_DESKTOP_EXECUTABLE;
  const previousPython = process.env.INTERVIEW_DESKTOP_PYTHON;
  process.env.INTERVIEW_DESKTOP_EXECUTABLE = executable;
  process.env.INTERVIEW_DESKTOP_PYTHON = join(root, 'host-python-must-not-be-used.exe');
  try {
    needsCleanup = true;
    await nsis('install');
    expect((await stat(executable)).isFile()).toBe(true);
    app = await launch(data);
    let page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    const runtime = await app.evaluate(({ app }) => ({
      packaged: app.isPackaged,
      architecture: process.arch,
      resources: process.resourcesPath,
    }));
    expect(runtime).toMatchObject({ packaged: true, architecture: 'x64' });
    expect(relative(destination, runtime.resources)).toBe('resources');
    expect((await page.evaluate(() => window.interview.snapshot())).settings.provider).toBe(
      'disabled',
    );
    await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
    await expect(page.getByTestId('code-editor')).toBeVisible();
    const code = '# Installer retention test.\n';
    await pasteCode(page, code);
    await expect
      .poll(async () => (await page.evaluate(() => window.interview.snapshot())).sessions[0]?.code)
      .toBe(code);
    await page.getByRole('button', { name: 'System design', exact: true }).click();
    await page
      .getByRole('button', { name: /Link Alias Service/ })
      .first()
      .click();
    const notes = 'Keep this design requirement after installer removal and reinstallation.';
    await page.getByRole('textbox', { name: 'Requirements', exact: true }).fill(notes);
    await page.getByRole('button', { name: '+ Client', exact: true }).click();
    const selected = await page.evaluate(() => window.interview.snapshot());
    const draftPath = join(
      data,
      'design',
      selected.workspaceId,
      selected.activeDesignSessionId!,
      'draft.json',
    );
    await app.close();
    app = undefined;
    const workspace = await readFile(join(data, 'workspace.json'));
    const draft = await readFile(draftPath);
    await nsis('uninstall');
    needsCleanup = false;
    await expect
      .poll(() => existsSync(executable), { message: 'Uninstall must remove the app executable' })
      .toBe(false);
    expect(await readFile(join(data, 'workspace.json'))).toEqual(workspace);
    expect(await readFile(draftPath)).toEqual(draft);
    await retained();

    needsCleanup = true;
    await nsis('install');
    expect(await readFile(join(data, 'workspace.json'))).toEqual(workspace);
    expect(await readFile(draftPath)).toEqual(draft);
    app = await launch(data);
    page = await app.firstWindow();
    await expect(page.getByRole('textbox', { name: 'Requirements', exact: true })).toHaveValue(
      notes,
      { timeout: 20_000 },
    );
    const restored = await page.evaluate(
      (id) => window.interview.loadDesignDraft(id),
      selected.activeDesignSessionId!,
    );
    const savedDraft = JSON.parse(draft.toString());
    expect(restored.notes).toEqual(savedDraft.notes);
    expect(restored.scene.elements).toEqual(savedDraft.scene.elements);
    await page.getByRole('button', { name: 'Coding', exact: true }).click();
    await expect(page.getByTestId('code-editor')).toBeVisible();
    expect((await page.evaluate(() => window.interview.snapshot())).sessions[0]?.code).toBe(code);
    await app.close();
    app = undefined;
    await nsis('uninstall');
    needsCleanup = false;
    await expect.poll(() => existsSync(executable)).toBe(false);
    await retained();
  } finally {
    await app?.close().catch(() => {});
    if (needsCleanup && existsSync(uninstaller))
      await nsis('uninstall').catch(async (error) => {
        await test.info().attach('installer-cleanup-error', {
          body: String(error),
          contentType: 'text/plain',
        });
      });
    if (previousExecutable === undefined) delete process.env.INTERVIEW_DESKTOP_EXECUTABLE;
    else process.env.INTERVIEW_DESKTOP_EXECUTABLE = previousExecutable;
    if (previousPython === undefined) delete process.env.INTERVIEW_DESKTOP_PYTHON;
    else process.env.INTERVIEW_DESKTOP_PYTHON = previousPython;
  }
});
