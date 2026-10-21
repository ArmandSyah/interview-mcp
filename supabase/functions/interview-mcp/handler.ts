import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { type Authenticate, validIdentity } from './auth.ts';

export const MAX_REQUEST_BYTES = 1_000_000;

function jsonError(status: number, message: string, headers?: HeadersInit): Response {
  return Response.json({ error: message }, {
    status,
    headers: { 'Cache-Control': 'no-store', ...headers },
  });
}

async function boundedRequest(request: Request): Promise<Request | null> {
  const reader = request.body?.getReader();
  if (!reader) return request;
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > MAX_REQUEST_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(count);
  let position = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, position);
    position += chunk.byteLength;
  }
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: bytes,
    signal: request.signal,
  });
}

export function createHandler(authenticate: Authenticate): (request: Request) => Promise<Response> {
  return async (request) => {
    // The desktop and editor clients do not need cross-origin browser access.
    if (request.headers.has('Origin')) return jsonError(403, 'Browser origin is not permitted');
    const length = request.headers.get('Content-Length');
    if (length && (!/^\d+$/.test(length) || Number(length) > MAX_REQUEST_BYTES)) {
      return jsonError(413, 'MCP request is too large');
    }
    const authorization = request.headers.get('Authorization') ?? '';
    const match = /^Bearer ([^\s]+)$/i.exec(authorization);
    if (!match || match[1].length > 8192) {
      return jsonError(401, 'User authentication is necessary', {
        'WWW-Authenticate': 'Bearer realm="interview-mcp"',
      });
    }
    let identity;
    try {
      identity = await authenticate(request, match[1]);
    } catch {
      return jsonError(503, 'Authentication service unavailable');
    }
    if (!identity) {
      return jsonError(401, 'User authentication failed', {
        'WWW-Authenticate': 'Bearer realm="interview-mcp"',
      });
    }
    if (!validIdentity(identity)) return jsonError(503, 'Authentication service unavailable');
    if (request.method !== 'POST') {
      return jsonError(405, 'Use MCP POST requests', { Allow: 'POST' });
    }
    let bounded;
    try {
      bounded = await boundedRequest(request);
    } catch {
      return jsonError(400, 'Request body could not be read');
    }
    if (!bounded) return jsonError(413, 'MCP request is too large');

    // This first deployment is an authenticated runtime probe, not a port of
    // the practice engine. Do not advertise unimplemented practice tools.
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: 'interview-workbench-cloud', version: '0.3.0-alpha.1' });
      server.registerTool('ping', {
        description: 'Return the MCP connection result.',
        inputSchema: z.object({}).strict(),
        annotations: { readOnlyHint: true, idempotentHint: true },
      }, () => ({
        content: [{ type: 'text', text: 'pong' }],
        structuredContent: { result: 'pong' },
      }));
      server.registerTool('get_connection_identity', {
        description: 'Return the authenticated account ID and this deployment status.',
        inputSchema: z.object({}).strict(),
        annotations: { readOnlyHint: true, idempotentHint: true },
      }, () => {
        const result = {
          user_id: identity.userId,
          issuer: identity.issuer,
          backend: 'supabase',
          status: 'runtime_probe_only',
          practice_tools_available: false,
          hosted_code_execution: false,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        };
      });
      return server;
    });
    const response = await handler.fetch(bounded);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  };
}
