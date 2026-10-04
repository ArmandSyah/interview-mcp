import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalStore } from '../src/main/storage';
import type { PracticeSession } from '../src/shared/types';

describe('workspace persistence', () => {
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
});
