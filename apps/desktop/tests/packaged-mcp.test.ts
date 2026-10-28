import { mkdtemp, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { McpConnection } from '../src/main/mcp';
import { defaultSettings } from '../src/main/storage';

it('bundled MCP works without the source tree or a Python installation', async () => {
  const executable = resolve(
    'backend',
    process.platform === 'win32' ? 'interview-mcp.exe' : 'interview-mcp',
  );
  await access(executable);
  const data = await mkdtemp(join(tmpdir(), 'interview-bundled-'));
  const connection = new McpConnection(data, data, executable);
  try {
    await connection.connect(defaultSettings, '');
    expect(await connection.call('ping', {})).toBe('pong');
    expect(await connection.call<unknown[]>('list_problems', {})).toHaveLength(5);
    const result = await connection.call<{ attempt_id: string; mode: string }>('start_problem', {
      problem_id: '0015-delivery-hold-clusters',
    });
    expect(result.mode).toBe('remote');
    const hint = await connection.call<{ hint: string }>('get_hint', {
      attempt_id: result.attempt_id,
      current_code: '',
      depth: 1,
    });
    expect(hint.hint.length).toBeGreaterThan(10);
  } finally {
    await connection.close();
  }
});
