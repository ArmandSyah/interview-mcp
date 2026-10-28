import { expect, it, vi } from 'vitest';
import { executeLocalPlan, type ExecutionPlan } from '../src/main/local-execution';

const plan: ExecutionPlan = {
  attempt_id: '11111111-1111-4111-8111-111111111111',
  problem_id: 'fixture-identity',
  problem_revision: 'a'.repeat(64),
  function_name: 'identity',
  python_version: '3.12.0',
  test_cases: [{ input: ['quoted "text"\n😀'], expected: 'quoted "text"\n😀' }],
  execution_source: 'local_report',
  verification: 'not_server_verified',
};

it('sends source only to loopback Piston without MCP or model credentials', async () => {
  const request = vi.fn<typeof fetch>(async (_url, init) => {
    expect(_url).toBe('http://127.0.0.1:2000/api/v2/execute');
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    expect(init?.redirect).toBe('error');
    const body = JSON.parse(String(init?.body));
    expect(body.run_timeout).toBe(3000);
    expect(body.run_memory_limit).toBe(268435456);
    expect(body.files[0].content).toContain('json.loads(');
    return Response.json({
      run: { code: 0, stdout: '__INTERVIEW_MCP_RESULT__\n"value"\n', stderr: '', wall_time: 12 },
    });
  });
  expect(
    await executeLocalPlan(
      plan,
      'def identity(value):\n    return value',
      'http://127.0.0.1:2000',
      undefined,
      request,
    ),
  ).toEqual([
    { index: 0, actual: 'value', user_stdout: '', user_stderr: '', error: null, wall_time_ms: 12 },
  ]);
});

it.each([
  { run: { code: 1, stdout: 'trace', stderr: 'bad code' } },
  { run: { code: null, signal: 'SIGKILL', stdout: '', stderr: '' } },
  { run: { code: 0, stdout: 'no result', stderr: '' } },
  { run: { code: 0, stdout: '__INTERVIEW_MCP_RESULT__\ninvalid json', stderr: '' } },
  { run: { code: 0, stdout: '__INTERVIEW_MCP_RESULT__\n9007199254740992', stderr: '' } },
  { run: { code: 0, stdout: '__INTERVIEW_MCP_RESULT__\n"' + 'x'.repeat(16001) + '"', stderr: '' } },
  { unexpected: true },
])('returns an explicit failure for invalid or failed execution: %j', async (body) => {
  const request: typeof fetch = async () => Response.json(body);
  const results = await executeLocalPlan(plan, 'pass', 'http://localhost:2000', undefined, request);
  expect(results[0].error).toBeTruthy();
});

it('does not expose transport errors, source, or upstream response bodies', async () => {
  const request: typeof fetch = async () => {
    throw new Error('private source text');
  };
  const results = await executeLocalPlan(plan, 'pass', 'http://localhost:2000', undefined, request);
  expect(JSON.stringify(results)).not.toContain('private source');
  expect(results[0].error).toContain('Local code execution failed');
});

it('does not execute an untrusted entry point, unsafe number, empty draft, or remote URL', async () => {
  const request = vi.fn<typeof fetch>();
  for (const [recipe, code, url] of [
    [{ ...plan, function_name: '__import__("os").system' }, 'pass', 'http://localhost:2000'],
    [
      { ...plan, test_cases: [{ input: [9007199254740992], expected: 1 }] },
      'pass',
      'http://localhost:2000',
    ],
    [plan, ' ', 'http://localhost:2000'],
    [plan, 'pass', 'https://external.example'],
    [plan, 'pass', 'http://user:password@localhost:2000'],
  ] satisfies [ExecutionPlan, string, string][]) {
    await expect(executeLocalPlan(recipe, code, url, undefined, request)).rejects.toThrow();
  }
  expect(request).not.toHaveBeenCalled();
});

it('cancels before any execution request', async () => {
  const abort = new AbortController();
  abort.abort();
  const request = vi.fn<typeof fetch>();
  await expect(
    executeLocalPlan(plan, 'pass', 'http://localhost:2000', abort.signal, request),
  ).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});
