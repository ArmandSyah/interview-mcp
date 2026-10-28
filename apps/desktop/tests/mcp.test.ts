import { mkdtemp, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { McpConnection } from '../src/main/mcp';
import { defaultSettings } from '../src/main/storage';
import type { Problem } from '../src/shared/types';

it('connects to the real Python MCP sidecar and uses artifact-only scaffolding', async () => {
  const data = await mkdtemp(join(tmpdir(), 'interview-sidecar-'));
  const root = resolve('../..');
  const connection = new McpConnection(root, data);
  try {
    await connection.connect(defaultSettings, '');
    expect(connection.tools.map((tool) => tool.name)).toContain('run_tests');
    const problems = await connection.call<Problem[]>('list_problems', {});
    expect(problems.length).toBe(5);
    const started = await connection.call<{
      attempt_id: string;
      mode: string;
      files_written: string[];
      files_to_create: { relative_path: string; contents: string }[];
    }>('start_problem', { problem_id: '0015-delivery-hold-clusters' });
    expect(started.mode).toBe('remote');
    expect(started.files_written).toEqual([]);
    expect(started.files_to_create[0].contents).toContain('pass');
    expect(
      await connection.call<string>('get_problem_description', { attempt_id: started.attempt_id }),
    ).toContain('Delivery');
    const hint = await connection.call<{ hint: string; used_fallback: boolean }>('get_hint', {
      attempt_id: started.attempt_id,
      current_code: '',
      depth: 1,
    });
    expect(hint.used_fallback).toBe(true);
    expect(hint.hint.length).toBeGreaterThan(10);
    await expect(connection.call('shell', {})).rejects.toThrow('not permitted');
    await expect(access(join(root, '0015-delivery-hold-clusters/solution.py'))).rejects.toThrow();
  } finally {
    await connection.close();
  }
});
