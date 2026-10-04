import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { WorkbenchService, type Vault } from '../src/main/service';
import { LocalStore, defaultSettings } from '../src/main/storage';
import type { McpConnection } from '../src/main/mcp';
import type { Model } from '../src/main/providers';
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
async function fixture(model?: Model, vault = memoryVault) {
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
    model ? () => model : undefined,
  );
  await service.initialize();
  return { service, store, mcp, events };
}

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
