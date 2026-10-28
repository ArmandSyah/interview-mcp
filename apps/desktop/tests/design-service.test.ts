import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { McpConnection } from '../src/main/mcp';
import { LocalStore, defaultSettings } from '../src/main/storage';
import { WorkbenchService } from '../src/main/service';
import { emptyDesignDraft } from '../src/shared/design';
import type { Model } from '../src/main/providers';
import { DesignStore } from '../src/main/design-storage';
import { reviewJSON } from './grading-fixture';

it('design AI review locks before checkpoint capture, cancels before inference, and preserves curated reviews', async () => {
  const root = await mkdtemp(join(tmpdir(), 'interview-design-ai-review-'));
  const store = new LocalStore(root);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const complete = vi.fn<Model['complete']>(async () => {
    await waiting;
    return { text: reviewJSON('design'), calls: [] };
  });
  const service = new WorkbenchService(
    store,
    new McpConnection(resolve('../..'), root),
    { available: () => false, encrypt: () => '', decrypt: () => '' },
    () => {},
    () => ({ complete }),
  );
  try {
    await service.initialize();
    await service.updateSettings({ ...defaultSettings, provider: 'ollama' });
    await service.startDesign('design-link-aliases');
    const sessionId = service.snapshot().activeDesignSessionId!;
    const draft = emptyDesignDraft();
    draft.notes.requirements = 'Captured candidate notes.';
    await service.saveDesignDraft(sessionId, draft);
    await service.reviewDesign();
    const curated = service.snapshot().designSessions[0]!.review;
    const cancelled = service.grade();
    expect(service.snapshot().busy).toBe(true);
    expect(service.snapshot().chatId).toBeTruthy();
    await expect(service.grade()).rejects.toThrow();
    service.cancelChat();
    await cancelled;
    expect(complete).not.toHaveBeenCalled();
    expect(service.snapshot().busy).toBe(false);
    const review = service.grade();
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    const captured = JSON.parse(complete.mock.calls[0]![1][0]!.text);
    expect(captured.checkpoint.notes.requirements).toBe('Captured candidate notes.');
    draft.notes.requirements = 'New candidate notes after capture.';
    await service.saveDesignDraft(sessionId, draft);
    release();
    await review;
    const after = service.snapshot().designSessions[0]!;
    expect(after.review).toEqual(curated);
    expect(after.status).toBe('in_progress');
    expect(after.hintDepth).toBe(0);
    expect(after.chat.at(-1)!.text).toContain(captured.checkpoint.id);
    expect(after.chat.at(-1)!.text).toContain(captured.checkpoint.scene_digest);
    expect((await service.loadDesignDraft(sessionId)).notes.requirements).toBe(
      'New candidate notes after capture.',
    );
    expect(
      (await service.designCheckpoints()).filter((item) => item.label === 'AI review'),
    ).toHaveLength(2);
  } finally {
    release();
    await service.close();
  }
}, 20_000);

it('a design AI checkpoint failure prevents inference and permits retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'interview-design-ai-checkpoint-'));
  const store = new LocalStore(root);
  const complete = vi.fn<Model['complete']>(async () => ({
    text: reviewJSON('design'),
    calls: [],
  }));
  const service = new WorkbenchService(
    store,
    new McpConnection(resolve('../..'), root),
    { available: () => false, encrypt: () => '', decrypt: () => '' },
    () => {},
    () => ({ complete }),
  );
  let checkpoint: ReturnType<typeof vi.spyOn> | undefined;
  try {
    await service.initialize();
    await service.updateSettings({ ...defaultSettings, provider: 'ollama' });
    await service.startDesign('design-link-aliases');
    checkpoint = vi
      .spyOn(DesignStore.prototype, 'checkpoint')
      .mockRejectedValueOnce(new Error('Fixture checkpoint failed'));
    await service.grade();
    expect(complete).not.toHaveBeenCalled();
    expect(service.snapshot().error).toContain('Fixture checkpoint failed');
    expect(service.snapshot().busy).toBe(false);
    checkpoint.mockRestore();
    checkpoint = undefined;
    await service.grade();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(service.snapshot().error).toBeNull();
    await service.reviewDesign();
    await service.finishDesign();
    await expect(service.grade()).rejects.toThrow('Start a new design attempt');
    expect(complete).toHaveBeenCalledTimes(1);
  } finally {
    checkpoint?.mockRestore();
    await service.close();
  }
}, 20_000);

it('a new design attempt write failure keeps the previous attempt and permits retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'interview-design-create-'));
  const store = new LocalStore(root);
  const service = new WorkbenchService(
    store,
    new McpConnection(resolve('../..'), root),
    { available: () => false, encrypt: () => '', decrypt: () => '' },
    () => {},
  );
  try {
    await service.initialize();
    await service.startDesign('design-link-aliases');
    const draft = emptyDesignDraft();
    draft.notes.requirements = 'Preserve the previous attempt.';
    await service.saveDesignDraft(service.snapshot().activeDesignSessionId!, draft);
    const before = service.snapshot();
    const previous = await readFile(join(root, 'workspace.json'), 'utf8');
    vi.spyOn(store, 'persist').mockRejectedValueOnce(new Error('Fixture creation write failure'));
    await expect(service.startDesign('design-link-aliases', true)).rejects.toThrow(
      'Fixture creation write failure',
    );
    expect(service.snapshot().activeDesignSessionId).toBe(before.activeDesignSessionId);
    expect(service.snapshot().designSessions).toEqual(before.designSessions);
    expect(service.snapshot().busy).toBe(false);
    expect(await readFile(join(root, 'workspace.json'), 'utf8')).toBe(previous);
    expect((await service.loadDesignDraft(before.activeDesignSessionId!)).notes).toEqual(
      draft.notes,
    );
    await service.startDesign('design-link-aliases', true);
    expect(service.snapshot().designSessions).toHaveLength(2);
    expect(service.snapshot().activeDesignSessionId).not.toBe(before.activeDesignSessionId);
  } finally {
    await service.close();
  }
});

it.each([false, true])(
  'new design attempts preserve earlier and queued notes after a write failure=%s',
  async (failure) => {
    const root = await mkdtemp(join(tmpdir(), 'interview-design-create-race-'));
    const store = new LocalStore(root);
    const service = new WorkbenchService(
      store,
      new McpConnection(resolve('../..'), root),
      { available: () => false, encrypt: () => '', decrypt: () => '' },
      () => {},
    );
    let releaseEarlier!: () => void;
    let releaseWrite!: () => void;
    let rejectWrite!: (error: Error) => void;
    const earlier = new Promise<void>((resolve) => {
      releaseEarlier = resolve;
    });
    const writing = new Promise<void>((resolve, reject) => {
      releaseWrite = resolve;
      rejectWrite = reject;
    });
    let first: Promise<string> | undefined;
    let next: Promise<string> | undefined;
    let creation: Promise<string | null> | undefined;
    try {
      await service.initialize();
      await service.startDesign('design-link-aliases');
      const previousId = service.snapshot().activeDesignSessionId!;
      const originalPersist = store.persist.bind(store);
      const persist = vi
        .spyOn(store, 'persist')
        .mockImplementationOnce(async (...args) => {
          await earlier;
          await originalPersist(...args);
        })
        .mockImplementationOnce(async (...args) => {
          await writing;
          await originalPersist(...args);
        });
      const draft = emptyDesignDraft();
      draft.notes.requirements = 'Notes before creation';
      first = service.saveDesignDraft(previousId, draft);
      await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
      creation = service.startDesign('design-link-aliases', true).then(
        () => null,
        (error: Error) => error.message,
      );
      releaseEarlier();
      await first;
      await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(2));
      expect(service.snapshot()).toMatchObject({ busy: true, activeDesignSessionId: previousId });
      expect(service.snapshot().designSessions).toHaveLength(1);
      const latest = emptyDesignDraft();
      latest.notes.requirements = 'Notes during creation';
      next = service.saveDesignDraft(previousId, latest);
      expect(persist).toHaveBeenCalledTimes(2);
      if (failure) rejectWrite(new Error('Fixture design creation failure'));
      else releaseWrite();
      expect(await creation).toBe(failure ? 'Fixture design creation failure' : null);
      await next;
      const restored = new LocalStore(root);
      await restored.load();
      const saved = restored.workspace(store.scope());
      expect(saved.designSessions).toHaveLength(failure ? 1 : 2);
      expect(saved.activeDesignSessionId).toBe(failure ? previousId : saved.designSessions[1].id);
      expect((await service.loadDesignDraft(previousId)).notes).toEqual(latest.notes);
      expect(service.snapshot().designSessions).toEqual(saved.designSessions);
      expect(service.snapshot().busy).toBe(false);
    } finally {
      releaseEarlier();
      releaseWrite();
      await Promise.allSettled([first, next, creation]);
      await service.close();
    }
  },
);

it.each(
  ['history', 'settings', 'selection'].flatMap((operation) =>
    [false, true].map((failure) => ({ operation, failure })),
  ),
)(
  'design notes wait for $operation and handle a write failure=$failure',
  async ({ operation, failure }) => {
    const root = await mkdtemp(join(tmpdir(), 'interview-design-clear-'));
    const store = new LocalStore(root);
    const service = new WorkbenchService(
      store,
      new McpConnection(resolve('../..'), root),
      { available: () => false, encrypt: () => '', decrypt: () => '' },
      () => {},
    );
    let release!: () => void;
    let reject!: (error: Error) => void;
    const gate = new Promise<void>((resolve, fail) => {
      release = resolve;
      reject = fail;
    });
    let clear: Promise<string | null> | undefined;
    let save: Promise<string> | undefined;
    try {
      await service.initialize();
      await service.setMode('design');
      await service.startDesign('design-link-aliases');
      await service.designHint();
      const before = service.snapshot().designSessions[0];
      expect(before.chat.length).toBeGreaterThan(0);
      let target = before.id;
      if (operation === 'selection') {
        await service.startDesign('design-link-aliases', true);
        target = service.snapshot().activeDesignSessionId!;
        await service.activateDesign(before.id);
      }
      const original = store.persist.bind(store);
      const persist = vi.spyOn(store, 'persist').mockImplementationOnce(async (...args) => {
        await gate;
        await original(...args);
      });
      clear = (
        operation === 'history'
          ? service.clearChat()
          : operation === 'settings'
            ? service.updateSettings({ ...defaultSettings, provider: 'ollama' })
            : service.activateDesign(target)
      ).then(
        () => null,
        (error: Error) => error.message,
      );
      await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
      const draft = emptyDesignDraft();
      draft.notes.requirements = `Notes entered during ${operation}`;
      save = service.saveDesignDraft(before.id, draft);
      await Promise.resolve();
      expect(service.snapshot().designSessions[0].chat).toEqual(before.chat);
      expect(service.snapshot().activeDesignSessionId).toBe(before.id);
      expect(persist).toHaveBeenCalledTimes(1);
      if (failure) reject(new Error('Design state write failed'));
      else release();
      expect(await clear).toBe(failure ? 'Design state write failed' : null);
      await save;
      expect((await service.loadDesignDraft(before.id)).notes.requirements).toBe(
        draft.notes.requirements,
      );
      const restored = new LocalStore(root);
      await restored.load();
      expect(restored.workspace(store.scope()).designSessions[0].chat).toEqual(
        failure || operation !== 'history' ? before.chat : [],
      );
      expect(restored.workspace(store.scope()).activeDesignSessionId).toBe(
        failure ? before.id : target,
      );
      expect(restored.state.settings.provider).toBe(
        operation === 'settings' && !failure ? 'ollama' : 'disabled',
      );
      expect(restored.workspace(store.scope()).designSessions[0].draftDigest).toBe(
        service.snapshot().designSessions[0].draftDigest,
      );
    } finally {
      release();
      await Promise.allSettled([clear, save]);
      await service.close();
    }
  },
);

it('real SQLAlchemy engine: design checkpoints, reviews, ownership, coach binding, and reopening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'interview-design-service-'));
  const mcp = new McpConnection(resolve('../..'), root);
  const vault = { available: () => false, encrypt: () => '', decrypt: () => '' };
  let captured = '';
  let round = 0;
  const model: Model = {
    complete: async (_prompt, messages, tools) => {
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        'evaluate_design',
        'get_design_brief',
        'get_design_hint',
        'get_design_snapshot',
      ]);
      if (++round === 1) {
        const context = messages.at(-1)?.text ?? '';
        expect(context).toContain('candidate requirements');
        captured = /"checkpoint_id":"([^"]+)"/.exec(context)?.[1] ?? '';
        return {
          text: '',
          calls: [
            {
              id: 'read',
              name: 'get_design_snapshot',
              args: { session_id: 'forged', checkpoint_id: 'forged' },
            },
            { id: 'write', name: 'finish_design_session', args: {} },
            { id: 'hint1', name: 'get_design_hint', args: { depth: 1 } },
            { id: 'hint2', name: 'get_design_hint', args: { depth: 2 } },
          ],
        };
      }
      expect(
        messages.some((item) => item.role === 'tool' && item.text.includes('not available')),
      ).toBe(true);
      expect(
        messages.some((item) => item.role === 'tool' && item.text.includes('Only one hint')),
      ).toBe(true);
      return { text: 'Explain the first important failure mode.', calls: [] };
    },
  };
  const service = new WorkbenchService(
    new LocalStore(root),
    mcp,
    vault,
    () => {},
    () => model,
  );
  try {
    await service.initialize();
    expect(service.snapshot().designProblems).toHaveLength(5);
    await service.setMode('design');
    await service.startDesign('design-link-aliases');
    const session = service.snapshot().designSessions[0];
    const draft = emptyDesignDraft();
    draft.notes.requirements =
      'candidate requirements: owners can disable aliases and must remain isolated from other tenants.';
    await service.saveDesignDraft(session.id, draft);
    await expect(service.loadDesignDraft('00000000-0000-4000-8000-000000000000')).rejects.toThrow(
      'Choose',
    );
    await service.reviewDesign();
    const reviewed = service.snapshot().designSessions[0].review!;
    expect(reviewed.items[0].status).toBe('discussed');
    expect(reviewed.limitations).toContain('not architectural correctness');
    draft.notes.data = 'New edit after review';
    await service.saveDesignDraft(session.id, draft);
    await expect(service.finishDesign()).rejects.toThrow('current checkpoint');
    const restored = await service.restoreDesignCheckpoint(reviewed.checkpoint_id);
    expect(restored.notes.data).toBe('');
    await service.updateSettings({ ...defaultSettings, provider: 'ollama' });
    await service.chat('Help me reason about failures');
    expect(service.snapshot().error).toBeNull();
    const after = service.snapshot().designSessions[0];
    expect(after.status).toBe('in_progress');
    expect(after.hintDepth).toBe(1);
    expect(
      after.chat.some(
        (item) =>
          item.tool === 'get_design_snapshot' &&
          item.status === 'done' &&
          item.text.includes(after.latestCheckpointId!),
      ),
    ).toBe(true);
    expect((await service.loadDesignDraft(session.id)).notes).toEqual(restored.notes);
    expect((await service.designCheckpoints()).length).toBeGreaterThanOrEqual(3);
    const exported = JSON.parse(await service.designExport('workspace'));
    expect(exported.draft.notes.requirements).toContain('candidate requirements');
    expect(JSON.stringify(exported)).not.toContain('apiKey');
    const backup = JSON.parse(await service.exportWorkspace());
    expect(backup.practice.schema_version).toBe(4);
    expect(backup.designs[0].checkpoints.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(backup)).not.toContain('credentials');
    await service.reviewDesign();
    await service.finishDesign();
    expect(service.snapshot().designSessions[0].status).toBe('completed');
    await expect(service.saveDesignDraft(session.id, draft)).rejects.toThrow('finished');
    await service.startDesign('design-link-aliases', true);
    expect(service.snapshot().designSessions).toHaveLength(2);
    await service.close();
    const reopened = new WorkbenchService(
      new LocalStore(root),
      new McpConnection(resolve('../..'), root),
      vault,
      () => {},
    );
    try {
      await reopened.initialize();
      expect(reopened.snapshot().designSessions).toHaveLength(2);
      expect(reopened.snapshot().mode).toBe('design');
    } finally {
      await reopened.close();
    }
  } finally {
    await service.close();
  }
});

it('the real MCP coach sees all 3,000 diagram elements with explicit shortened-label evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'interview-design-large-'));
  const model: Model = {
    complete: async (prompt, messages) => {
      const context = messages.at(-1)!.text;
      const checkpoint = JSON.parse(
        context.split('Immutable checkpoint evidence:\n')[1].split('\nThis is not')[0],
      );
      expect(checkpoint.diagram).toHaveLength(3000);
      expect(checkpoint.diagram.at(-1)).toMatchObject({
        id: 'late-edge',
        from_id: 'node-0',
        to_id: 'node-2997',
      });
      expect(checkpoint.diagram[2997]).toMatchObject({ label_truncated: true });
      expect(prompt).toContain('Never infer their missing text');
      return { text: 'Explain your first important failure mode.', calls: [] };
    },
  };
  const service = new WorkbenchService(
    new LocalStore(root),
    new McpConnection(resolve('../..'), root),
    { available: () => false, encrypt: () => '', decrypt: () => '' },
    () => {},
    () => model,
  );
  try {
    await service.initialize();
    await service.setMode('design');
    await service.startDesign('design-link-aliases');
    const session = service.snapshot().designSessions[0];
    const draft = emptyDesignDraft();
    draft.scene.elements = Array.from({ length: 2998 }, (_, index) => ({
      id: `node-${index}`,
      type: 'rectangle',
      x: index,
      y: 0,
      width: 20,
      height: 20,
    }));
    draft.scene.elements.push(
      {
        id: 'late-label',
        type: 'text',
        text: 'x'.repeat(2500),
        containerId: 'node-2997',
        x: 0,
        y: 0,
        width: 20,
        height: 20,
      },
      {
        id: 'late-edge',
        type: 'arrow',
        startBinding: { elementId: 'node-0' },
        endBinding: { elementId: 'node-2997' },
        x: 0,
        y: 0,
        width: 20,
        height: 20,
      },
    );
    await service.saveDesignDraft(session.id, draft);
    await service.updateSettings({ ...defaultSettings, provider: 'ollama' });
    await service.chat('Ask about my diagram.');
    expect(service.snapshot().error).toBeNull();
    expect(service.snapshot().designSessions[0].chat.at(-1)?.text).toContain(
      'first important failure mode',
    );
    const exported = JSON.parse(await service.designExport('excalidraw'));
    expect(exported.elements).toHaveLength(3000);
    expect(exported.elements[2998].text).toHaveLength(2500);
  } finally {
    await service.close();
  }
});
