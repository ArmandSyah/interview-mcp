import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { WorkbenchService, type Vault } from '../src/main/service';
import { LocalStore, defaultSettings } from '../src/main/storage';
import type { McpConnection } from '../src/main/mcp';
import type { Model } from '../src/main/providers';
import type { ManagedSandbox } from '../src/main/sandbox';
import type { AppEvent, Approval, Problem } from '../src/shared/types';

const problem: Problem = {
  id: '0001-test',
  title: 'Test',
  difficulty: 'easy',
  tags: [],
  pattern_tags: [],
};
const code = '# candidate-owned draft';
const memoryVault: Vault = {
  available: () => false,
  encrypt: () => {
    throw new Error('Not available');
  },
  decrypt: () => {
    throw new Error('Not available');
  },
};
async function fixture(
  model?: Model | (() => Model),
  vault = memoryVault,
  sandbox?: ManagedSandbox,
  onEvent?: (event: AppEvent) => void,
) {
  const store = new LocalStore(await mkdtemp(join(tmpdir(), 'interview-service-')));
  const events: AppEvent[] = [];
  const call = vi.fn(async (name: string, _args: Record<string, unknown>): Promise<unknown> => {
    if (name === 'list_problems') return [problem];
    if (name === 'get_progress') return 'Progress';
    if (name === 'start_problem')
      return {
        attempt_id: 'owned-attempt',
        mode: 'remote',
        files_to_create: [
          {
            relative_path: `${problem.id}/solution.py`,
            contents: code,
            sha256: createHash('sha256').update(code).digest('hex'),
          },
        ],
      };
    if (name === 'get_problem_description') return 'Fixture contract';
    if (name === 'get_hint') return { hint: 'One small hint' };
    if (name === 'get_practice_review') return { id: _args.item_id };
    if (name === 'submit_solution')
      return {
        completed: true,
        test_run: { all_passed: true, tests_total: 1, tests_passed: 1, results: [] },
      };
    if (name === 'run_tests')
      return { all_passed: false, tests_total: 1, tests_passed: 0, tests: [] };
    throw new Error(`Unexpected fixture call ${name}`);
  });
  const mcp = {
    accountIdentity: null as { userId: string; issuer: string } | null,
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    call,
    tools: ['get_hint', 'submit_solution'].map((name) => ({
      name,
      inputSchema: { type: 'object' },
    })),
  };
  const service = new WorkbenchService(
    store,
    mcp as unknown as McpConnection,
    vault,
    (event) => {
      events.push(event);
      onEvent?.(event);
    },
    typeof model === 'function' ? model : model ? () => model : undefined,
    sandbox,
  );
  await service.initialize();
  return { service, store, mcp, events };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

it.each(
  ['problem', 'mode'].flatMap((operation) =>
    [false, true].map((failure) => ({ operation, failure })),
  ),
)(
  '$operation selection preserves drafts and keeps its previous value on failure=$failure',
  async ({ operation, failure }) => {
    const { service, store } = await fixture();
    await service.startProblem(problem.id);
    const workspace = store.workspace(store.scope());
    const second = {
      ...structuredClone(workspace.sessions[0]),
      problem: { ...problem, id: '0002-test' },
      attemptId: 'second-attempt',
      code: '# second saved draft',
    };
    workspace.sessions.push(second);
    await store.saveCode(store.scope(), second);
    const earlier = deferred();
    const writing = deferred();
    const originalSave = store.saveCode.bind(store);
    vi.spyOn(store, 'saveCode').mockImplementationOnce(async (...args) => {
      await earlier.promise;
      await originalSave(...args);
    });
    const originalPersist = store.persist.bind(store);
    const persist = vi.spyOn(store, 'persist').mockImplementationOnce(async (...args) => {
      await writing.promise;
      await originalPersist(...args);
    });
    const first = service.saveCode(problem.id, '# edit before selection');
    const change = (
      operation === 'problem'
        ? service.activateProblem(second.problem.id)
        : service.setMode('design')
    ).then(
      () => null,
      (error: Error) => error.message,
    );
    const next = service.saveCode(second.problem.id, '# edit during selection');
    try {
      expect(persist).not.toHaveBeenCalled();
      earlier.resolve();
      await first;
      await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
      expect(service.snapshot()).toMatchObject({
        busy: true,
        mode: 'coding',
        activeProblemId: problem.id,
      });
      expect(service.snapshot().sessions[1].code).toBe('# second saved draft');
      if (failure) writing.reject(new Error('Fixture selection write failure'));
      else writing.resolve();
      expect(await change).toBe(failure ? 'Fixture selection write failure' : null);
      await next;
      const restored = new LocalStore(store.root);
      await restored.load();
      const saved = restored.workspace(store.scope());
      expect(saved.activeProblemId).toBe(
        operation === 'problem' && !failure ? second.problem.id : problem.id,
      );
      expect(saved.mode).toBe(operation === 'mode' && !failure ? 'design' : 'coding');
      expect(saved.sessions.map((item) => item.code)).toEqual([
        '# edit before selection',
        '# edit during selection',
      ]);
      expect(await readFile(store.path(store.scope(), second.problem.id), 'utf8')).toBe(
        '# edit during selection',
      );
    } finally {
      earlier.resolve();
      writing.resolve();
      await Promise.allSettled([first, change, next]);
      await service.close();
    }
  },
);

for (const failure of ['disk-replace', 'disk-remove', 'vault'] as const) {
  it(`settings ${failure} preserves settings, credentials, workspace, and connection`, async () => {
    const vault: Vault = {
      available: () => true,
      encrypt: (value) => Buffer.from(value).toString('base64'),
      decrypt: (value) => Buffer.from(value, 'base64').toString(),
    };
    const { service, store, mcp } = await fixture(undefined, vault);
    try {
      await service.updateSettings({
        ...defaultSettings,
        apiKey: 'fixture-old-api',
        mcpKey: 'fixture-old-mcp',
      });
      await service.startProblem(problem.id);
      const before = service.snapshot();
      const stored = structuredClone(store.state);
      const disk = await readFile(join(store.root, 'workspace.json'), 'utf8');
      const connections = mcp.connect.mock.calls.length;
      if (failure === 'vault') {
        vi.spyOn(vault, 'encrypt')
          .mockImplementationOnce(() => 'fixture-first-encrypted-value')
          .mockImplementationOnce(() => {
            throw new Error('Fixture encryption failure');
          });
      } else
        vi.spyOn(store, 'persist').mockRejectedValueOnce(
          new Error('Fixture settings write failure'),
        );
      const changes =
        failure === 'disk-remove'
          ? { clearApiKey: true, clearMcpKey: true }
          : { apiKey: 'fixture-new-api', mcpKey: 'fixture-new-mcp' };
      await expect(
        service.updateSettings({ ...defaultSettings, provider: 'ollama', ...changes }),
      ).rejects.toThrow(
        failure === 'vault' ? 'Fixture encryption failure' : 'Fixture settings write failure',
      );
      expect(
        service.snapshot(),
        'A rejected settings save must not change the active configuration',
      ).toEqual(before);
      expect(store.state).toEqual(stored);
      expect(await readFile(join(store.root, 'workspace.json'), 'utf8')).toBe(disk);
      expect(mcp.connect).toHaveBeenCalledTimes(connections);
      await service.reconnect();
      expect(mcp.connect).toHaveBeenLastCalledWith(defaultSettings, 'fixture-old-mcp');
      await service.updateSettings({ ...defaultSettings, provider: 'ollama', ...changes });
      expect(service.settings().provider).toBe('ollama');
      expect(service.settings().hasApiKey).toBe(failure !== 'disk-remove');
      expect(service.settings().hasMcpKey).toBe(failure !== 'disk-remove');
      expect(service.snapshot().sessions).toEqual(before.sessions);
    } finally {
      await service.close();
    }
  });
}

it.each([false, true])(
  'settings order earlier and queued code saves (failure=%s)',
  async (failure) => {
    const { service, store, mcp } = await fixture();
    await service.startProblem(problem.id);
    const earlier = deferred();
    const writing = deferred();
    const originalSave = store.saveCode.bind(store);
    const save = vi.spyOn(store, 'saveCode').mockImplementationOnce(async (...args) => {
      await earlier.promise;
      await originalSave(...args);
    });
    const originalPersist = store.persist.bind(store);
    const persist = vi.spyOn(store, 'persist').mockImplementationOnce(async (...args) => {
      await writing.promise;
      await originalPersist(...args);
    });
    const first = service.saveCode(problem.id, '# before settings');
    const change = service.updateSettings({ ...defaultSettings, provider: 'ollama' }).then(
      () => null,
      (error: Error) => error.message,
    );
    const next = service.saveCode(problem.id, '# during settings');
    try {
      expect(persist).not.toHaveBeenCalled();
      expect(save).toHaveBeenCalledTimes(1);
      earlier.resolve();
      await first;
      await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
      expect(service.settings().provider).toBe('disabled');
      expect(service.snapshot().sessions[0].code).toBe('# before settings');
      expect(mcp.connect).toHaveBeenCalledTimes(1);
      if (failure) writing.reject(new Error('Fixture settings write failure'));
      else writing.resolve();
      expect(await change).toBe(failure ? 'Fixture settings write failure' : null);
      await next;
      const restored = new LocalStore(store.root);
      await restored.load();
      expect(restored.state.settings.provider).toBe(failure ? 'disabled' : 'ollama');
      expect(restored.workspace(store.scope()).sessions[0].code).toBe('# during settings');
      expect(await readFile(store.path(store.scope(), problem.id), 'utf8')).toBe(
        '# during settings',
      );
    } finally {
      earlier.resolve();
      writing.resolve();
      await Promise.allSettled([first, change, next]);
      await service.close();
    }
  },
);

it('an earlier draft failure cancels settings changes and releases a later save', async () => {
  const { service, store, mcp } = await fixture();
  await service.startProblem(problem.id);
  const earlier = deferred();
  vi.spyOn(store, 'saveCode').mockReturnValueOnce(earlier.promise);
  const first = service
    .saveCode(problem.id, '# earlier failure')
    .catch((error: Error) => error.message);
  const change = service
    .updateSettings({ ...defaultSettings, provider: 'ollama' })
    .catch((error: Error) => error.message);
  const next = service.saveCode(problem.id, '# recovered draft');
  earlier.reject(new Error('Earlier draft failed'));
  expect(await first).toBe('Earlier draft failed');
  expect(await change).toBe('Earlier draft failed');
  await next;
  expect(service.settings().provider).toBe('disabled');
  expect(service.snapshot().sessions[0].code).toBe('# recovered draft');
  expect(mcp.connect).toHaveBeenCalledTimes(1);
  await service.close();
});

it.each([false, true])(
  'a queued draft cannot cross an account change (same account=%s)',
  async (sameAccount) => {
    const { service, store, mcp } = await fixture();
    const alice = {
      userId: '11111111-1111-4111-8111-111111111111',
      issuer: 'https://fixture.invalid/auth/v1',
    };
    mcp.accountIdentity = alice;
    const settings = {
      ...defaultSettings,
      connection: 'remote' as const,
      mcpUrl: 'https://fixture.invalid/mcp',
    };
    await service.updateSettings({ ...settings, mcpKey: 'fixture-alice-old' });
    await service.startProblem(problem.id);
    await service.saveCode(problem.id, '# Alice saved draft');
    const aliceScope = store.scope('fixture-alice-old');
    const writing = deferred();
    const original = store.persist.bind(store);
    const persist = vi.spyOn(store, 'persist').mockImplementationOnce(async (...args) => {
      await writing.promise;
      await original(...args);
    });
    mcp.connect.mockImplementationOnce(async () => {
      mcp.accountIdentity = sameAccount
        ? alice
        : { ...alice, userId: '22222222-2222-4222-8222-222222222222' };
    });
    const key = sameAccount ? 'fixture-alice-new' : 'fixture-bob';
    const change = service.updateSettings({ ...settings, mcpKey: key });
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
    const next = service.saveCode(problem.id, '# Alice queued draft').then(
      () => null,
      (error: Error) => error.message,
    );
    try {
      writing.resolve();
      await change;
      expect(await next).toBe(sameAccount ? null : 'Workspace changed. Retry the draft save.');
      const expected = sameAccount ? '# Alice queued draft' : '# Alice saved draft';
      expect(store.workspace(aliceScope).sessions[0].code).toBe(expected);
      expect(service.snapshot().sessions).toHaveLength(sameAccount ? 1 : 0);
      const restored = new LocalStore(store.root);
      await restored.load();
      expect(restored.workspace(aliceScope).sessions[0].code).toBe(expected);
      expect(await readFile(store.path(aliceScope, problem.id), 'utf8')).toBe(expected);
      expect(restored.scope(key) === aliceScope).toBe(sameAccount);
    } finally {
      writing.resolve();
      await Promise.allSettled([change, next]);
      await service.close();
    }
  },
);

it('an account mapping write failure preserves the stored mappings and closes the new connection', async () => {
  const { service, store, mcp } = await fixture();
  await service.startProblem(problem.id);
  const previous = service.snapshot().sessions;
  mcp.accountIdentity = {
    userId: '11111111-1111-4111-8111-111111111111',
    issuer: 'https://fixture.invalid/auth/v1',
  };
  const original = store.persist.bind(store);
  vi.spyOn(store, 'persist')
    .mockImplementationOnce(original)
    .mockRejectedValueOnce(new Error('Fixture account mapping failure'));
  await service.updateSettings({
    ...defaultSettings,
    connection: 'remote',
    mcpUrl: 'https://fixture.invalid/mcp',
    mcpKey: 'fixture-new-account',
  });
  expect(service.snapshot()).toMatchObject({
    connection: 'disconnected',
    sessions: [],
    problems: [],
    installedPacks: [],
    progress: '',
    error: 'Fixture account mapping failure',
  });
  expect(store.state.accountScopes).toBeUndefined();
  expect(store.state.credentialAccounts).toBeUndefined();
  expect(mcp.close).toHaveBeenCalledTimes(1);
  expect(
    Object.values(store.state.workspaces).some(
      (workspace) => JSON.stringify(workspace.sessions) === JSON.stringify(previous),
    ),
  ).toBe(true);
  await service.reconnect();
  expect(service.snapshot().connection).toBe('connected');
  expect(store.state.accountScopes).toBeDefined();
  const restored = new LocalStore(store.root);
  await restored.load();
  expect(restored.state.accountScopes).toEqual(store.state.accountScopes);
  await service.close();
});

it.each(['disk', 'stop', 'none'])(
  'sandbox disable commits settings before its stop operation (failure=%s)',
  async (failure) => {
    const sandbox = { stop: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    const { service, store, mcp } = await fixture(
      undefined,
      memoryVault,
      sandbox as unknown as ManagedSandbox,
    );
    store.state.settings.managedSandbox = true;
    await store.persist();
    if (failure === 'disk')
      vi.spyOn(store, 'persist').mockRejectedValueOnce(new Error('Fixture disk failure'));
    if (failure === 'stop') sandbox.stop.mockRejectedValueOnce(new Error('Fixture stop failure'));
    try {
      const result = await service.updateSettings(defaultSettings).then(
        () => null,
        (error: Error) => error.message,
      );
      expect(result).toBe(
        failure === 'disk'
          ? 'Fixture disk failure'
          : failure === 'stop'
            ? 'Settings saved. Cannot stop the local sandbox: Fixture stop failure'
            : null,
      );
      expect(sandbox.stop).toHaveBeenCalledTimes(failure === 'disk' ? 0 : 1);
      expect(mcp.connect).toHaveBeenCalledTimes(failure === 'disk' ? 1 : 2);
      const restored = new LocalStore(store.root);
      await restored.load();
      expect(restored.state.settings.managedSandbox).toBe(failure === 'disk');
      expect(service.settings().managedSandbox).toBe(failure === 'disk');
    } finally {
      await service.close();
    }
  },
);

for (const owner of ['welcome', 'coding'] as const) {
  it.each([false, true])(
    `${owner} history clear orders code saves and preserves history on failure=%s`,
    async (failure) => {
      const { service, store } = await fixture();
      await service.startProblem(problem.id);
      const workspace = store.workspace(store.scope());
      workspace.chat = [{ id: 'welcome', role: 'user', text: 'Welcome history', timestamp: 1 }];
      workspace.sessions[0].chat = [
        { id: 'coding', role: 'user', text: 'Coding history', timestamp: 2 },
      ];
      if (owner === 'welcome') workspace.activeProblemId = null;
      await store.persist();
      const history = structuredClone(
        owner === 'coding' ? workspace.sessions[0].chat : workspace.chat,
      );
      const earlier = deferred();
      const clearing = deferred();
      const originalSave = store.saveCode.bind(store);
      const save = vi.spyOn(store, 'saveCode').mockImplementationOnce(async (...args) => {
        await earlier.promise;
        await originalSave(...args);
      });
      const originalPersist = store.persist.bind(store);
      const persist = vi.spyOn(store, 'persist').mockImplementationOnce(async (...args) => {
        await clearing.promise;
        await originalPersist(...args);
      });
      const first = service.saveCode(problem.id, '# earlier edit');
      const clear = service.clearChat().then(
        () => null,
        (error: Error) => error.message,
      );
      const next = service.saveCode(problem.id, '# edit during clear');
      try {
        await Promise.resolve();
        expect(persist, 'clearChat must wait for the earlier saveCode call').not.toHaveBeenCalled();
        expect(save, 'The newer save must wait for clearChat').toHaveBeenCalledTimes(1);
        earlier.resolve();
        await first;
        await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
        const pending = service.snapshot();
        expect(
          owner === 'coding' ? pending.sessions[0].chat : pending.welcomeChat,
          'A pending clear must not remove live history',
        ).toEqual(history);
        expect(pending.sessions[0].code).toBe('# earlier edit');
        expect(pending.busy).toBe(true);
        if (failure) clearing.reject(new Error('Fixture history write failure'));
        else clearing.resolve();
        expect(await clear).toBe(failure ? 'Fixture history write failure' : null);
        await next;
        expect(save).toHaveBeenCalledTimes(2);
        const after = service.snapshot();
        expect(owner === 'coding' ? after.sessions[0].chat : after.welcomeChat).toEqual(
          failure ? history : [],
        );
        expect(
          owner === 'coding' ? after.welcomeChat[0].text : after.sessions[0].chat[0].text,
        ).toBe(owner === 'coding' ? 'Welcome history' : 'Coding history');
        expect(after.sessions[0].code).toBe('# edit during clear');
        expect(after.busy).toBe(false);
        const restored = new LocalStore(store.root);
        await restored.load();
        const disk = restored.workspace(store.scope());
        expect(owner === 'coding' ? disk.sessions[0].chat : disk.chat).toEqual(
          failure ? history : [],
        );
        expect(disk.sessions[0].code).toBe('# edit during clear');
        expect(await readFile(store.path(store.scope(), problem.id), 'utf8')).toBe(
          '# edit during clear',
        );
      } finally {
        earlier.resolve();
        clearing.resolve();
        await Promise.allSettled([first, clear, next]);
        await service.close();
      }
    },
  );
}

it('an earlier draft failure cancels history deletion and releases later draft saves', async () => {
  const { service, store } = await fixture();
  await service.startProblem(problem.id);
  await service.hint();
  const history = service.snapshot().sessions[0].chat;
  const earlier = deferred();
  vi.spyOn(store, 'saveCode').mockReturnValueOnce(earlier.promise);
  const first = service
    .saveCode(problem.id, '# failed earlier write')
    .catch((error: Error) => error.message);
  const clear = service.clearChat().catch((error: Error) => error.message);
  const next = service.saveCode(problem.id, '# recovered write');
  earlier.reject(new Error('Earlier draft failed'));
  expect(await first).toBe('Earlier draft failed');
  expect(await clear).toBe('Earlier draft failed');
  await next;
  expect(service.snapshot().sessions[0].chat).toEqual(history);
  expect(service.snapshot().sessions[0].code).toBe('# recovered write');
  await service.clearChat();
  expect(service.snapshot().sessions[0].chat).toEqual([]);
  await service.close();
});

it.each(
  ['history', 'settings'].flatMap((operation) =>
    [false, true].map((failure) => ({ operation, failure })),
  ),
)(
  'a recall draft waits for $operation and retains its result (failure=$failure)',
  async ({ operation, failure }) => {
    const { service, store } = await fixture();
    await service.startProblem(problem.id);
    await service.hint();
    const history = service.snapshot().sessions[0].chat;
    const disk = deferred();
    const original = store.persist.bind(store);
    vi.spyOn(store, 'persist').mockImplementationOnce(async (...args) => {
      await disk.promise;
      await original(...args);
    });
    const clear = (
      operation === 'history'
        ? service.clearChat()
        : service.updateSettings({ ...defaultSettings, provider: 'ollama' })
    ).then(
      () => null,
      (error: Error) => error.message,
    );
    const id = randomUUID();
    const draft = {
      reflection_id: randomUUID(),
      expected_version: 1,
      answer: `Recall during ${operation}`,
      takeaway: '',
      next_action: '',
      self_rating: 'needs_work' as const,
    };
    const save = service.saveReflectionDraft(id, draft);
    try {
      await Promise.resolve();
      expect(store.workspace(store.scope()).reflectionDrafts[id]).toBeUndefined();
      if (failure) disk.reject(new Error('State write failed'));
      else disk.resolve();
      expect(await clear).toBe(failure ? 'State write failed' : null);
      await save;
      const restored = new LocalStore(store.root);
      await restored.load();
      expect(restored.workspace(store.scope()).reflectionDrafts[id]).toEqual(draft);
      expect(restored.workspace(store.scope()).sessions[0].chat).toEqual(
        failure || operation === 'settings' ? history : [],
      );
      expect(restored.state.settings.provider).toBe(
        operation === 'settings' && !failure ? 'ollama' : 'disabled',
      );
    } finally {
      disk.resolve();
      await Promise.allSettled([clear, save]);
      await service.close();
    }
  },
);

it.each(
  (['settings', 'activate', 'mode', 'clear', 'tests', 'hint'] as const).flatMap((operation) =>
    [false, true].map((failure) => ({ operation, failure })),
  ),
)(
  '$operation keeps the service busy until its state write settles (failure: $failure)',
  async ({ operation, failure }) => {
    const { service, store } = await fixture();
    await service.startProblem(problem.id);
    const disk = deferred();
    const persist = vi.spyOn(store, 'persist').mockReturnValueOnce(disk.promise);
    const running =
      operation === 'settings'
        ? service.updateSettings({ ...defaultSettings, provider: 'ollama' })
        : operation === 'activate'
          ? service.activateProblem(problem.id)
          : operation === 'mode'
            ? service.setMode('design')
            : operation === 'clear'
              ? service.clearChat()
              : operation === 'tests'
                ? service.runTests(false)
                : service.hint();
    const settled = running.then(
      () => null,
      (error: Error) => error.message,
    );
    try {
      await vi.waitFor(() => expect(persist).toHaveBeenCalled());
      expect(service.snapshot().busy, `${operation} must retain the lock during persist()`).toBe(
        true,
      );
      await expect(
        service.reconnect(),
        'A connection change must not overlap the state write',
      ).rejects.toThrow('operation is still running');
    } finally {
      if (failure) disk.reject(new Error('Fixture state write failure'));
      else disk.resolve();
      expect(await settled, `${operation} must report its disk result`).toBe(
        failure ? 'Fixture state write failure' : null,
      );
      expect(service.snapshot().busy).toBe(false);
      await service.reconnect();
      await service.close();
    }
  },
);

it('starts with AI off, resumes drafts, and never exposes credentials in snapshots', async () => {
  const { service, store } = await fixture();
  await expect(service.chat('Help')).rejects.toThrow('Enable a local');
  await service.startProblem(problem.id);
  await service.saveCode(problem.id, '# my changed draft');
  await service.startProblem(problem.id);
  expect(service.snapshot().sessions[0].code).toBe('# my changed draft');
  await service.updateSettings({ ...defaultSettings, apiKey: 'fixture-secret-not-a-real-key' });
  expect(service.snapshot().settings.hasApiKey).toBe(true);
  expect(JSON.stringify(service.snapshot())).not.toContain('fixture-secret');
  expect(await readFile(join(store.root, 'workspace.json'), 'utf8')).not.toContain(
    'fixture-secret',
  );
  await service.close();
});

it('an older remote engine can keep practicing without queue support', async () => {
  const { service, mcp } = await fixture();
  try {
    expect(await service.practiceQueue()).toEqual({ supported: false, items: [], sources: [] });
    expect(service.snapshot().connection).toBe('connected');
    expect(mcp.call.mock.calls.some(([name]) => name === 'get_practice_queue')).toBe(false);
    await service.startProblem(problem.id);
    expect(service.snapshot().sessions[0].code).toBe(code);
  } finally {
    await service.close();
  }
});

it('retries the same code after a disk write fails', async () => {
  const { service, store } = await fixture();
  try {
    await service.startProblem(problem.id);
    const save = vi.spyOn(store, 'saveCode');
    save.mockRejectedValueOnce(new Error('Fixture disk failure'));
    const latest = '# draft retained after a failed write';
    await expect(service.saveCode(problem.id, latest)).rejects.toThrow('Fixture disk failure');
    await service.saveCode(problem.id, latest);
    expect(
      save,
      'The retry must write the same draft instead of returning early',
    ).toHaveBeenCalledTimes(2);
    expect(await readFile(store.path(store.scope(), problem.id), 'utf8')).toBe(latest);
    const disk = JSON.parse(await readFile(join(store.root, 'workspace.json'), 'utf8'));
    expect(disk.workspaces[store.scope()].sessions[0].code).toBe(latest);
  } finally {
    await service.close();
  }
});

it('binds agent tools to the selected attempt and captured editor draft', async () => {
  let round = 0;
  const model: Model = {
    complete: async () =>
      ++round === 1
        ? {
            text: '',
            calls: [
              {
                id: 'hint',
                name: 'get_hint',
                args: {
                  attempt_id: 'foreign-attempt',
                  current_code: 'model-generated replacement',
                  depth: 1,
                },
              },
            ],
          }
        : { text: 'Your turn', calls: [] },
  };
  const { service, mcp } = await fixture(model);
  await service.startProblem(problem.id);
  await service.updateSettings({ ...defaultSettings, provider: 'ollama' });
  await service.chat('One hint');
  expect(mcp.call).toHaveBeenCalledWith(
    'get_hint',
    {
      attempt_id: 'owned-attempt',
      current_code: code,
      depth: 1,
    },
    expect.any(AbortSignal),
  );
  expect(service.snapshot().sessions[0].code).toBe(code);
  expect(service.snapshot().sessions[0].hintDepth).toBe(1);
  await service.close();
});

it.each([false, true])('agent submission requires explicit approval (allow=%s)', async (allow) => {
  let round = 0;
  const model: Model = {
    complete: async () =>
      ++round === 1
        ? {
            text: '',
            calls: [
              {
                id: 'submit',
                name: 'submit_solution',
                args: {
                  attempt_id: 'foreign',
                  code: 'not my code',
                },
              },
            ],
          }
        : { text: 'Finished', calls: [] },
  };
  const { service, mcp, events } = await fixture(model);
  await service.startProblem(problem.id);
  await service.updateSettings({ ...defaultSettings, provider: 'ollama' });
  const turn = service.chat('Submit my draft');
  await vi.waitFor(() => expect(events.some((event) => event.type === 'approval')).toBe(true));
  expect(mcp.call.mock.calls.some(([name]) => name === 'submit_solution')).toBe(false);
  const event = events.find((event) => event.type === 'approval');
  if (event?.type !== 'approval') throw new Error('Missing approval');
  await service.saveCode(problem.id, '# newer draft after the approval request');
  service.approve(event.approval.id, allow);
  expect(() => service.approve(event.approval.id, !allow)).toThrow('Approval has expired');
  await turn;
  expect(events.filter((event) => event.type === 'approval-settled')).toEqual([
    { type: 'approval-settled', id: event.approval.id },
  ]);
  expect(service.snapshot().sessions[0].submitted).toBe(allow);
  expect(service.snapshot().sessions[0].code).toBe('# newer draft after the approval request');
  expect(service.snapshot().sessions[0].resultStale).toBe(allow);
  if (allow)
    expect(mcp.call).toHaveBeenCalledWith(
      'submit_solution',
      {
        attempt_id: 'owned-attempt',
        code,
      },
      expect.any(AbortSignal),
    );
  await service.close();
});

it.each(['deadline', 'cancellation'] as const)(
  'approval %s resolves once without submission and rejects a late decision',
  async (reason) => {
    let receiveApproval!: (approval: Approval) => void;
    const approvalReceived = new Promise<Approval>((resolve) => {
      receiveApproval = resolve;
    });
    const provider = deferred();
    const nextRound = deferred();
    let round = 0;
    const model: Model = {
      complete: async () => {
        if (++round === 1)
          return { text: '', calls: [{ id: 'submit', name: 'submit_solution', args: {} }] };
        nextRound.resolve();
        await provider.promise;
        return { text: 'Continue with your draft.', calls: [] };
      },
    };
    const { service, mcp, events } = await fixture(model, memoryVault, undefined, (event) => {
      if (event.type === 'approval') receiveApproval(event.approval);
    });
    await service.startProblem(problem.id);
    await service.updateSettings({ ...defaultSettings, provider: 'ollama' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const turn = service.chat('Discuss submission.');
    try {
      const approval = await approvalReceived;
      if (reason === 'deadline') {
        await vi.advanceTimersByTimeAsync(59_999);
        expect(events.some((event) => event.type === 'approval-settled')).toBe(false);
        expect(round).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        await nextRound.promise;
        expect(
          service.snapshot().busy,
          'Expiry must close approval before the chat completes',
        ).toBe(true);
      } else {
        service.cancelChat();
        await turn;
      }
      expect(events.filter((event) => event.type === 'approval-settled')).toEqual([
        { type: 'approval-settled', id: approval.id },
      ]);
      expect(() => service.approve(approval.id, true)).toThrow('Approval has expired');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(events.filter((event) => event.type === 'approval-settled')).toHaveLength(1);
      expect(mcp.call.mock.calls.some(([name]) => name === 'submit_solution')).toBe(false);
      expect(service.snapshot().sessions[0].submitted).toBe(false);
    } finally {
      vi.useRealTimers();
      provider.resolve();
      service.cancelChat();
      await turn;
      await service.close();
    }
  },
);

it('a failed final close check keeps the service connected and permits a retry', async () => {
  const { service, store, mcp } = await fixture();
  await service.startProblem(problem.id);
  const closeCalls = mcp.close.mock.calls.length;
  const write = vi.spyOn(store, 'persist').mockRejectedValueOnce(new Error('Final write failure'));
  await expect(service.prepareClose()).rejects.toThrow('Final write failure');
  expect(mcp.close).toHaveBeenCalledTimes(closeCalls);
  expect(service.snapshot().connection).toBe('connected');
  await service.hint();
  await service.prepareClose();
  const writes = write.mock.calls.length;
  await service.close({ save: false });
  expect(
    write,
    'The close after a successful check must not write the state again',
  ).toHaveBeenCalledTimes(writes);
  expect(mcp.close).toHaveBeenCalledTimes(closeCalls + 1);
});

it('a provider construction failure releases chat state and the service action lock', async () => {
  const { service } = await fixture(() => {
    throw new Error('Provider construction failed');
  });
  await service.startProblem(problem.id);
  await service.updateSettings({ ...defaultSettings, provider: 'ollama' });
  await service.chat('Start the coach.');
  expect(service.snapshot()).toMatchObject({
    busy: false,
    chatId: null,
    error: 'Provider construction failed',
  });
  await service.hint();
  expect(service.snapshot().sessions[0].hintDepth).toBe(1);
  await service.close();
});

it('chat cancellation is unavailable during the final write but the service remains busy', async () => {
  const { service, store, events } = await fixture({
    complete: async () => ({ text: 'Fixture response', calls: [] }),
  });
  await service.startProblem(problem.id);
  await service.updateSettings({ ...defaultSettings, provider: 'ollama' });
  const finalWrite = deferred();
  const persist = store.persist.bind(store);
  let calls = 0;
  vi.spyOn(store, 'persist').mockImplementation(() =>
    ++calls === 2 ? finalWrite.promise.then(() => persist()) : persist(),
  );
  const turn = service.chat('Start the coach.');
  try {
    await vi.waitFor(() => expect(calls).toBe(2));
    expect(service.snapshot()).toMatchObject({ busy: true, chatId: null });
    const last = events.filter((event) => event.type === 'snapshot').at(-1);
    expect(last?.snapshot).toMatchObject({ busy: true, chatId: null });
    service.cancelChat();
    expect(service.snapshot().sessions[0].chat.some((item) => item.text === 'Coach stopped.')).toBe(
      false,
    );
    finalWrite.resolve();
    await turn;
    expect(service.snapshot()).toMatchObject({ busy: false, chatId: null });
  } finally {
    finalWrite.resolve();
    await turn;
    await service.close();
  }
});

it('closing after a failed load preserves the damaged workspace', async () => {
  const { service, store } = await fixture();
  await service.close();
  await writeFile(join(store.root, 'workspace.json'), '{broken');
  const fresh = new WorkbenchService(
    new LocalStore(store.root),
    {
      close: async () => {},
    } as unknown as McpConnection,
    memoryVault,
    () => {},
  );
  await expect(fresh.initialize()).rejects.toThrow('not been overwritten');
  await fresh.close();
  expect(await readFile(join(store.root, 'workspace.json'), 'utf8')).toBe('{broken');
});

it('requires sandbox opt-in, reconnects the engine URL, and wraps only code execution', async () => {
  const ready = { phase: 'ready' as const, managed: true, message: 'Ready' };
  const sandbox = {
    status: vi.fn(() => ready),
    inspect: vi.fn(async () => ready),
    enable: vi.fn(async () => ready),
    stop: vi.fn(async () => ready),
    withExecution: vi.fn(async (operation: () => Promise<unknown>) => operation()),
    close: vi.fn(async () => {}),
  };
  const { service, mcp, store } = await fixture(
    undefined,
    memoryVault,
    sandbox as unknown as ManagedSandbox,
  );
  expect(sandbox.enable).not.toHaveBeenCalled();
  expect(service.settings().managedSandbox).toBe(false);
  await expect(
    service.updateSettings({ ...defaultSettings, managedSandbox: true }),
  ).rejects.toThrow('opt into');
  await service.updateSettings({ ...defaultSettings, pistonUrl: 'http://127.0.0.1:2999' });
  await service.enableSandbox();
  expect(service.settings().pistonUrl).toBe('http://127.0.0.1:2000');
  expect(mcp.connect).toHaveBeenLastCalledWith(
    expect.objectContaining({ pistonUrl: 'http://127.0.0.1:2000', managedSandbox: true }),
    '',
  );
  expect(
    JSON.parse(await readFile(join(store.root, 'workspace.json'), 'utf8')).settings.managedSandbox,
  ).toBe(true);
  await service.startProblem(problem.id);
  await service.hint();
  expect(sandbox.withExecution).not.toHaveBeenCalled();
  await service.runTests(false);
  expect(sandbox.withExecution).toHaveBeenCalledTimes(1);
  expect(mcp.call).toHaveBeenCalledWith(
    'run_tests',
    { attempt_id: 'owned-attempt', code },
    undefined,
  );
  await service.updateSettings({ ...defaultSettings });
  expect(sandbox.stop).toHaveBeenCalledTimes(1);
  await service.runTests(false);
  expect(sandbox.withExecution).toHaveBeenCalledTimes(1);
  await service.close();
  expect(sandbox.close).toHaveBeenCalledTimes(1);
});

it('does not persist sandbox opt-in after failed setup, and closes it even if MCP cleanup fails', async () => {
  const sandbox = {
    enable: vi.fn(async () => {
      throw new Error('Docker is unavailable');
    }),
    close: vi.fn(async () => {}),
  };
  const { service, mcp } = await fixture(
    undefined,
    memoryVault,
    sandbox as unknown as ManagedSandbox,
  );
  await expect(service.enableSandbox()).rejects.toThrow('Docker is unavailable');
  expect(service.settings().managedSandbox).toBe(false);
  expect(service.snapshot().busy).toBe(false);
  mcp.close.mockRejectedValueOnce(new Error('Fixture transport failure'));
  await expect(service.close()).rejects.toThrow('Fixture transport failure');
  expect(sandbox.close).toHaveBeenCalledTimes(1);
});
