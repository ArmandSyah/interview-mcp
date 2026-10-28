import { expect, test, type Page } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';
import { accountServer, connectAccount } from './account-fixture';
import { gateIpc } from './ipc-gate';

async function openDesign(page: Page) {
  const snapshot = await page.evaluate(() => window.interview.snapshot());
  if (snapshot.mode !== 'design')
    await page.getByRole('button', { name: 'System design', exact: true }).click();
  await page
    .getByRole('button', { name: /Account design fixture/ })
    .first()
    .click();
  await expect(page.getByRole('textbox', { name: 'Requirements', exact: true })).toBeVisible();
}

async function savedDesign(page: Page) {
  return page.evaluate(async () => {
    const snapshot = await window.interview.snapshot();
    return {
      snapshot,
      draft: await window.interview.loadDesignDraft(snapshot.activeDesignSessionId!),
    };
  });
}

test('design notes and canvas stay with their account across token replacement, account changes, and restart', async () => {
  const server = await accountServer(undefined, { design: true });
  const data = await mkdtemp(join(tmpdir(), 'interview-design-accounts-'));
  let app = await launch(data);
  try {
    let page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await connectAccount(page, server.url, 'fixture-alice');
    await openDesign(page);
    await page
      .getByRole('textbox', { name: 'Requirements', exact: true })
      .fill('Alice design notes');
    await page.getByRole('button', { name: '+ Database', exact: true }).click();
    await expect(page.getByText(/Saved locally/)).toBeVisible();
    const alice = await savedDesign(page);
    expect(alice.draft.scene.elements.some((element) => element.text === 'Database')).toBe(true);
    await connectAccount(page, server.url, 'fixture-alice-replacement');
    await expect(page.getByRole('textbox', { name: 'Requirements', exact: true })).toHaveValue(
      'Alice design notes',
    );
    expect((await savedDesign(page)).snapshot.workspaceId).toBe(alice.snapshot.workspaceId);
    expect((await savedDesign(page)).snapshot.activeDesignSessionId).toBe(
      alice.snapshot.activeDesignSessionId,
    );
    await connectAccount(page, server.url, 'fixture-bob');
    await openDesign(page);
    await expect(page.getByRole('textbox', { name: 'Requirements', exact: true })).toHaveValue('');
    await page.getByRole('textbox', { name: 'Requirements', exact: true }).fill('Bob design notes');
    await page.getByRole('button', { name: '+ Cache', exact: true }).click();
    await expect(page.getByText(/Saved locally/)).toBeVisible();
    const bob = await savedDesign(page);
    expect(bob.snapshot.workspaceId).not.toBe(alice.snapshot.workspaceId);
    expect(bob.snapshot.activeDesignSessionId).not.toBe(alice.snapshot.activeDesignSessionId);
    expect(bob.draft.scene.elements.some((element) => element.text === 'Cache')).toBe(true);
    expect(bob.draft.scene.elements.some((element) => element.text === 'Database')).toBe(false);
    await connectAccount(page, server.url, 'fixture-alice-replacement');
    await expect(page.getByRole('textbox', { name: 'Requirements', exact: true })).toHaveValue(
      'Alice design notes',
    );
    expect((await savedDesign(page)).draft.scene.elements).toEqual(alice.draft.scene.elements);
    await app.close();
    app = await launch(data);
    page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Open settings' })).toBeEnabled({
      timeout: 20_000,
    });
    await connectAccount(page, server.url, 'fixture-bob');
    await expect(page.getByRole('textbox', { name: 'Requirements', exact: true })).toHaveValue(
      'Bob design notes',
    );
    expect((await savedDesign(page)).draft.scene.elements).toEqual(bob.draft.scene.elements);
  } finally {
    await app.close().catch(() => {});
    await server.close();
  }
});

test('unsent design questions stay with their account through token replacement, account changes, and mode changes', async () => {
  const server = await accountServer(undefined, { design: true });
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-design-composer-')));
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await connectAccount(page, server.url, 'fixture-bob', 'ollama');
    await openDesign(page);
    await connectAccount(page, server.url, 'fixture-alice', 'ollama');
    await openDesign(page);
    await page.getByRole('button', { name: 'coach', exact: true }).click();
    const composer = page.getByRole('textbox', { name: 'Message the design coach' });
    await composer.fill('Alice unsent design question');
    await connectAccount(page, server.url, 'fixture-alice-replacement');
    await page.getByRole('button', { name: 'coach', exact: true }).click();
    await expect
      .soft(composer, 'Token replacement must keep the same account question')
      .toHaveValue('Alice unsent design question');
    await composer.fill('Alice unsent design question');
    await connectAccount(page, server.url, 'fixture-bob');
    await page.getByRole('button', { name: 'coach', exact: true }).click();
    await expect.soft(composer, 'Bob must not see Alice unsent question').toHaveValue('');
    await composer.fill('Bob unsent design question');
    await connectAccount(page, server.url, 'fixture-alice-replacement');
    await page.getByRole('button', { name: 'coach', exact: true }).click();
    await expect
      .soft(composer, 'Alice must get her question, not Bob question')
      .toHaveValue('Alice unsent design question');
    await composer.fill('Alice unsent design question');
    await page.getByRole('button', { name: 'Coding', exact: true }).click();
    const coding = page.getByRole('textbox', { name: 'Message the coach' });
    await expect(coding).toHaveValue('');
    await coding.fill('Alice coding question');
    await page.getByRole('button', { name: 'System design', exact: true }).click();
    await page.getByRole('button', { name: 'coach', exact: true }).click();
    await expect
      .soft(
        composer,
        'A mode change must keep the design question separate from the coding question',
      )
      .toHaveValue('Alice unsent design question');
    await connectAccount(page, server.url, 'fixture-bob');
    await page.getByRole('button', { name: 'coach', exact: true }).click();
    await expect.soft(composer).toHaveValue('Bob unsent design question');
  } finally {
    await app.close().catch(() => {});
    await server.close();
  }
});

for (const failure of ['identity', 'catalog'] as const) {
  test(`design ${failure} failure hides the previous account and preserves its saved draft`, async () => {
    const server = await accountServer(undefined, { design: true });
    const app = await launch(await mkdtemp(join(tmpdir(), 'interview-design-account-failure-')));
    try {
      const page = await app.firstWindow();
      await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
      await connectAccount(page, server.url, 'fixture-alice');
      await openDesign(page);
      await page
        .getByRole('textbox', { name: 'Requirements', exact: true })
        .fill('Alice private design notes');
      await page.getByRole('button', { name: '+ Database', exact: true }).click();
      await expect(page.getByText(/Saved locally/)).toBeVisible();
      const alice = await savedDesign(page);
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
      expect(await page.evaluate(() => window.interview.snapshot())).toMatchObject({
        busy: true,
        connection: 'connecting',
        designSessions: [],
        activeDesignSessionId: null,
      });
      server.releaseIdentity();
      await change;
      expect(await page.evaluate(() => window.interview.snapshot())).toMatchObject({
        busy: false,
        connection: 'disconnected',
        designSessions: [],
        activeDesignSessionId: null,
        designProblems: [],
      });
      await expect(page.getByTestId('design-canvas').locator('.excalidraw')).toHaveCount(0);
      await expect(page.getByRole('textbox', { name: 'Requirements', exact: true })).toHaveCount(0);
      await expect(
        page.getByRole('alert').filter({
          hasText:
            failure === 'identity'
              ? 'Cannot verify the remote account identity'
              : 'Fixture catalog failure',
        }),
      ).toBeVisible();
      await page.screenshot({
        path: `test-results/design-account-${failure}-error.png`,
        fullPage: true,
      });
      server.fail(null);
      await connectAccount(page, server.url, 'fixture-bob');
      await openDesign(page);
      await expect(page.getByRole('textbox', { name: 'Requirements', exact: true })).toHaveValue(
        '',
      );
      expect((await savedDesign(page)).draft.scene.elements).toEqual([]);
      await connectAccount(page, server.url, 'fixture-alice');
      await expect(page.getByRole('textbox', { name: 'Requirements', exact: true })).toHaveValue(
        'Alice private design notes',
      );
      const restored = await savedDesign(page);
      expect(restored.snapshot.activeDesignSessionId).toBe(alice.snapshot.activeDesignSessionId);
      expect(restored.draft.scene.elements).toEqual(alice.draft.scene.elements);
    } finally {
      server.releaseIdentity();
      await app.close().catch(() => {});
      await server.close();
    }
  });
}

for (const result of ['success', 'failure'] as const) {
  test(`a late design load ${result} cannot replace a different account draft`, async () => {
    const server = await accountServer(undefined, { design: true });
    const app = await launch(await mkdtemp(join(tmpdir(), 'interview-design-late-account-')));
    let gate: Awaited<ReturnType<typeof gateIpc>> | undefined;
    try {
      const page = await app.firstWindow();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
      await connectAccount(page, server.url, 'fixture-alice');
      await openDesign(page);
      await page
        .getByRole('textbox', { name: 'Requirements', exact: true })
        .fill('Alice saved notes');
      await expect(page.getByText(/Saved locally/)).toBeVisible();
      const alice = await savedDesign(page);
      await connectAccount(page, server.url, 'fixture-bob');
      await openDesign(page);
      await page
        .getByRole('textbox', { name: 'Requirements', exact: true })
        .fill('Bob saved notes');
      await expect(page.getByText(/Saved locally/)).toBeVisible();
      const bob = await savedDesign(page);
      gate = await gateIpc(app, 'design-load', 'response');
      await connectAccount(page, server.url, 'fixture-alice');
      await expect.poll(gate.calls).toEqual([[alice.snapshot.activeDesignSessionId]]);
      await expect(page.getByText('Loading saved canvas…')).toBeVisible();
      await connectAccount(page, server.url, 'fixture-bob');
      await expect
        .poll(gate.calls)
        .toEqual([[alice.snapshot.activeDesignSessionId], [bob.snapshot.activeDesignSessionId]]);
      await gate.release(1);
      await expect(page.getByRole('textbox', { name: 'Requirements', exact: true })).toHaveValue(
        'Bob saved notes',
      );
      await gate.release(0, result === 'failure' ? 'Fixture old account load failure' : undefined);
      await gate.restore();
      gate = undefined;
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await expect(page.getByRole('textbox', { name: 'Requirements', exact: true })).toHaveValue(
        'Bob saved notes',
      );
      await expect(
        page.getByText('Fixture old account load failure', { exact: false }),
      ).toHaveCount(0);
      // A new edit and account change must save to Bob, not the old Alice load.
      await page
        .getByRole('textbox', { name: 'Requirements', exact: true })
        .fill('Bob notes after the late response');
      await connectAccount(page, server.url, 'fixture-alice');
      await expect(page.getByRole('textbox', { name: 'Requirements', exact: true })).toHaveValue(
        'Alice saved notes',
      );
      await connectAccount(page, server.url, 'fixture-bob');
      await expect(page.getByRole('textbox', { name: 'Requirements', exact: true })).toHaveValue(
        'Bob notes after the late response',
      );
      expect(errors).toEqual([]);
    } finally {
      await gate?.restore();
      await app.close().catch(() => {});
      await server.close();
    }
  });
}
