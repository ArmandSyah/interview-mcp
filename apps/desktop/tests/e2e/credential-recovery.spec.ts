import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch } from './desktop';
import { accountServer, connectAccount, pasteAccountDraft } from './account-fixture';

async function credentialEntry(directory: string) {
  const entry = join(directory, 'entry.cjs');
  // This fixture tests the failure/recovery UI. It does not test OS encryption.
  await writeFile(
    entry,
    `
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { safeStorage } = require('electron');
safeStorage.isEncryptionAvailable = () => true;
safeStorage.getSelectedStorageBackend = () => 'gnome_libsecret';
safeStorage.encryptString = value => Buffer.from('fixture-vault:' + value);
safeStorage.decryptString = bytes => {
  const text = bytes.toString();
  if (!text.startsWith('fixture-vault:')) throw new Error('Fixture credential cannot be unlocked');
  return text.slice('fixture-vault:'.length);
};
const original = ${JSON.stringify(resolve('dist/main/index.cjs'))};
const loaded = new Module(original, module);
loaded.filename = original;
loaded.paths = Module._nodeModulePaths(path.dirname(original));
loaded._compile(fs.readFileSync(original, 'utf8'), original);
`,
  );
  return entry;
}

for (const recovery of ['replace', 'remove'] as const) {
  test(`an unreadable credential permits ${recovery} without a change to saved practice`, async () => {
    test.skip(
      !!process.env.INTERVIEW_DESKTOP_EXECUTABLE,
      'Source fixture controls the credential store.',
    );
    const directory = await mkdtemp(join(tmpdir(), 'interview-credential-recovery-'));
    const data = join(directory, 'data');
    const entry = await credentialEntry(directory);
    let app = await launch(data, '', entry);
    try {
      let page = await app.firstWindow();
      await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
      await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
      await pasteAccountDraft(page, '# Keep this practice after credential recovery.\n');
      const original = await page.evaluate(() => window.interview.snapshot());
      await app.close();
      const file = join(data, 'workspace.json');
      const stored = JSON.parse(await readFile(file, 'utf8'));
      const unreadable = Buffer.from('fixture-unreadable-credential').toString('base64');
      stored.credentials.apiKey = unreadable;
      await writeFile(file, JSON.stringify(stored));
      const beforeRecovery = await readFile(file, 'utf8');
      app = await launch(data, '', entry);
      page = await app.firstWindow();
      const alert = page
        .getByRole('alert')
        .filter({ hasText: 'Saved credentials could not be unlocked. Re-enter them in Settings.' });
      await expect(alert).toBeVisible();
      const failed = await page.evaluate(() => window.interview.snapshot());
      expect(failed.connection).toBe('connected');
      expect(failed.sessions).toEqual(original.sessions);
      expect(failed.activeProblemId).toBe(original.activeProblemId);
      expect(failed.settings.hasApiKey).toBe(false);
      expect(failed.settings.secureStorage).toBe(true);
      expect(await readFile(file, 'utf8')).toBe(beforeRecovery);
      const replacement = 'fixture-replacement-api-key';
      await page.getByRole('button', { name: 'Open settings' }).click();
      let settings = page.getByRole('dialog', { name: 'Workbench settings' });
      await settings.getByLabel('Provider').selectOption('anthropic');
      let key = settings.getByLabel('Claude API key', { exact: true });
      await expect(key).toHaveValue('');
      if (recovery === 'replace') await key.fill(replacement);
      else await settings.getByLabel('Remove saved API key', { exact: true }).check();
      await settings.getByLabel('Provider').selectOption('disabled');
      await settings.getByRole('button', { name: 'Save & connect' }).click();
      await expect(settings).toHaveCount(0, { timeout: 20_000 });
      await expect(alert).toHaveCount(0);
      const recovered = await page.evaluate(() => window.interview.snapshot());
      expect(recovered.settings.provider).toBe('disabled');
      expect(recovered.settings.hasApiKey).toBe(recovery === 'replace');
      expect(recovered.sessions).toEqual(original.sessions);
      expect(recovered.activeProblemId).toBe(original.activeProblemId);
      expect(JSON.stringify(recovered)).not.toContain(replacement);
      expect(JSON.stringify(recovered)).not.toContain(unreadable);
      const saved = JSON.parse(await readFile(file, 'utf8'));
      expect(saved.workspaces).toEqual(stored.workspaces);
      expect(saved.credentials).toEqual(
        recovery === 'replace'
          ? { apiKey: Buffer.from('fixture-vault:' + replacement).toString('base64') }
          : {},
      );
      await app.close();
      app = await launch(data, '', entry);
      page = await app.firstWindow();
      await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('.error-bar')).toHaveCount(0);
      const reopened = await page.evaluate(() => window.interview.snapshot());
      expect(reopened.sessions).toEqual(original.sessions);
      expect(reopened.settings.hasApiKey).toBe(recovery === 'replace');
      expect(reopened.settings.provider).toBe('disabled');
      expect(reopened.error).toBeNull();
      expect(JSON.stringify(reopened)).not.toContain(replacement);
      expect(JSON.stringify(reopened)).not.toContain(unreadable);
      await page.getByRole('button', { name: 'Open settings' }).click();
      settings = page.getByRole('dialog', { name: 'Workbench settings' });
      key = settings.getByLabel('Claude API key', { exact: true });
      await settings.getByLabel('Provider').selectOption('anthropic');
      await expect(key).toHaveValue('');
      await expect(key).toHaveAttribute(
        'placeholder',
        recovery === 'replace' ? 'Key saved — leave blank to keep it' : 'Paste your own API key',
      );
    } finally {
      await app.close().catch(() => {});
    }
  });
}

test('an unreadable MCP credential hides account data until the same account reconnects', async () => {
  test.skip(
    !!process.env.INTERVIEW_DESKTOP_EXECUTABLE,
    'Source fixture controls the credential store.',
  );
  const server = await accountServer();
  const directory = await mkdtemp(join(tmpdir(), 'interview-account-credential-'));
  const data = join(directory, 'data');
  const entry = await credentialEntry(directory);
  let app = await launch(data, '', entry);
  try {
    let page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await connectAccount(page, server.url, 'fixture-alice-old', undefined, 20_000);
    await page
      .getByRole('button', { name: /Account fixture/ })
      .first()
      .click();
    await pasteAccountDraft(page, '# Keep this account draft after credential recovery.\n');
    const original = await page.evaluate(() => window.interview.snapshot());
    await app.close();
    const file = join(data, 'workspace.json');
    const stored = JSON.parse(await readFile(file, 'utf8'));
    stored.credentials.mcpKey = Buffer.from('fixture-unreadable-account-credential').toString(
      'base64',
    );
    await writeFile(file, JSON.stringify(stored));
    const beforeRecovery = await readFile(file, 'utf8');
    const requests = server.requests.length;
    app = await launch(data, '', entry);
    page = await app.firstWindow();
    await expect(
      page
        .getByRole('alert')
        .filter({ hasText: 'Saved credentials could not be unlocked. Re-enter them in Settings.' }),
    ).toBeVisible();
    const failed = await page.evaluate(() => window.interview.snapshot());
    expect(failed.connection).toBe('disconnected');
    expect(failed.settings.hasMcpKey).toBe(false);
    expect(failed.sessions).toEqual([]);
    expect(failed.activeProblemId).toBeNull();
    expect(failed.workspaceId).not.toBe(original.workspaceId);
    expect(server.requests).toHaveLength(requests);
    await expect(page.getByTestId('code-editor')).toHaveCount(0);
    expect(await readFile(file, 'utf8')).toBe(beforeRecovery);
    await connectAccount(page, server.url, 'fixture-alice-new', undefined, 20_000);
    await expect(page.locator('.error-bar')).toHaveCount(0);
    const recovered = await page.evaluate(() => window.interview.snapshot());
    expect(recovered.connection).toBe('connected');
    expect(recovered.error).toBeNull();
    expect(recovered.settings.hasMcpKey).toBe(true);
    expect(recovered.workspaceId).toBe(original.workspaceId);
    expect(recovered.sessions).toEqual(original.sessions);
    expect(recovered.activeProblemId).toBe(original.activeProblemId);
    expect(JSON.stringify(recovered)).not.toContain('fixture-alice-new');
    await expect(page.locator('.monaco-editor .view-lines')).toContainText(
      'Keep this account draft after credential recovery.',
    );
    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(saved.workspaces[original.workspaceId]).toEqual(stored.workspaces[original.workspaceId]);
    await app.close();
    app = await launch(data, '', entry);
    page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 1 problems')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.error-bar')).toHaveCount(0);
    const reopened = await page.evaluate(() => window.interview.snapshot());
    expect(reopened.workspaceId).toBe(original.workspaceId);
    expect(reopened.sessions).toEqual(original.sessions);
  } finally {
    await app.close().catch(() => {});
    await server.close();
  }
});

test('repairing an unreadable AI key preserves the healthy account credential and saved work', async () => {
  test.skip(
    !!process.env.INTERVIEW_DESKTOP_EXECUTABLE,
    'Source fixture controls the credential store.',
  );
  const server = await accountServer();
  const directory = await mkdtemp(join(tmpdir(), 'interview-mixed-credentials-'));
  const data = join(directory, 'data');
  const entry = await credentialEntry(directory);
  let app = await launch(data, '', entry);
  try {
    let page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await connectAccount(page, server.url, 'fixture-alice-healthy', undefined, 20_000);
    await page
      .getByRole('button', { name: /Account fixture/ })
      .first()
      .click();
    await pasteAccountDraft(page, '# Keep this account when the AI key fails.\n');
    const original = await page.evaluate(() => window.interview.snapshot());
    await app.close();
    const file = join(data, 'workspace.json');
    const stored = JSON.parse(await readFile(file, 'utf8'));
    stored.credentials.apiKey = Buffer.from('fixture-unreadable-ai-key').toString('base64');
    await writeFile(file, JSON.stringify(stored));
    app = await launch(data, '', entry);
    page = await app.firstWindow();
    await expect(
      page
        .getByRole('alert')
        .filter({ hasText: 'Saved credentials could not be unlocked. Re-enter them in Settings.' }),
    ).toBeVisible();
    const failed = await page.evaluate(() => window.interview.snapshot());
    expect(failed.connection).toBe('connected');
    expect(failed.settings.hasMcpKey).toBe(true);
    expect(failed.settings.hasApiKey).toBe(false);
    expect(failed.workspaceId).toBe(original.workspaceId);
    expect(failed.sessions).toEqual(original.sessions);
    expect(JSON.parse(await readFile(file, 'utf8')).credentials).toEqual(stored.credentials);
    await page.getByRole('button', { name: 'Open settings' }).click();
    const settings = page.getByRole('dialog', { name: 'Workbench settings' });
    await settings.getByLabel('Provider').selectOption('anthropic');
    await settings.getByLabel('Claude API key', { exact: true }).fill('fixture-repaired-ai-key');
    await settings.getByLabel('Provider').selectOption('disabled');
    await settings.getByRole('button', { name: 'Save & connect' }).click();
    await expect(settings).toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator('.error-bar')).toHaveCount(0);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(saved.credentials.mcpKey).toBe(stored.credentials.mcpKey);
    expect(saved.workspaces[original.workspaceId]).toEqual(stored.workspaces[original.workspaceId]);
    const repaired = await page.evaluate(() => window.interview.snapshot());
    expect(repaired.settings.hasApiKey).toBe(true);
    expect(repaired.settings.hasMcpKey).toBe(true);
    expect(repaired.settings.provider).toBe('disabled');
    expect(repaired.workspaceId).toBe(original.workspaceId);
    await app.close();
    app = await launch(data, '', entry);
    page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 1 problems')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.error-bar')).toHaveCount(0);
    const reopened = await page.evaluate(() => window.interview.snapshot());
    expect(reopened.workspaceId).toBe(original.workspaceId);
    expect(reopened.sessions).toEqual(original.sessions);
    expect(reopened.settings.hasMcpKey).toBe(true);
    expect(reopened.settings.hasApiKey).toBe(true);
    expect(reopened.settings.provider).toBe('disabled');
  } finally {
    await app.close().catch(() => {});
    await server.close();
  }
});
