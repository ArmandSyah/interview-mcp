import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { McpConnection } from '../src/main/mcp';
import { LocalStore, defaultSettings } from '../src/main/storage';
import { WorkbenchService } from '../src/main/service';
import type { Model } from '../src/main/providers';
import { DATABASE_SCHEMA_VERSION } from '../src/shared/practice';

const vault = { available: () => false, encrypt: () => '', decrypt: () => '' };
it('real queue engine: coding/design recall, durable drafts, stale-save preservation, immutable history and backup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'interview-practice-service-'));
  const service = new WorkbenchService(
    new LocalStore(directory),
    new McpConnection(resolve('../..'), directory),
    vault,
    () => {},
  );
  let queueId = '';
  try {
    await service.initialize();
    expect((await service.practiceQueue()).supported).toBe(true);
    await service.startProblem('0015-delivery-hold-clusters');
    const coding = service.snapshot().sessions[0];
    const item = await service.addPracticeReview('coding', coding.attemptId, 0);
    queueId = item.id;
    expect((await service.addPracticeReview('coding', coding.attemptId, 30)).id).toBe(item.id);
    await service.startDesign('design-link-aliases');
    const design = service.snapshot().designSessions[0];
    await service.addPracticeReview('design', design.id, 1);
    expect((await service.practiceQueue()).items).toHaveLength(2);
    const draft = await service.loadReflectionDraft(item.id);
    draft.answer = 'My independent invariant and one boundary case, in plain English.';
    draft.takeaway = 'I needed help separating the contract from the implementation.';
    draft.next_action = 'State the invariant first.';
    draft.self_rating = 'recalled';
    await service.saveReflectionDraft(item.id, draft);
    const moved = await service.reschedulePracticeReview(item.id, 7, item.version);
    await expect(service.recordPracticeReflection({ item_id: item.id, ...draft })).rejects.toThrow(
      'changed',
    );
    expect((await service.loadReflectionDraft(item.id)).answer).toBe(draft.answer);
    expect(await service.practiceReflections(item.id)).toEqual([]);
    draft.expected_version = moved.version;
    await service.saveReflectionDraft(item.id, draft);
    const reflection = await service.recordPracticeReflection({ item_id: item.id, ...draft });
    expect(reflection.interval_days).toBe(3);
    expect(await service.practiceReflections(item.id)).toHaveLength(1);
    expect((await service.loadReflectionDraft(item.id)).answer).toBe('');
    expect(service.snapshot().sessions[0].submitted).toBe(false);
    const next = await service.loadReflectionDraft(item.id);
    next.answer = 'Unfinished next reflection, kept across restart.';
    await service.saveReflectionDraft(item.id, next);
    const exported = JSON.parse(await service.exportWorkspace());
    // The actual Python engine must agree with desktop update compatibility.
    expect(exported.practice.schema_version).toBe(DATABASE_SCHEMA_VERSION);
    expect(exported.practice.practice_queue).toHaveLength(2);
    expect(exported.practice.practice_reflections[0].answer).toBe(draft.answer);
    expect(JSON.stringify(exported.workspace)).toContain(next.answer);
    expect(await readFile(join(directory, 'workspace.json'), 'utf8')).toContain(next.answer);
  } finally {
    await service.close();
  }
  const reopened = new WorkbenchService(
    new LocalStore(directory),
    new McpConnection(resolve('../..'), directory),
    vault,
    () => {},
  );
  try {
    await reopened.initialize();
    expect((await reopened.practiceQueue()).items).toHaveLength(2);
    expect((await reopened.loadReflectionDraft(queueId)).answer).toContain(
      'Unfinished next reflection',
    );
    expect(await reopened.practiceReflections(queueId)).toHaveLength(1);
  } finally {
    await reopened.close();
  }
});

it('the coach cannot read or mutate the private recall queue, even with forged tool calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'interview-practice-coach-'));
  let round = 0;
  let itemId = '';
  const model: Model = {
    complete: async (_prompt, messages, tools) => {
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        'get_hint',
        'get_problem_description',
        'get_progress',
        'list_problems',
        'run_tests',
        'submit_solution',
      ]);
      if (++round === 1)
        return {
          text: '',
          calls: [
            { id: 'read', name: 'get_practice_queue', args: {} },
            {
              id: 'move',
              name: 'reschedule_practice_review',
              args: { item_id: itemId, days_ahead: 30, expected_version: 0 },
            },
            {
              id: 'grade',
              name: 'record_practice_reflection',
              args: { item_id: itemId, answer: 'Model-authored recall', self_rating: 'recalled' },
            },
          ],
        };
      const replies = messages.filter((message) => message.role === 'tool');
      expect(replies).toHaveLength(3);
      expect(replies.every((message) => message.text.includes('not available'))).toBe(true);
      return { text: 'Explain your invariant in your own words.', calls: [] };
    },
  };
  const service = new WorkbenchService(
    new LocalStore(directory),
    new McpConnection(resolve('../..'), directory),
    vault,
    () => {},
    () => model,
  );
  try {
    await service.initialize();
    await service.startProblem('0015-delivery-hold-clusters');
    const item = await service.addPracticeReview(
      'coding',
      service.snapshot().sessions[0].attemptId,
      0,
    );
    itemId = item.id;
    await service.updateSettings({ ...defaultSettings, provider: 'ollama' });
    await service.chat('One small hint');
    expect((await service.practiceQueue()).items[0]).toEqual(item);
    expect(await service.practiceReflections(itemId)).toEqual([]);
  } finally {
    await service.close();
  }
});
