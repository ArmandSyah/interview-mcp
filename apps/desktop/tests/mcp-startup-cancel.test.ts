import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { McpConnection } from '../src/main/mcp';
import { defaultSettings } from '../src/main/storage';

const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
const stages = ['initialize', 'tools/list', 'get_connection_identity'] as const;

// Exercise the real HTTP client. Synthetic bearer values do not test account authentication.
async function serverFixture(stage: (typeof stages)[number]) {
  let origin = '';
  let hold = true;
  let releaseHeld = () => {};
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const requests: string[] = [];
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
    const method = body.method === 'tools/call' ? body.params.name : body.method;
    requests.push(method);
    let result: unknown;
    if (method === 'initialize')
      result = {
        protocolVersion: body.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'startup-cancel-fixture', version: '1.0.0' },
      };
    else if (method === 'tools/list')
      result = {
        tools: ['start_problem', 'get_connection_identity'].map((name) => ({
          name,
          inputSchema: { type: 'object' },
        })),
      };
    else if (method === 'get_connection_identity') {
      const identity = {
        user_id: request.headers.authorization === 'Bearer fixture-bob' ? bob : alice,
        issuer: `${origin}/auth/v1`,
        backend: 'supabase',
      };
      result = {
        content: [{ type: 'text', text: JSON.stringify(identity) }],
        structuredContent: identity,
      };
    } else {
      response.writeHead(400).end();
      return;
    }
    const send = () => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    };
    if (hold && method === stage) {
      hold = false;
      let released = false;
      releaseHeld = () => {
        if (released) return;
        released = true;
        send();
      };
      entered();
    } else send();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture listener unavailable');
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    url: `${origin}/mcp`,
    requests,
    waiting,
    release: () => releaseHeld(),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

for (const stage of stages) {
  it(`HTTP startup cancellation during ${stage} clears metadata and permits a fresh connection`, async () => {
    const server = await serverFixture(stage);
    const data = await mkdtemp(join(tmpdir(), 'interview-http-startup-cancel-'));
    const connection = new McpConnection(resolve('../..'), data);
    const controller = new AbortController();
    const settings = { ...defaultSettings, connection: 'remote' as const, mcpUrl: server.url };
    const startup = connection.connect(settings, 'fixture-alice', controller.signal).then(
      () => ({ status: 'connected' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    try {
      await Promise.race([
        server.waiting,
        startup.then((result) => {
          throw new Error(`Startup ended before the held ${stage} request: ${result.status}`);
        }),
      ]);
      expect(server.requests).toEqual(stages.slice(0, stages.indexOf(stage) + 1));
      controller.abort();
      expect((await startup).status).toBe('rejected');
      await Promise.all([connection.close(), connection.close()]);
      expect(connection.accountIdentity).toBeNull();
      expect(connection.tools).toEqual([]);
      expect(connection.usesLocalExecution).toBe(false);
      server.release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(connection.accountIdentity).toBeNull();
      expect(connection.tools).toEqual([]);
      await expect(connection.call('start_problem', {})).rejects.toThrow('disconnected');
      await connection.connect(settings, 'fixture-bob');
      expect(connection.accountIdentity).toEqual({
        userId: bob,
        issuer: `${server.origin}/auth/v1`,
      });
      expect(connection.tools.map((tool) => tool.name)).toEqual(['start_problem']);
      expect(server.requests).toEqual([...stages.slice(0, stages.indexOf(stage) + 1), ...stages]);
    } finally {
      controller.abort();
      await connection.close();
      server.release();
      await startup;
      await server.close();
    }
  });
}
