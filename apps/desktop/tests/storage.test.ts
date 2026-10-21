import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalStore } from '../src/main/storage';
import type { PracticeSession } from '../src/shared/types';

describe('workspace persistence', () => {
  it('backs up version 1 before an atomic migration and does not migrate twice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'interview-store-'));
    const store = new LocalStore(root);
    await store.load();
    const scope = store.scope();
    store.workspace(scope).activeProblemId = '0001-test';
    const legacy = { ...store.state, version: 1 };
    const contents = JSON.stringify(legacy);
    await writeFile(join(root, 'workspace.json'), contents);
    const migrated = new LocalStore(root);
    await migrated.load();
    expect(migrated.state.version).toBe(2);
    expect(migrated.workspace(scope).activeProblemId).toBe('0001-test');
    const backups = await readdir(join(root, 'backups'));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(root, 'backups', backups[0]), 'utf8')).toBe(contents);
    await new LocalStore(root).load();
    expect(await readdir(join(root, 'backups'))).toHaveLength(1);
  });
  it('saves drafts, sessions and active problem across restarts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'interview-store-'));
    const store = new LocalStore(root);
    await store.load();
    const scope = store.scope();
    const session: PracticeSession = {
      problem: { id: '0001-test', title: 'Test', difficulty: 'easy', tags: [], pattern_tags: [] },
      attemptId: 'attempt',
      code: '# my draft',
      description: 'Description',
      chat: [],
      result: null,
      resultStale: false,
      submitted: false,
      hintDepth: 0,
      updatedAt: 1,
    };
    store.workspace(scope).sessions.push(session);
    store.workspace(scope).activeProblemId = session.problem.id;
    await store.saveCode(scope, session);
    const restored = new LocalStore(root);
    await restored.load();
    expect(restored.workspace(scope).sessions[0].code).toBe('# my draft');
    expect(restored.workspace(scope).activeProblemId).toBe('0001-test');
    expect(await readFile(store.path(scope, '0001-test'), 'utf8')).toBe('# my draft');
  });
  it('rejects traversal and separates remote keys and servers', async () => {
    const store = new LocalStore(await mkdtemp(join(tmpdir(), 'interview-store-')));
    await store.load();
    expect(() => store.path(store.scope(), '../../secret')).toThrow('Invalid workspace path');
    store.state.settings.connection = 'remote';
    store.state.settings.mcpUrl = 'https://one.invalid/mcp';
    const first = store.scope('key-one');
    expect(store.scope('key-two')).not.toBe(first);
    store.state.settings.mcpUrl = 'https://two.invalid/mcp';
    expect(store.scope('key-one')).not.toBe(first);
  });
  it('does not replace damaged saved state with an empty workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'interview-store-'));
    await writeFile(join(root, 'workspace.json'), '{broken');
    const store = new LocalStore(root);
    await expect(store.load()).rejects.toThrow('not been overwritten');
    await expect(store.persist()).rejects.toThrow('saving is disabled');
    expect(await readFile(join(root, 'workspace.json'), 'utf8')).toBe('{broken');
  });
  it('keeps account drafts across token refresh, restart, and offline access without moving files', async () => {
    const store = new LocalStore(await mkdtemp(join(tmpdir(), 'interview-account-store-')));
    await store.load();
    store.state.settings.connection = 'remote';
    store.state.settings.mcpUrl = 'https://example.supabase.co/functions/v1/interview-mcp';
    const account = {
      userId: '11111111-1111-4111-8111-111111111111',
      issuer: 'https://example.supabase.co/auth/v1',
    };
    const old = store.scope('token-one');
    store.workspace(old).activeProblemId = '0001-test';
    expect(store.bindAccount('token-one', account)).toBe(old);
    expect(store.bindAccount('token-two', account)).toBe(old);
    await store.persist();
    const restored = new LocalStore(store.root);
    await restored.load();
    expect(restored.scope('token-two')).toBe(old);
    expect(restored.workspace(restored.scope('token-two')).activeProblemId).toBe('0001-test');
    const other = { ...account, userId: '22222222-2222-4222-8222-222222222222' };
    expect(restored.bindAccount('token-three', other)).not.toBe(old);
    // A credential reassigned to another verified account must not expose old drafts.
    expect(restored.bindAccount('token-two', other)).not.toBe(old);
    expect(restored.workspace(old).activeProblemId).toBe('0001-test');
    restored.state.settings.mcpUrl = 'https://other.supabase.co/functions/v1/interview-mcp';
    expect(restored.scope('token-one', account)).not.toBe(old);
    expect(await readFile(join(store.root, 'workspace.json'), 'utf8')).not.toContain('token-one');
  });
  it.each([
    { managedSandbox: 'yes' },
    { managedSandbox: true, pistonUrl: 'http://127.0.0.1:2999' },
  ])('rejects invalid persisted sandbox opt-in without overwriting it: %j', async (settings) => {
    const root = await mkdtemp(join(tmpdir(), 'interview-store-'));
    const original = new LocalStore(root);
    await original.load();
    const contents = JSON.stringify({
      ...original.state,
      settings: { ...original.state.settings, ...settings },
    });
    await writeFile(join(root, 'workspace.json'), contents);
    const restored = new LocalStore(root);
    await expect(restored.load()).rejects.toThrow('not been overwritten');
    await expect(restored.persist()).rejects.toThrow('saving is disabled');
    expect(await readFile(join(root, 'workspace.json'), 'utf8')).toBe(contents);
  });
});
