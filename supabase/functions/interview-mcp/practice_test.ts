import { assertEquals, assertRejects } from '@std/assert';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createHandler } from './handler.ts';
import { createPracticeFactory, PracticeError } from './practice.ts';

const userId = '11111111-1111-4111-8111-111111111111';

Deno.test('practice SDK sends the caller token, not an administrative credential', async () => {
  const requests: { url: string; authorization: string | null; body: unknown }[] = [];
  const remote: typeof fetch = (_input, init) => {
    requests.push({
      url: String(_input),
      authorization: new Headers(init?.headers).get('Authorization'),
      body: JSON.parse(String(init?.body)),
    });
    return Promise.resolve(Response.json([{ id: 'public-example' }]));
  };
  const factory = createPracticeFactory(
    'https://example.supabase.co',
    'test-publishable-key',
    remote,
  );
  const a = factory(new Request('http://localhost/'), 'alice-token');
  const b = factory(new Request('http://localhost/'), 'bob-token');
  await Promise.all([a('list_problems', {}), b('get_progress', { limit: 50 })]);
  assertEquals(requests, [
    {
      url: 'https://example.supabase.co/rest/v1/rpc/iwb_practice',
      authorization: 'Bearer alice-token',
      body: { operation: 'list_problems', arguments: {} },
    },
    {
      url: 'https://example.supabase.co/rest/v1/rpc/iwb_practice',
      authorization: 'Bearer bob-token',
      body: { operation: 'get_progress', arguments: { limit: 50 } },
    },
  ]);
});

Deno.test('only known contract errors can leave the practice adapter', async () => {
  for (const message of ['Design session not found.', 'secret upstream response with a token']) {
    const remote: typeof fetch = () =>
      Promise.resolve(Response.json({ message, code: 'P0001' }, { status: 400 }));
    const call = createPracticeFactory('https://example.supabase.co', 'test-key', remote)(
      new Request('http://localhost/'),
      'token',
    );
    const error = await assertRejects(() => call('get_design_brief', {}), Error);
    assertEquals(
      error.message,
      message.startsWith('Design') ? message : 'Practice service unavailable.',
    );
    assertEquals(error instanceof PracticeError, message.startsWith('Design'));
  }
});

Deno.test('MCP dispatch validates practice arguments and does not advertise unavailable execution', async () => {
  const calls: { token: string; name: string; args: Record<string, unknown> }[] = [];
  const handler = createHandler(
    () => Promise.resolve({ userId, issuer: 'https://example.supabase.co/auth/v1' }),
    (_request, token) => (name, args) => {
      calls.push({ token, name, args });
      if (name === 'get_design_brief') throw new Error('private database details');
      if (name === 'get_design_snapshot') throw new PracticeError('Design checkpoint not found.');
      return Promise.resolve({ called: name });
    },
  );
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, handler);
  const client = new Client({ name: 'practice-test', version: '1.0.0' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.addr.port}/`), {
        requestInit: { headers: { Authorization: 'Bearer account-token' } },
      }),
    );
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    assertEquals(tools.length, 17);
    for (
      const missing of [
        'run_tests',
        'submit_solution',
        'install_content_pack',
        'get_practice_queue',
      ]
    ) {
      assertEquals(tools.includes(missing), false);
    }
    assertEquals(
      (await client.callTool({
        name: 'start_problem',
        arguments: { problem_id: 'public-example' },
      })).structuredContent,
      { result: { called: 'start_problem' } },
    );
    assertEquals(calls, [{
      token: 'account-token',
      name: 'start_problem',
      args: { problem_id: 'public-example', language: 'python' },
    }]);
    for (
      const arguments_ of [
        { problem_id: 'public-example', owner_id: userId },
        { problem_id: '../private' },
        { problem_id: 'public-example', language: 'javascript' },
      ]
    ) {
      assertEquals(
        (await client.callTool({ name: 'start_problem', arguments: arguments_ })).isError,
        true,
      );
    }
    assertEquals(calls.length, 1);
    for (
      const [name, expected] of [
        ['get_design_brief', 'Practice service unavailable.'],
        ['get_design_snapshot', 'Design checkpoint not found.'],
      ]
    ) {
      const result = await client.callTool({
        name,
        arguments: {
          session_id: userId,
          ...(name === 'get_design_snapshot' ? { checkpoint_id: userId } : {}),
        },
      });
      assertEquals(result.isError, true);
      assertEquals(result.content, [{ type: 'text', text: expected }]);
    }
  } finally {
    await client.close();
    await server.shutdown();
  }
});
