import { expect, test } from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';
import { accountServer, connectAccount, pasteAccountDraft } from './account-fixture';

test('token replacement retains one account and account changes keep drafts in different workspaces', async () => {
  const server = await accountServer();
  const data = await mkdtemp(join(tmpdir(), 'interview-account-ui-'));
  let app = await launch(data);
  try {
    let page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await connectAccount(page, server.url, 'fixture-alice-old');
    await page.getByRole('button', { name: /Account fixture/ }).click();
    await pasteAccountDraft(page, '# Alice private draft\n');
    const alice = (await page.evaluate(() => window.interview.snapshot())).sessions;
    await connectAccount(page, server.url, 'fixture-alice-new');
    expect((await page.evaluate(() => window.interview.snapshot())).sessions).toEqual(alice);
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('Alice private draft');
    await connectAccount(page, server.url, 'fixture-bob');
    expect((await page.evaluate(() => window.interview.snapshot())).sessions).toEqual([]);
    await expect(page.getByText('Alice private draft', { exact: false })).toHaveCount(0);
    await page.getByRole('button', { name: /Account fixture/ }).click();
    await pasteAccountDraft(page, '# Bob private draft\n');
    const bob = (await page.evaluate(() => window.interview.snapshot())).sessions;
    await connectAccount(page, server.url, 'fixture-alice-new');
    expect((await page.evaluate(() => window.interview.snapshot())).sessions).toEqual(alice);
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('Alice private draft');
    const editor = page.getByRole('textbox', { name: 'Python solution editor' });
    await editor.focus();
    await page.keyboard.press('ControlOrMeta+z');
    // A settings save flushes the undo edit before the ownership check.
    await connectAccount(page, server.url, 'fixture-alice-new');
    expect(
      (await page.evaluate(() => window.interview.snapshot())).sessions[0].code,
      'Undo can restore Alice text, but must not insert Bob text',
    ).toMatch(/^# [Aa]lice (private draft|starter)\n$/);
    await pasteAccountDraft(page, alice[0].code);
    expect(errors).toEqual([]);
    await app.close();
    app = await launch(data);
    page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Open settings' })).toBeEnabled({
      timeout: 20_000,
    });
    // Some test hosts have no OS vault. Enter the fixture token again in that case.
    await connectAccount(page, server.url, 'fixture-bob');
    expect((await page.evaluate(() => window.interview.snapshot())).sessions).toEqual(bob);
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('Bob private draft');
    const stored = JSON.parse(await readFile(join(data, 'workspace.json'), 'utf8'));
    const scopes = Object.values(stored.accountScopes) as string[];
    expect(new Set(scopes).size).toBe(2);
    const files = await Promise.all(
      scopes.map((scope) =>
        readFile(join(data, 'practice', scope, 'fixture-account', 'solution.py'), 'utf8'),
      ),
    );
    expect(files.sort()).toEqual(['# Alice private draft\n', '# Bob private draft\n']);
  } finally {
    await app.close().catch(() => {});
    await server.close();
  }
});

for (const failure of ['identity', 'catalog'] as const) {
  test(`${failure} failure during an account change does not display the previous account`, async () => {
    const server = await accountServer();
    const app = await launch(await mkdtemp(join(tmpdir(), 'interview-account-failure-')));
    try {
      const page = await app.firstWindow();
      await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
      await connectAccount(page, server.url, 'fixture-alice');
      await page.getByRole('button', { name: /Account fixture/ }).click();
      await pasteAccountDraft(page, '# Alice draft must not appear for Bob\n');
      const alice = (await page.evaluate(() => window.interview.snapshot())).sessions;
      server.fail(failure);
      server.holdIdentity();
      const change = connectAccount(page, server.url, 'fixture-bob');
      await expect
        .poll(() =>
          server.requests.filter(
            (item) => item.name === 'get_connection_identity' && item.account === 'bob',
          ),
        )
        .toHaveLength(1);
      const pending = await page.evaluate(() => window.interview.snapshot());
      expect(pending).toMatchObject({
        busy: true,
        connection: 'connecting',
        sessions: [],
        problems: [],
        progress: '',
      });
      await expect(
        page.getByRole('dialog').getByRole('button', { name: 'Close settings' }),
      ).toBeDisabled();
      server.releaseIdentity();
      await change;
      const failed = await page.evaluate(() => window.interview.snapshot());
      expect(failed).toMatchObject({
        busy: false,
        connection: 'disconnected',
        sessions: [],
        problems: [],
        designProblems: [],
        installedPacks: [],
        progress: '',
      });
      expect(failed.error).toBeTruthy();
      await expect(page.getByText('MCP disconnected', { exact: true })).toBeVisible();
      await expect(page.locator('.monaco-editor')).toHaveCount(0);
      server.fail(null);
      await connectAccount(page, server.url, 'fixture-bob');
      expect((await page.evaluate(() => window.interview.snapshot())).sessions).toEqual([]);
      await page.getByRole('button', { name: /Account fixture/ }).click();
      await expect(page.locator('.monaco-editor .view-lines')).toContainText('bob starter');
      await connectAccount(page, server.url, 'fixture-alice');
      expect((await page.evaluate(() => window.interview.snapshot())).sessions).toEqual(alice);
      await expect(page.locator('.monaco-editor .view-lines')).toContainText(
        'Alice draft must not appear for Bob',
      );
    } finally {
      server.releaseIdentity();
      await app.close().catch(() => {});
      await server.close();
    }
  });
}

test('unsent chat text stays with its account across token replacement and account changes', async () => {
  const server = await accountServer();
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-account-composer-')));
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await connectAccount(page, server.url, 'fixture-alice', 'ollama');
    const composer = page.getByRole('textbox', { name: 'Message the coach' });
    await composer.fill('Alice unsent question');
    await connectAccount(page, server.url, 'fixture-alice-replacement');
    await expect(composer).toHaveValue('Alice unsent question');
    await connectAccount(page, server.url, 'fixture-bob');
    await expect(composer).toHaveValue('');
    await composer.fill('Bob unsent question');
    await connectAccount(page, server.url, 'fixture-alice-replacement');
    await expect(composer).toHaveValue('Alice unsent question');
    await connectAccount(page, server.url, 'fixture-bob');
    await expect(composer).toHaveValue('Bob unsent question');
  } finally {
    await app.close().catch(() => {});
    await server.close();
  }
});

test('removing the account credential disconnects without deleting the account draft', async () => {
  const server = await accountServer();
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-account-remove-')));
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await connectAccount(page, server.url, 'fixture-alice');
    await page.getByRole('button', { name: /Account fixture/ }).click();
    await pasteAccountDraft(page, '# Keep this account draft\n');
    const alice = (await page.evaluate(() => window.interview.snapshot())).sessions;
    await page.getByRole('button', { name: 'Open settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Workbench settings' });
    await dialog.getByRole('checkbox', { name: 'Remove saved MCP key' }).check();
    await dialog.getByRole('button', { name: 'Save & connect' }).click();
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => window.interview.snapshot())).toMatchObject({
      connection: 'disconnected',
      sessions: [],
      settings: { hasMcpKey: false },
    });
    await connectAccount(page, server.url, 'fixture-alice');
    expect((await page.evaluate(() => window.interview.snapshot())).sessions).toEqual(alice);
  } finally {
    await app.close().catch(() => {});
    await server.close();
  }
});
