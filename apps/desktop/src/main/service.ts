import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LocalStore } from './storage';
import { McpConnection } from './mcp';
import { runAgent } from './agent';
import { AnthropicModel, OllamaModel, type Model } from './providers';
import type {
  AppEvent,
  ChatItem,
  PracticeSession,
  Problem,
  Settings,
  SettingsUpdate,
  Snapshot,
  Submission,
  TestRun,
} from '../shared/types';

export interface Vault {
  available(): boolean;
  encrypt(value: string): string;
  decrypt(value: string): string;
}
export const settingsSchema = z
  .object({
    provider: z.enum(['disabled', 'ollama', 'anthropic']),
    model: z.string().min(1).max(120),
    ollamaUrl: z.string().max(500),
    corpusPath: z.string().max(4000),
    pistonUrl: z.string().max(500),
    connection: z.enum(['local', 'remote']),
    mcpUrl: z.string().max(1000),
    apiKey: z.string().max(500).optional(),
    mcpKey: z.string().max(500).optional(),
    clearApiKey: z.boolean().optional(),
    clearMcpKey: z.boolean().optional(),
  })
  .strict();

type Scaffold = {
  attempt_id: string;
  mode: string;
  files_to_create: { relative_path: string; contents: string; sha256: string }[];
};

export class WorkbenchService {
  private apiKey = '';
  private mcpKey = '';
  private scope = '';
  private connection: Snapshot['connection'] = 'disconnected';
  private error: string | null = null;
  private busy = false;
  private problems: Problem[] = [];
  private progress = '';
  private agent: AbortController | null = null;
  private approvals = new Map<string, (allow: boolean) => void>();

  constructor(
    readonly store: LocalStore,
    private readonly mcp: McpConnection,
    private readonly vault: Vault,
    private readonly emit: (event: AppEvent) => void,
    private readonly modelFactory?: (settings: Settings, key: string) => Model,
  ) {}

  async initialize(): Promise<void> {
    await this.store.load();
    let credentialError: string | null = null;
    if (this.vault.available()) {
      try {
        this.apiKey = this.store.state.credentials.apiKey
          ? this.vault.decrypt(this.store.state.credentials.apiKey)
          : '';
        this.mcpKey = this.store.state.credentials.mcpKey
          ? this.vault.decrypt(this.store.state.credentials.mcpKey)
          : '';
      } catch {
        credentialError = 'Saved credentials could not be unlocked. Re-enter them in Settings.';
      }
    }
    this.scope = this.store.scope(this.mcpKey);
    await this.reconnect();
    if (credentialError) {
      this.error = credentialError;
      this.publish();
    }
  }

  settings(): Settings {
    return {
      ...this.store.state.settings,
      hasApiKey: !!this.apiKey,
      hasMcpKey: !!this.mcpKey,
      secureStorage: this.vault.available(),
    };
  }

  snapshot(): Snapshot {
    const workspace = this.store.workspace(this.scope);
    return structuredClone({
      settings: this.settings(),
      problems: this.problems,
      sessions: workspace.sessions,
      activeProblemId: workspace.activeProblemId,
      welcomeChat: workspace.chat,
      progress: this.progress,
      connection: this.connection,
      error: this.error,
      busy: this.busy,
      workspacePath: this.store.root,
    });
  }
  private publish(): void {
    this.emit({ type: 'snapshot', snapshot: this.snapshot() });
  }
  private active(): PracticeSession | undefined {
    const workspace = this.store.workspace(this.scope);
    return workspace.sessions.find((session) => session.problem.id === workspace.activeProblemId);
  }
  private requiredSession(): PracticeSession {
    const session = this.active();
    if (!session) throw new Error('Choose a problem first');
    return session;
  }
  private idle(): void {
    if (this.busy)
      throw new Error('An operation is still running. Stop it or wait before switching.');
  }
  private sanitize(error: unknown): string {
    let text = error instanceof Error ? error.message : 'Operation failed';
    for (const key of [this.apiKey, this.mcpKey])
      if (key) text = text.split(key).join('[redacted]');
    return text.slice(0, 1200);
  }

  async reconnect(): Promise<void> {
    this.idle();
    this.busy = true;
    this.connection = 'connecting';
    this.error = null;
    this.publish();
    try {
      await this.mcp.connect(this.store.state.settings, this.mcpKey);
      this.scope = this.store.scope(this.mcpKey);
      this.problems = await this.mcp.call<Problem[]>('list_problems', {});
      this.progress = await this.mcp.call<string>('get_progress', {});
      this.connection = 'connected';
    } catch (error) {
      this.connection = 'disconnected';
      this.problems = [];
      this.error = this.sanitize(error);
    }
    this.busy = false;
    this.publish();
  }

  async updateSettings(input: SettingsUpdate): Promise<void> {
    this.idle();
    const { apiKey, mcpKey, clearApiKey, clearMcpKey, ...settings } = settingsSchema.parse(input);
    for (const value of [settings.ollamaUrl, settings.pistonUrl]) {
      const url = new URL(value);
      if (
        url.protocol !== 'http:' ||
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error('Local services must use HTTP loopback URLs');
    }
    if (settings.connection === 'remote') {
      const url = new URL(settings.mcpUrl);
      if (url.username || url.password || url.search || url.hash)
        throw new Error('Do not put credentials or parameters in the MCP URL');
      if (
        url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      )
        throw new Error('Use HTTPS for a remote MCP connection');
    }
    this.store.state.settings = settings;
    if (clearApiKey) this.apiKey = '';
    else if (apiKey) this.apiKey = apiKey;
    if (clearMcpKey) this.mcpKey = '';
    else if (mcpKey) this.mcpKey = mcpKey;
    this.store.state.credentials = this.vault.available()
      ? {
          ...(this.apiKey ? { apiKey: this.vault.encrypt(this.apiKey) } : {}),
          ...(this.mcpKey ? { mcpKey: this.vault.encrypt(this.mcpKey) } : {}),
        }
      : {};
    await this.store.persist();
    await this.reconnect();
  }

  async startProblem(id: string): Promise<void> {
    this.idle();
    const workspace = this.store.workspace(this.scope);
    const existing = workspace.sessions.find((session) => session.problem.id === id);
    if (existing) return this.activateProblem(id);
    const problem = this.problems.find((problem) => problem.id === id);
    if (!problem) throw new Error('Problem is not in the connected catalog');
    this.busy = true;
    this.error = null;
    this.publish();
    try {
      const result = await this.mcp.call<Scaffold>('start_problem', { problem_id: id });
      const artifact = result.files_to_create?.find(
        (file) => file.relative_path === `${id}/solution.py`,
      );
      if (
        result.mode !== 'remote' ||
        !artifact ||
        createHash('sha256').update(artifact.contents).digest('hex') !== artifact.sha256
      )
        throw new Error('Server did not return a valid artifact-only scaffold');
      const description = await this.mcp.call<string>('get_problem_description', {
        attempt_id: result.attempt_id,
      });
      const session: PracticeSession = {
        problem,
        attemptId: result.attempt_id,
        code: artifact.contents,
        description,
        chat: [],
        result: null,
        resultStale: false,
        submitted: false,
        hintDepth: 0,
        updatedAt: Date.now(),
      };
      workspace.sessions.push(session);
      workspace.activeProblemId = id;
      await this.store.saveCode(this.scope, session);
      this.progress = await this.mcp.call<string>('get_progress', {});
    } catch (error) {
      this.error = this.sanitize(error);
      throw new Error(this.error);
    } finally {
      this.busy = false;
      this.publish();
    }
  }

  async activateProblem(id: string): Promise<void> {
    this.idle();
    const workspace = this.store.workspace(this.scope);
    if (!workspace.sessions.some((session) => session.problem.id === id))
      throw new Error('No saved attempt for this problem');
    workspace.activeProblemId = id;
    await this.store.persist();
    this.publish();
  }

  async saveCode(id: string, code: string): Promise<void> {
    if (Buffer.byteLength(code, 'utf8') > 100_000) throw new Error('Code must be at most 100 KB');
    const session = this.store
      .workspace(this.scope)
      .sessions.find((session) => session.problem.id === id);
    if (!session) throw new Error('No active workspace for this problem');
    if (session.code === code) return;
    session.code = code;
    session.updatedAt = Date.now();
    session.resultStale = !!session.result;
    await this.store.saveCode(this.scope, session);
  }

  private record(session: PracticeSession | undefined, item: ChatItem): void {
    const chat = session?.chat ?? this.store.workspace(this.scope).chat;
    const index = chat.findIndex((existing) => existing.id === item.id);
    if (index >= 0) chat[index] = item;
    else chat.push(item);
    if (chat.length > 200) chat.splice(0, chat.length - 200);
    this.emit({ type: 'chat', item, problemId: session?.problem.id ?? '' });
  }

  async runTests(submit: boolean): Promise<void> {
    this.idle();
    const session = this.requiredSession();
    const code = session.code;
    this.busy = true;
    this.error = null;
    this.publish();
    try {
      await this.execute(submit ? 'submit_solution' : 'run_tests', {}, session, code);
    } catch (error) {
      this.error = this.sanitize(error);
      throw new Error(this.error);
    } finally {
      this.busy = false;
      await this.store.persist();
      this.publish();
    }
  }

  async hint(): Promise<void> {
    this.idle();
    const session = this.requiredSession();
    this.busy = true;
    this.error = null;
    this.publish();
    try {
      const depth = Math.min(3, session.hintDepth + 1);
      const result = (await this.execute('get_hint', { depth }, session, session.code)) as {
        hint: string;
      };
      this.record(session, {
        id: randomUUID(),
        role: 'assistant',
        text: result.hint,
        timestamp: Date.now(),
      });
    } catch (error) {
      this.error = this.sanitize(error);
      throw new Error(this.error);
    } finally {
      this.busy = false;
      await this.store.persist();
      this.publish();
    }
  }

  private async execute(
    name: string,
    args: Record<string, unknown>,
    session?: PracticeSession,
    code?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const input = { ...args };
    if (['get_problem_description', 'get_hint', 'run_tests', 'submit_solution'].includes(name)) {
      if (!session) throw new Error('Choose a problem first');
      input.attempt_id = session.attemptId;
    }
    if (['run_tests', 'submit_solution'].includes(name)) input.code = code;
    if (name === 'get_hint') {
      input.current_code = code;
      const depth = z
        .number()
        .int()
        .min(1)
        .max(3)
        .parse(input.depth ?? 1);
      if (depth > (session?.hintDepth ?? 0) + 1)
        throw new Error('Use hints progressively, one level at a time');
      input.depth = depth;
    }
    const value = await this.mcp.call(name, input, signal);
    if (session && (name === 'run_tests' || name === 'submit_solution')) {
      session.result =
        name === 'submit_solution' ? (value as Submission).test_run : (value as TestRun);
      session.resultStale = session.code !== code;
      if (name === 'submit_solution') {
        session.submitted ||= (value as Submission).completed;
        if ((value as Submission).followup_questions)
          this.record(session, {
            id: randomUUID(),
            role: 'assistant',
            text: (value as Submission).followup_questions!,
            timestamp: Date.now(),
          });
      }
      this.progress = await this.mcp.call<string>('get_progress', {});
      this.publish();
    }
    if (session && name === 'get_hint')
      session.hintDepth = Math.max(session.hintDepth, input.depth as number);
    return value;
  }

  private requestApproval(tool: string, signal: AbortSignal): Promise<boolean> {
    const id = randomUUID();
    return new Promise((resolve) => {
      const settle = (allow: boolean) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        this.approvals.delete(id);
        resolve(allow);
      };
      const cancel = () => settle(false);
      const timer = setTimeout(cancel, 60_000);
      this.approvals.set(id, settle);
      signal.addEventListener('abort', cancel, { once: true });
      this.emit({
        type: 'approval',
        approval: {
          id,
          tool,
          description:
            'The coach wants to submit the draft you shared in this turn. This runs its tests and marks the attempt completed if they pass.',
        },
      });
    });
  }

  approve(id: string, allow: boolean): void {
    const pending = this.approvals.get(id);
    if (!pending) throw new Error('Approval has expired');
    pending(allow);
  }

  async chat(text: string): Promise<void> {
    this.idle();
    if (!text.trim() || text.length > 8000)
      throw new Error('Message must contain 1-8000 characters');
    const settings = this.settings();
    if (settings.provider === 'disabled')
      throw new Error(
        'Enable a local Ollama model or your own Claude API key in Settings. Curated hints work without either.',
      );
    if (settings.provider === 'anthropic' && !this.apiKey)
      throw new Error('Add your Claude API key in Settings');
    if (this.connection !== 'connected')
      throw new Error('Reconnect to the MCP before starting the coach');
    const session = this.active();
    const code = session?.code;
    const history = [...(session?.chat ?? this.store.workspace(this.scope).chat)];
    this.record(session, {
      id: randomUUID(),
      role: 'user',
      text: text.trim(),
      timestamp: Date.now(),
    });
    this.busy = true;
    this.error = null;
    this.agent = new AbortController();
    this.publish();
    const model =
      this.modelFactory?.(settings, this.apiKey) ??
      (settings.provider === 'anthropic'
        ? new AnthropicModel(this.apiKey, settings.model)
        : new OllamaModel(settings.ollamaUrl, settings.model));
    const context = session
      ? `Problem: ${session.problem.title}\nAttempt ID: ${session.attemptId}\nDescription:\n${session.description}\nSaved editor draft:\n${code}\nLast tests: ${session.result ? `${session.result.tests_passed}/${session.result.tests_total} passed${session.resultStale ? ' (older draft)' : ''}` : 'Not run'}`
      : 'No selected problem. You may browse the catalog and suggest a problem; the user opens it from the sidebar.';
    try {
      await this.store.persist();
      await runAgent({
        model,
        tools: this.mcp.tools.filter(
          (tool) => tool.name !== 'start_problem' && tool.name !== 'ping',
        ),
        message: text.trim(),
        history,
        context,
        signal: this.agent.signal,
        emit: (item) => this.record(session, item),
        execute: async (name, args, signal) => {
          if (name === 'start_problem') throw new Error('Open problems from the sidebar');
          if (name === 'submit_solution' && !(await this.requestApproval(name, signal)))
            throw new Error('User declined submission');
          signal.throwIfAborted();
          return this.execute(name, args, session, code, signal);
        },
      });
    } catch (error) {
      const message = this.agent.signal.aborted ? 'Coach stopped.' : this.sanitize(error);
      this.record(session, {
        id: randomUUID(),
        role: 'system',
        text: message,
        timestamp: Date.now(),
      });
      if (!this.agent.signal.aborted) this.error = message;
    } finally {
      this.agent = null;
      this.busy = false;
      await this.store.persist();
      this.publish();
      this.emit({ type: 'agent-done', ...(this.error ? { error: this.error } : {}) });
    }
  }

  cancelChat(): void {
    this.agent?.abort();
  }
  async clearChat(): Promise<void> {
    this.idle();
    const session = this.active();
    if (session) session.chat = [];
    else this.store.workspace(this.scope).chat = [];
    await this.store.persist();
    this.publish();
  }
  async close(): Promise<void> {
    this.cancelChat();
    for (const approve of this.approvals.values()) approve(false);
    if (this.store.isLoaded) await this.store.persist();
    await this.mcp.close();
  }
}
