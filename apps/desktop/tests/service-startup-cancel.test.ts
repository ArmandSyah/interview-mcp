import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { WorkbenchService } from '../src/main/service';
import type { McpConnection } from '../src/main/mcp';
import { LocalStore } from '../src/main/storage';
import type { AppEvent, Problem } from '../src/shared/types';

const problem: Problem = {
  id: '0001-startup-fixture',
  title: 'Startup fixture',
  difficulty: 'easy',
  tags: [],
  pattern_tags: [],
};
const code = '# Preserve this saved practice during startup cancellation.\n';
const discovery = ['list_problems', 'get_progress', 'list_design_problems', 'list_content_packs'];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(heldStage?: string) {
  const root = await mkdtemp(join(tmpdir(), 'interview-startup-cancel-'));
  const seed = new LocalStore(root);
  await seed.load();
  seed.state.settings.model = 'saved-model-choice';
  const workspace = seed.workspace(seed.scope());
  workspace.activeProblemId = problem.id;
  workspace.sessions.push({
    problem,
    attemptId: '3d741b39-06d6-4396-a722-b6607a3b182e',
    code,
    description: 'Saved public fixture practice.',
    chat: [],
    result: null,
    resultStale: false,
    submitted: false,
    hintDepth: 0,
    updatedAt: 1,
  });
  await seed.persist();
  const saved = await readFile(join(root, 'workspace.json'), 'utf8');
  const store = new LocalStore(root);
  const entered = deferred();
  let hold = heldStage;
  let releaseHeld = () => {};
  const wait = (signal?: AbortSignal) => {
    entered.resolve();
    return new Promise<void>((resolve, reject) => {
      releaseHeld = resolve;
      const cancel = () => reject(signal?.reason ?? new Error('Startup cancelled'));
      if (signal?.aborted) cancel();
      else signal?.addEventListener('abort', cancel, { once: true });
    });
  };
  const mcp = {
    accountIdentity: null,
    tools: ['list_design_problems', 'list_content_packs'].map((name) => ({
      name,
      inputSchema: { type: 'object' },
    })),
    connect: vi.fn(async (_settings: unknown, _key: string, signal?: AbortSignal) => {
      if (hold === 'connect') await wait(signal);
    }),
    call: vi.fn(async (name: string, _args: unknown, signal?: AbortSignal) => {
      if (hold === name) await wait(signal);
      if (name === 'list_problems') return [problem];
      if (name === 'get_progress') return 'Saved practice progress';
      if (name === 'list_design_problems' || name === 'list_content_packs') return [];
      throw new Error(`Unexpected fixture call: ${name}`);
    }),
    close: vi.fn(async () => {}),
  };
  const events: AppEvent[] = [];
  const service = new WorkbenchService(
    store,
    mcp as unknown as McpConnection,
    { available: () => false, encrypt: () => '', decrypt: () => '' },
    (event) => events.push(event),
  );
  return {
    root,
    saved,
    store,
    service,
    mcp,
    entered,
    events,
    releaseHeld: () => releaseHeld(),
    stopHolding: () => {
      hold = undefined;
    },
  };
}

it('startup cancellation during store load preserves saved data and does not connect', async () => {
  const current = await fixture();
  const controller = new AbortController();
  const loaded = deferred();
  const release = deferred();
  const originalLoad = current.store.load.bind(current.store);
  vi.spyOn(current.store, 'load').mockImplementation(async () => {
    loaded.resolve();
    await release.promise;
    await originalLoad();
  });
  const startup = current.service.initialize(controller.signal).catch((error: unknown) => error);
  try {
    await loaded.promise;
    controller.abort();
    release.resolve();
    await startup;
    expect(current.mcp.connect).not.toHaveBeenCalled();
    expect(current.mcp.call).not.toHaveBeenCalled();
    expect(current.store.state).toEqual(JSON.parse(current.saved));
    await current.service.prepareClose();
    expect(await readFile(join(current.root, 'workspace.json'), 'utf8')).toBe(current.saved);
  } finally {
    controller.abort();
    release.resolve();
    await startup;
    await current.service.close({ save: false });
  }
});

for (const stage of ['connect', ...discovery]) {
  it(`startup cancellation during ${stage} stops discovery and permits an ordinary reconnect`, async () => {
    const current = await fixture(stage);
    const controller = new AbortController();
    const startup = current.service.initialize(controller.signal).catch((error: unknown) => error);
    try {
      await current.entered.promise;
      expect(current.mcp.connect.mock.calls[0][2]).toBe(controller.signal);
      for (const [, , signal] of current.mcp.call.mock.calls)
        expect(signal).toBe(controller.signal);
      controller.abort();
      await startup;
      const expectedCalls =
        stage === 'connect' ? [] : discovery.slice(0, discovery.indexOf(stage) + 1);
      expect(current.mcp.call.mock.calls.map(([name]) => name)).toEqual(expectedCalls);
      expect(current.mcp.connect.mock.calls[0][2]).toBe(controller.signal);
      for (const [, , signal] of current.mcp.call.mock.calls)
        expect(signal).toBe(controller.signal);
      expect(current.mcp.close).toHaveBeenCalled();
      expect(current.service.snapshot()).toMatchObject({
        busy: false,
        connection: 'disconnected',
        problems: [],
        designProblems: [],
        installedPacks: [],
        settings: { model: 'saved-model-choice', provider: 'disabled' },
      });
      expect(current.service.snapshot().sessions[0].code).toBe(code);
      expect(
        current.events.some(
          (event) => event.type === 'snapshot' && event.snapshot.connection === 'connected',
        ),
      ).toBe(false);
      await current.service.prepareClose();
      expect(await readFile(join(current.root, 'workspace.json'), 'utf8')).toBe(current.saved);
      current.stopHolding();
      current.mcp.call.mockClear();
      await current.service.reconnect();
      expect(current.mcp.call.mock.calls.map(([name]) => name)).toEqual(discovery);
      expect(current.mcp.connect.mock.calls.at(-1)?.[2]).toBeUndefined();
      expect(current.service.snapshot()).toMatchObject({
        connection: 'connected',
        busy: false,
        problems: [problem],
        progress: 'Saved practice progress',
      });
      expect(current.service.snapshot().sessions[0].code).toBe(code);
    } finally {
      controller.abort();
      current.releaseHeld();
      await startup;
      await current.service.close();
    }
  });
}

it('ordinary startup still loads every catalog and preserves saved practice', async () => {
  const current = await fixture();
  try {
    await current.service.initialize();
    expect(current.mcp.call.mock.calls.map(([name]) => name)).toEqual(discovery);
    expect(current.service.snapshot()).toMatchObject({
      busy: false,
      connection: 'connected',
      problems: [problem],
      progress: 'Saved practice progress',
      settings: { model: 'saved-model-choice', provider: 'disabled' },
    });
    expect(current.service.snapshot().sessions[0].code).toBe(code);
    await current.service.prepareClose();
    expect(await readFile(join(current.root, 'workspace.json'), 'utf8')).toBe(current.saved);
  } finally {
    await current.service.close();
  }
});
