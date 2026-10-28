import { assertEquals, assertRejects } from '@std/assert';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createSupabaseAuthenticator, type Identity } from './auth.ts';
import { createHandler, MAX_REQUEST_BYTES } from './handler.ts';
import { z } from 'zod';

const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
const issuer = 'https://example.supabase.co/auth/v1';
const identity: Identity = { userId: alice, issuer };
const request = (headers: HeadersInit = {}, body = '{}', method = 'POST') =>
  new Request('http://127.0.0.1/interview-mcp', {
    method,
    headers,
    body: method === 'POST' ? body : null,
  });

Deno.test('missing or malformed bearer credentials do not reach authentication', async () => {
  let calls = 0;
  const handler = createHandler(() => {
    calls++;
    return Promise.resolve(identity);
  });
  for (const Authorization of ['', 'Basic abc', 'Bearer a b', `Bearer ${'a'.repeat(8193)}`]) {
    const response = await handler(request({ Authorization }));
    assertEquals(response.status, 401);
    assertEquals(response.headers.get('Cache-Control'), 'no-store');
  }
  assertEquals(calls, 0);
});

Deno.test('invalid accounts are rejected without MCP results', async () => {
  const response = await createHandler(() => Promise.resolve(null))(
    request({ Authorization: 'Bearer invalid' }),
  );
  assertEquals(response.status, 401);
  assertEquals(await response.json(), { error: 'User authentication failed' });
});

Deno.test('authentication failures do not disclose credentials or provider errors', async () => {
  const response = await createHandler(() => Promise.reject(new Error('private-test-token')))(
    request({ Authorization: 'Bearer private-test-token' }),
  );
  assertEquals(response.status, 503);
  assertEquals(await response.json(), { error: 'Authentication service unavailable' });
});

Deno.test('invalid identity results fail closed', async () => {
  const response = await createHandler(() => Promise.resolve({ userId: 'not-an-account', issuer }))(
    request({ Authorization: 'Bearer token' }),
  );
  assertEquals(response.status, 503);
});

Deno.test('cross-origin browser requests are rejected before authentication', async () => {
  let calls = 0;
  const response = await createHandler(() => {
    calls++;
    return Promise.resolve(identity);
  })(request({ Origin: 'https://untrusted.example', Authorization: 'Bearer token' }));
  assertEquals(response.status, 403);
  assertEquals(calls, 0);
});

Deno.test('declared oversize requests are rejected before authentication', async () => {
  let calls = 0;
  const response = await createHandler(() => {
    calls++;
    return Promise.resolve(identity);
  })(request({ 'Content-Length': String(MAX_REQUEST_BYTES + 1), Authorization: 'Bearer token' }));
  assertEquals(response.status, 413);
  assertEquals(calls, 0);
});

Deno.test('streamed bodies have the same request limit', async () => {
  const response = await createHandler(() => Promise.resolve(identity))(
    request({ Authorization: 'Bearer token' }, 'x'.repeat(MAX_REQUEST_BYTES + 1)),
  );
  assertEquals(response.status, 413);
});

Deno.test('unsupported methods do not dispatch MCP tools', async () => {
  const response = await createHandler(() => Promise.resolve(identity))(
    request({ Authorization: 'Bearer token' }, '', 'GET'),
  );
  assertEquals(response.status, 405);
});

Deno.test('Supabase verifies the token with its user endpoint, not its decoded payload', async () => {
  const calls: { url: string; authorization: string | null }[] = [];
  const remote: typeof fetch = (input, init) => {
    calls.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('Authorization'),
    });
    return Promise.resolve(
      Response.json({ id: alice, role: 'authenticated', is_anonymous: false }),
    );
  };
  const authenticate = createSupabaseAuthenticator(
    'https://example.supabase.co',
    'test-publishable-key',
    remote,
  );
  assertEquals(await authenticate(request(), 'verified-by-provider'), identity);
  assertEquals(calls, [{
    url: 'https://example.supabase.co/auth/v1/user',
    authorization: 'Bearer verified-by-provider',
  }]);
});

Deno.test('anonymous accounts and service-role identities are not app users', async () => {
  for (
    const user of [{ id: alice, role: 'authenticated', is_anonymous: true }, {
      id: alice,
      role: 'service_role',
    }, { id: 'invalid', role: 'authenticated' }]
  ) {
    const remote: typeof fetch = () => Promise.resolve(Response.json(user));
    const authenticate = createSupabaseAuthenticator(
      'https://example.supabase.co',
      'test-publishable-key',
      remote,
    );
    assertEquals(await authenticate(request(), 'token'), null);
  }
});

Deno.test('real MCP transport keeps identities request-scoped and rejects forged arguments', async () => {
  const handler = createHandler((_request, token) =>
    Promise.resolve({ userId: token === 'alice' ? alice : bob, issuer })
  );
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, handler);
  const url = new URL(`http://127.0.0.1:${server.addr.port}/interview-mcp`);
  const a = new Client({ name: 'alice-test', version: '1.0.0' });
  const b = new Client({ name: 'bob-test', version: '1.0.0' });
  try {
    await a.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: 'Bearer alice' } },
      }),
    );
    await b.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: 'Bearer bob' } },
      }),
    );
    assertEquals((await a.callTool({ name: 'ping' })).structuredContent, { result: 'pong' });
    const [first, second] = await Promise.all([
      a.callTool({ name: 'get_connection_identity' }),
      b.callTool({ name: 'get_connection_identity' }),
    ]);
    const result = z.object({ user_id: z.string(), practice_tools_available: z.boolean() });
    const firstIdentity = result.parse(first.structuredContent);
    const secondIdentity = result.parse(second.structuredContent);
    assertEquals(firstIdentity.user_id, alice);
    assertEquals(secondIdentity.user_id, bob);
    assertEquals(firstIdentity.practice_tools_available, false);
    assertEquals(
      (await a.callTool({ name: 'get_connection_identity', arguments: { user_id: bob } })).isError,
      true,
    );
    await assertRejects(() =>
      a.callTool({ name: 'start_problem', arguments: { problem_id: 'unimplemented' } })
    );
  } finally {
    await a.close();
    await b.close();
    await server.shutdown();
  }
});
