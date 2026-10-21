import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { McpConnection } from '../src/main/mcp';
import { LocalStore, defaultSettings } from '../src/main/storage';
import { WorkbenchService } from '../src/main/service';
import type { ExecutionPlan } from '../src/main/local-execution';

const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
const attemptId = '33333333-3333-4333-8333-333333333333';
const problemId = 'fixture-identity';
const plan: ExecutionPlan = {
  attempt_id: attemptId,
  problem_id: problemId,
  problem_revision: 'a'.repeat(64),
  function_name: 'identity',
  python_version: '3.12.0',
  test_cases: [{ input: ['quoted "text"\n😀'], expected: 'quoted "text"\n😀' }],
  execution_source: 'local_report',
  verification: 'not_server_verified',
};
const draft = 'def identity(value):\n    return value\n';

// This fixture tests the actual HTTP MCP client, not Supabase token verification.
async function remoteFixture(identityMode: 'valid' | 'wrong-issuer' = 'valid') {
  const requests: { name: string; args: Record<string, unknown> }[] = [];
  let origin = '';
  const names = [
    'get_connection_identity',
    'list_problems',
    'start_problem',
    'get_problem_description',
    'get_hint',
    'get_progress',
    'get_local_execution_plan',
    'record_local_execution',
  ];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    let result: unknown;
    if (body.method === 'initialize')
      result = {
        protocolVersion: body.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'wire-fixture', version: '1.0.0' },
      };
    else if (body.method === 'tools/list')
      result = { tools: names.map((name) => ({ name, inputSchema: { type: 'object' } })) };
    else {
      const name = body.params.name;
      const args = body.params.arguments ?? {};
      requests.push({ name, args });
      let value: unknown;
      if (name === 'get_connection_identity')
        value = {
          user_id: request.headers.authorization?.includes('bob') ? bob : alice,
          issuer: identityMode === 'valid' ? `${origin}/auth/v1` : 'https://other.invalid/auth/v1',
          backend: 'supabase',
        };
      if (name === 'list_problems')
        value = [
          {
            id: problemId,
            title: 'Fixture identity',
            difficulty: 'easy',
            tags: [],
            pattern_tags: [],
          },
        ];
      if (name === 'get_progress') value = 'Fixture progress';
      if (name === 'get_hint')
        value = { hint: 'Which value must the function return?', depth: 1, used_fallback: true };
      if (name === 'get_problem_description') value = 'Return the supplied value.';
      if (name === 'start_problem') {
        const contents = 'def identity(value):\n    pass\n';
        value = {
          attempt_id: attemptId,
          mode: 'remote',
          files_to_create: [
            {
              relative_path: `${problemId}/solution.py`,
              contents,
              sha256: createHash('sha256').update(contents).digest('hex'),
            },
          ],
        };
      }
      if (name === 'get_local_execution_plan') value = plan;
      if (name === 'record_local_execution') {
        const tests = (args.tests as { actual: unknown; error: string | null }[]).map(
          (test, index) => ({
            ...test,
            input: plan.test_cases[index].input,
            expected: plan.test_cases[index].expected,
            passed:
              !test.error &&
              JSON.stringify(test.actual) === JSON.stringify(plan.test_cases[index].expected),
          }),
        );
        const testRun = {
          attempt_id: attemptId,
          problem_id: problemId,
          tests_total: tests.length,
          tests_passed: tests.filter((test) => test.passed).length,
          all_passed: tests.every((test) => test.passed),
          tests,
          execution_source: 'local_report',
          verification: 'not_server_verified',
        };
        value = args.submitted
          ? {
              completed: testRun.all_passed,
              test_run: testRun,
              followup_questions: 'What is the time cost?',
              message: 'Local report saved.',
            }
          : testRun;
      }
      result = {
        content: [{ type: 'text', text: JSON.stringify(value) }],
        structuredContent: name === 'get_connection_identity' ? value : { result: value },
      };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture listener unavailable');
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: `${origin}/functions/v1/interview-mcp`,
    requests,
    close: () =>
      new Promise<void>((done, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : done()));
      }),
  };
}

async function exerciseRemote(realPiston: boolean) {
  const fixture = await remoteFixture();
  const store = new LocalStore(await mkdtemp(join(tmpdir(), 'interview-remote-wire-')));
  const pistonFetch: typeof fetch = realPiston
    ? fetch
    : async (_url, init) => {
        expect(new Headers(init?.headers).has('Authorization')).toBe(false);
        const body = JSON.parse(String(init?.body));
        expect(body.files[0].content).toContain(draft);
        return Response.json({
          run: {
            code: 0,
            stdout: `__INTERVIEW_MCP_RESULT__\n${JSON.stringify(plan.test_cases[0].expected)}\n`,
            stderr: '',
            wall_time: 1,
          },
        });
      };
  const mcp = new McpConnection(resolve('../..'), store.root, undefined, pistonFetch);
  const service = new WorkbenchService(
    store,
    mcp,
    { available: () => false, encrypt: () => '', decrypt: () => '' },
    () => {},
  );
  await store.load();
  store.state.settings = { ...defaultSettings, connection: 'remote', mcpUrl: fixture.url };
  await store.persist();
  await service.initialize();
  try {
    // Long opaque tokens prove that workspace identity does not come from JWT decoding.
    await service.updateSettings({
      ...store.state.settings,
      mcpKey: 'alice-token-' + 'x'.repeat(600),
    });
    expect(service.snapshot().connection).toBe('connected');
    expect(mcp.accountIdentity?.userId).toBe(alice);
    expect(mcp.tools.map((tool) => tool.name)).toContain('run_tests');
    expect(mcp.tools.map((tool) => tool.name)).not.toContain('get_local_execution_plan');
    await expect(mcp.call('get_local_execution_plan', { attempt_id: attemptId })).rejects.toThrow(
      'not permitted',
    );
    await service.startProblem(problemId);
    await service.saveCode(problemId, draft);
    await service.runTests(false);
    expect(service.snapshot().sessions[0].result).toMatchObject({
      all_passed: true,
      verification: 'not_server_verified',
    });
    expect(service.snapshot().sessions[0].submitted).toBe(false);
    await service.runTests(true);
    expect(service.snapshot().sessions[0].submitted).toBe(true);
    const report = [...fixture.requests]
      .reverse()
      .find((request) => request.name === 'record_local_execution')!;
    expect(report.args.code_digest).toBe(createHash('sha256').update(draft).digest('hex'));
    expect(report.args).not.toHaveProperty('code');
    expect(report.args).not.toHaveProperty('owner_id');
    await service.updateSettings({ ...store.state.settings, mcpKey: 'alice-refreshed-token' });
    expect(service.snapshot().sessions[0].code).toBe(draft);
    await service.updateSettings({ ...store.state.settings, mcpKey: 'bob-token' });
    expect(service.snapshot().sessions).toEqual([]);
    await service.updateSettings({ ...store.state.settings, mcpKey: 'alice-another-token' });
    expect(service.snapshot().sessions[0].code).toBe(draft);
  } finally {
    await service.close();
    await fixture.close();
  }
}

it('connects remote practice, keeps account workspaces, and hides execution protocol tools from the coach', async () => {
  await exerciseRemote(false);
});

it.skipIf(process.env.INTERVIEW_DESKTOP_TEST_PISTON !== '1')(
  'executes a remote attempt through real local Piston',
  async () => {
    await exerciseRemote(true);
  },
);

it('rejects an account issuer from a different server and clears connection identity', async () => {
  const fixture = await remoteFixture('wrong-issuer');
  const mcp = new McpConnection(
    resolve('../..'),
    await mkdtemp(join(tmpdir(), 'interview-issuer-')),
  );
  try {
    await expect(
      mcp.connect({ ...defaultSettings, connection: 'remote', mcpUrl: fixture.url }, 'token'),
    ).rejects.toThrow('issuer');
    expect(mcp.accountIdentity).toBe(null);
    expect(mcp.tools).toEqual([]);
  } finally {
    await mcp.close();
    await fixture.close();
  }
});
