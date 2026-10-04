import { Client, StreamableHTTPClientTransport, type Tool } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
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
]);

export class McpConnection {
  private client: Client | null = null;
  tools: Tool[] = [];
  constructor(
    private readonly root: string,
    private readonly data: string,
    private readonly backend?: string,
  ) {}

  async connect(settings: StoredSettings, key: string): Promise<void> {
    await this.close();
    const client = new Client({ name: 'interview-workbench', version: '0.1.0' });
    this.client = client;
    try {
      if (settings.connection === 'remote') {
        if (!key) throw new Error('Add the personal MCP bearer key in Settings');
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
      this.tools = (await client.listTools()).tools.filter((tool) => allowedTools.has(tool.name));
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
    await client?.close().catch(() => {});
  }
}
