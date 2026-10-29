import { Client, StreamableHTTPClientTransport, type Tool } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { executeLocalPlan, executionPlanSchema } from './local-execution';
import type { StoredSettings } from './storage';

export const allowedTools = new Set([
  'ping',
  'get_problem_catalog',
  'list_problems',
  'start_problem',
  'get_problem_description',
  'get_hint',
  'run_tests',
  'submit_solution',
  'get_progress',
  'list_design_problems',
  'start_design_session',
  'get_design_session',
  'get_design_brief',
  'save_design_checkpoint',
  'list_design_checkpoints',
  'get_design_snapshot',
  'get_design_hint',
  'evaluate_design',
  'finish_design_session',
  'list_content_packs',
  'install_content_pack',
  'export_practice_data',
  'list_practice_sources',
  'get_practice_queue',
  'get_practice_review',
  'add_practice_review',
  'reschedule_practice_review',
  'pause_practice_review',
  'list_practice_reflections',
  'record_practice_reflection',
]);

export class McpConnection {
  private client: Client | null = null;
  tools: Tool[] = [];
  accountIdentity: { userId: string; issuer: string } | null = null;
  private localExecution = false;
  private pistonUrl = '';
  get usesLocalExecution(): boolean {
    return this.localExecution;
  }
  constructor(
    private readonly root: string,
    private readonly data: string,
    private readonly backend?: string,
    private readonly pistonFetch: typeof fetch = fetch,
  ) {}

  async connect(settings: StoredSettings, key: string): Promise<void> {
    await this.close();
    const client = new Client({ name: 'interview-workbench', version: '0.2.0' });
    this.client = client;
    try {
      if (settings.connection === 'remote') {
        if (!key) throw new Error('Add an MCP bearer credential in Settings');
        const url = new URL(settings.mcpUrl);
        if (
          url.protocol !== 'https:' &&
          !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        )
          throw new Error('Remote MCP requires HTTPS (HTTP is only allowed on loopback)');
        if (url.username || url.password || url.search || url.hash)
          throw new Error('Do not put credentials or parameters in the MCP URL');
        await client.connect(
          new StreamableHTTPClientTransport(url, {
            requestInit: { headers: { Authorization: `Bearer ${key}` } },
          }),
        );
      } else {
        const python =
          process.env.INTERVIEW_DESKTOP_PYTHON ??
          join(
            this.root,
            process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python',
          );
        if (!this.backend && !existsSync(python))
          throw new Error(
            'Python environment missing. Run uv sync --frozen in the engine repo, or install the packaged desktop build.',
          );
        const env: Record<string, string> = {};
        for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL'])
          if (process.env[name]) env[name] = process.env[name]!;
        Object.assign(env, {
          PYTHONPATH: this.root,
          PYTHONUNBUFFERED: '1',
          INTERVIEW_MCP_DB_DIR: join(this.data, 'mcp-data'),
          INTERVIEW_MCP_MODE: 'remote',
          LLM_PROVIDER: 'fallback',
          PISTON_BASE_URL: settings.pistonUrl,
          INTERVIEW_MCP_PROBLEMS_DIR:
            settings.corpusPath ||
            process.env.INTERVIEW_DESKTOP_PROBLEMS_DIR ||
            (this.backend
              ? join(this.backend, '..', '_internal', 'problems/examples')
              : join(this.root, 'problems/examples')),
        });
        const transport = new StdioClientTransport({
          command: this.backend ?? python,
          args: this.backend ? [] : ['-m', 'server.desktop'],
          cwd: this.root,
          env,
          stderr: 'pipe',
        });
        // Do not forward sidecar logs to the renderer or persist private content.
        transport.stderr?.on('data', () => {});
        await client.connect(transport);
      }
      const advertised = (await client.listTools()).tools;
      if (
        settings.connection === 'remote' &&
        advertised.some((tool) => tool.name === 'get_connection_identity')
      ) {
        const response = await client.callTool({ name: 'get_connection_identity', arguments: {} });
        if (response.isError) throw new Error('Cannot verify the remote account identity');
        const raw =
          response.structuredContent ??
          JSON.parse(
            response.content
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join(''),
          );
        const identity = z
          .object({
            user_id: z.string().uuid(),
            issuer: z.string().url(),
            backend: z.literal('supabase'),
          })
          .parse(raw);
        if (identity.issuer !== `${new URL(settings.mcpUrl).origin}/auth/v1`)
          throw new Error('The account issuer does not agree with the MCP server');
        // The authenticated server supplies identity. Never decode an unverified JWT.
        this.accountIdentity = { userId: identity.user_id, issuer: identity.issuer };
      }
      this.tools = advertised.filter((tool) => allowedTools.has(tool.name));
      this.localExecution =
        !!this.accountIdentity &&
        ['get_local_execution_plan', 'record_local_execution'].every((name) =>
          advertised.some((tool) => tool.name === name),
        );
      this.pistonUrl = settings.pistonUrl;
      if (this.localExecution) {
        for (const name of ['run_tests', 'submit_solution']) {
          if (this.tools.some((tool) => tool.name === name))
            throw new Error('The server advertises conflicting execution methods');
          this.tools.push({
            name,
            description:
              'Execute the saved draft in local Docker and save a personal practice report. This is not a server-verified grade.',
            inputSchema: {
              type: 'object',
              properties: { attempt_id: { type: 'string' }, code: { type: 'string' } },
              required: ['attempt_id', 'code'],
              additionalProperties: false,
            },
          });
        }
      }
      if (!this.tools.some((tool) => tool.name === 'start_problem'))
        throw new Error('Connected server does not expose interview practice tools');
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async call<T = unknown>(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!this.client) throw new Error('MCP is disconnected. Reconnect in Settings.');
    if (!allowedTools.has(name) || !this.tools.some((tool) => tool.name === name))
      throw new Error('Tool is not permitted');
    if (this.localExecution && ['run_tests', 'submit_solution'].includes(name)) {
      const input = z
        .object({ attempt_id: z.string().uuid(), code: z.string() })
        .strict()
        .parse(args);
      const plan = executionPlanSchema.parse(
        await this.request('get_local_execution_plan', { attempt_id: input.attempt_id }, signal),
      );
      if (plan.attempt_id !== input.attempt_id)
        throw new Error('The execution plan belongs to a different attempt');
      const tests = await executeLocalPlan(
        plan,
        input.code,
        this.pistonUrl,
        signal,
        this.pistonFetch,
      );
      return this.request<T>(
        'record_local_execution',
        {
          attempt_id: input.attempt_id,
          execution_id: randomUUID(),
          code_digest: createHash('sha256').update(input.code).digest('hex'),
          submitted: name === 'submit_solution',
          tests,
        },
        signal,
      );
    }
    return this.request<T>(name, args, signal);
  }

  private async request<T = unknown>(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!this.client) throw new Error('MCP is disconnected');
    const result = await this.client.callTool(
      { name, arguments: args },
      { signal, timeout: 180_000 },
    );
    if (result.isError)
      throw new Error(
        result.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n'),
      );
    if (result.structuredContent) {
      const structured = result.structuredContent as Record<string, unknown>;
      // FastMCP wraps non-object return types in {result: ...}.
      return ('result' in structured ? structured.result : structured) as T;
    }
    const text = result.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.tools = [];
    this.accountIdentity = null;
    this.localExecution = false;
    this.pistonUrl = '';
    await client?.close().catch(() => {});
  }
}
