import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { WorkbenchService, type Vault } from '../src/main/service';
import { LocalStore, defaultSettings } from '../src/main/storage';
import type { McpConnection } from '../src/main/mcp';
import type { Model } from '../src/main/providers';
import type { ManagedSandbox } from '../src/main/sandbox';
import type { AppEvent, Problem } from '../src/shared/types';

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
    (event) => events.push(event),
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
  service.approve(event.approval.id, allow);
  await turn;
  expect(service.snapshot().sessions[0].submitted).toBe(allow);
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
    ++calls === 2 ? finalWrite.promise.then(persist) : persist(),
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
