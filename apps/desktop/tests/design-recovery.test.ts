import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { McpConnection } from '../src/main/mcp';
import { LocalStore } from '../src/main/storage';
import { WorkbenchService } from '../src/main/service';
import { emptyDesignDraft, type DesignSession } from '../src/shared/design';

function open(root: string) {
  const store = new LocalStore(root);
  const mcp = new McpConnection(resolve('../..'), root);
  const service = new WorkbenchService(
    store,
    mcp,
    { available: () => false, encrypt: () => '', decrypt: () => '' },
    () => {},
  );
  return { store, mcp, service };
}

async function diskSession(root: string): Promise<DesignSession> {
  const saved = JSON.parse(await readFile(join(root, 'workspace.json'), 'utf8'));
  const sessions = Object.values(
    saved.workspaces as Record<string, { designSessions: DesignSession[] }>,
  ).flatMap((workspace) => workspace.designSessions);
  expect(sessions).toHaveLength(1);
  return sessions[0];
}

for (const abrupt of [false, true]) {
  it(`recovers a backend completion after a failed local save and ${abrupt ? 'abrupt restart' : 'normal close'}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'interview-design-recovery-'));
    let current = open(root);
    try {
      await current.service.initialize();
      await current.service.startDesign('design-link-aliases');
      const id = current.service.snapshot().activeDesignSessionId!;
      const draft = emptyDesignDraft();
      draft.notes.requirements = 'Keep the saved candidate notes.';
      await current.service.saveDesignDraft(id, draft);
      await current.service.reviewDesign();
      const before = current.service.snapshot().designSessions[0];
      const calls = vi.spyOn(current.mcp, 'call');
      const fail = vi
        .spyOn(current.store, 'persist')
        .mockRejectedValueOnce(new Error('Fixture local completion write failed'));
      await expect(current.service.finishDesign()).rejects.toThrow(
        'Fixture local completion write failed',
      );
      fail.mockRestore();
      const backend = await current.mcp.call<DesignSession>('get_design_session', {
        session_id: id,
      });
      const completed = current.service.snapshot().designSessions[0];
      expect(completed.status).toBe('completed');
      expect(completed.completed_at).toBe(backend.completed_at);
      expect((await diskSession(root)).status).toBe('in_progress');
      await expect(current.service.saveDesignDraft(id, draft)).rejects.toThrow('finished');
      expect(calls.mock.calls.filter(([name]) => name === 'finish_design_session')).toHaveLength(1);
      if (abrupt) {
        // End only the backend connection. No final workspace write simulates process loss.
        await current.mcp.close();
      } else {
        await current.service.prepareClose();
        await current.service.close();
        expect(await diskSession(root)).toEqual(completed);
      }
      current = open(root);
      await current.service.initialize();
      expect(current.service.snapshot().designSessionVerified).toBe(false);
      expect(await current.service.loadDesignDraft(id)).toEqual(draft);
      expect(current.service.snapshot().designSessionVerified).toBe(true);
      expect(current.service.snapshot().designSessions[0]).toEqual(completed);
      expect(await diskSession(root)).toEqual(completed);
      expect(completed.review).toEqual(before.review);
      expect(completed.latestCheckpointId).toBe(before.latestCheckpointId);
      expect(completed.chat).toEqual(before.chat);
      await expect(current.service.saveDesignDraft(id, draft)).rejects.toThrow('finished');
    } finally {
      await current.service.close();
    }
  }, 20_000);
}

it('recovery rejects failed reads, wrong identities, old servers, and failed writes before permitting edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'interview-design-recovery-retry-'));
  let current = open(root);
  try {
    await current.service.initialize();
    await current.service.startDesign('design-link-aliases');
    const id = current.service.snapshot().activeDesignSessionId!;
    const draft = emptyDesignDraft();
    draft.notes.requirements = 'Keep this draft through recovery errors.';
    await current.service.saveDesignDraft(id, draft);
    await current.service.reviewDesign();
    const before = await diskSession(root);
    await current.mcp.call('finish_design_session', {
      session_id: id,
      checkpoint_id: before.review!.checkpoint_id,
    });
    await current.mcp.close();
    current = open(root);
    await current.service.initialize();
    const original = current.mcp.call.bind(current.mcp);
    const backend = await original<DesignSession>('get_design_session', { session_id: id });
    let failure: unknown = new Error('Fixture session read failed');
    const read = vi.spyOn(current.mcp, 'call').mockImplementation(async (name, args, signal) => {
      if (name !== 'get_design_session') return original(name, args, signal);
      if (failure instanceof Error) throw failure;
      return failure;
    });
    await expect(current.service.loadDesignDraft(id)).rejects.toThrow(
      'Fixture session read failed',
    );
    await expect(
      current.service.saveDesignDraft(id, {
        ...draft,
        notes: { ...draft.notes, requirements: 'Must not be saved' },
      }),
    ).rejects.toThrow('Fixture session read failed');
    expect(current.service.snapshot().designSessionVerified).toBe(false);
    expect(await diskSession(root)).toEqual(before);
    failure = { ...backend, id: randomUUID() };
    await expect(current.service.loadDesignDraft(id)).rejects.toThrow('different design session');
    failure = { ...backend, problem_id: 'different-problem' };
    await expect(current.service.loadDesignDraft(id)).rejects.toThrow('different design session');
    failure = { ...backend, completed_at: null };
    await expect(current.service.loadDesignDraft(id)).rejects.toThrow('incorrect completion time');
    const tools = current.mcp.tools;
    current.mcp.tools = tools.filter((tool) => tool.name !== 'get_design_session');
    await expect(current.service.loadDesignDraft(id)).rejects.toThrow(
      'Update the connected server',
    );
    current.mcp.tools = tools;
    read.mockRestore();
    const fail = vi
      .spyOn(current.store, 'persist')
      .mockRejectedValueOnce(new Error('Fixture recovery write failed'));
    await expect(current.service.loadDesignDraft(id)).rejects.toThrow(
      'Fixture recovery write failed',
    );
    expect(current.service.snapshot().designSessionVerified).toBe(false);
    expect(current.service.snapshot().designSessions[0].status).toBe('completed');
    expect(await diskSession(root)).toEqual(before);
    fail.mockRestore();
    expect(await current.service.loadDesignDraft(id)).toEqual(draft);
    expect(current.service.snapshot().designSessionVerified).toBe(true);
    expect((await diskSession(root)).completed_at).toBe(backend.completed_at);
    await expect(current.service.saveDesignDraft(id, draft)).rejects.toThrow('finished');
  } finally {
    await current.service.close();
  }
}, 20_000);

it('a lost completion response requires a status read before another edit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'interview-design-finish-response-'));
  const { service, mcp } = open(root);
  try {
    await service.initialize();
    await service.startDesign('design-link-aliases');
    const id = service.snapshot().activeDesignSessionId!;
    const draft = emptyDesignDraft();
    draft.notes.requirements = 'Keep notes when the completion response is lost.';
    await service.saveDesignDraft(id, draft);
    await service.reviewDesign();
    const original = mcp.call.bind(mcp);
    const call = vi.spyOn(mcp, 'call').mockImplementation(async (name, args, signal) => {
      const result = await original(name, args, signal);
      if (name === 'finish_design_session') throw new Error('Fixture completion response lost');
      return result;
    });
    await expect(service.finishDesign()).rejects.toThrow('Fixture completion response lost');
    expect(service.snapshot().designSessions[0].status).toBe('in_progress');
    expect(service.snapshot().designSessionVerified).toBe(false);
    const completed = await original<DesignSession>('get_design_session', { session_id: id });
    expect(completed.status).toBe('completed');
    await expect(
      service.saveDesignDraft(id, {
        ...draft,
        notes: { ...draft.notes, requirements: 'Must not be saved' },
      }),
    ).rejects.toThrow('finished');
    expect(await service.loadDesignDraft(id)).toEqual(draft);
    expect(service.snapshot().designSessions[0].completed_at).toBe(completed.completed_at);
    expect(call.mock.calls.filter(([name]) => name === 'finish_design_session')).toHaveLength(1);
  } finally {
    await service.close();
  }
}, 20_000);

it('an older status read cannot unlock a session after an uncertain completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'interview-design-old-status-'));
  const { service, mcp } = open(root);
  let release!: () => void;
  let older: Promise<unknown> | undefined;
  let finishing: Promise<unknown> | undefined;
  try {
    await service.initialize();
    await service.startDesign('design-link-aliases');
    const id = service.snapshot().activeDesignSessionId!;
    const draft = emptyDesignDraft();
    draft.notes.requirements = 'Keep these notes through concurrent status reads.';
    await service.saveDesignDraft(id, draft);
    await service.reviewDesign();
    await service.reconnect();
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const firstRead = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let reads = 0;
    let finishCalls = 0;
    const original = mcp.call.bind(mcp);
    vi.spyOn(mcp, 'call').mockImplementation(async (name, args, signal) => {
      if (name === 'finish_design_session') finishCalls++;
      const result = await original(name, args, signal);
      if (name === 'get_design_session' && ++reads === 1) {
        entered();
        await held;
      }
      if (name === 'finish_design_session') throw new Error('Fixture completion response lost');
      return result;
    });
    older = service.loadDesignDraft(id).then(
      () => 'resolved',
      (error: Error) => error.message,
    );
    await firstRead;
    await service.loadDesignDraft(id);
    expect(service.snapshot().designSessionVerified).toBe(true);
    finishing = service.finishDesign().then(
      () => 'resolved',
      (error: Error) => error.message,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finishCalls).toBe(0);
    expect(service.snapshot().busy).toBe(true);
    expect(service.snapshot().designSessions[0].status).toBe('in_progress');
    release();
    expect(await older).toBe('resolved');
    expect(await finishing).toBe('Fixture completion response lost');
    expect(finishCalls).toBe(1);
    expect(service.snapshot().designSessionVerified).toBe(false);
    await expect(service.saveDesignDraft(id, draft)).rejects.toThrow('finished');
    expect(service.snapshot().designSessions[0].status).toBe('completed');
  } finally {
    release?.();
    await older;
    await finishing;
    await service.close();
  }
}, 20_000);

it('finish waits for an accepted draft write and rejects a review of older notes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'interview-design-finish-save-'));
  const { service, mcp } = open(root);
  let release!: () => void;
  let saving: Promise<unknown> | undefined;
  let finished: Promise<unknown> | undefined;
  const { DesignStore } = await import('../src/main/design-storage');
  const originalSave = DesignStore.prototype.save;
  let saveSpy: ReturnType<typeof vi.spyOn> | undefined;
  try {
    await service.initialize();
    await service.startDesign('design-link-aliases');
    const id = service.snapshot().activeDesignSessionId!;
    await service.reviewDesign();
    const draft = emptyDesignDraft();
    draft.notes.requirements = 'A draft accepted before Finish must be reviewed first.';
    let entered!: () => void;
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    saveSpy = vi.spyOn(DesignStore.prototype, 'save').mockImplementationOnce(async function (
      this: InstanceType<typeof DesignStore>,
      ...args: Parameters<typeof originalSave>
    ) {
      entered();
      await held;
      return originalSave.apply(this, args);
    });
    saving = service.saveDesignDraft(id, draft);
    await writing;
    const call = vi.spyOn(mcp, 'call');
    finished = service.finishDesign().then(
      () => 'resolved',
      (error: Error) => error.message,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(call.mock.calls.filter(([name]) => name === 'finish_design_session')).toHaveLength(0);
    release();
    await saving;
    expect(await finished).toContain('current checkpoint');
    expect((await mcp.call<DesignSession>('get_design_session', { session_id: id })).status).toBe(
      'in_progress',
    );
    expect(await service.loadDesignDraft(id)).toEqual(draft);
    expect(service.snapshot().designSessions[0].review!.scene_digest).not.toBe(
      service.snapshot().designSessions[0].draftDigest,
    );
  } finally {
    release?.();
    await saving?.catch(() => {});
    await finished;
    saveSpy?.mockRestore();
    await service.close();
  }
}, 20_000);
