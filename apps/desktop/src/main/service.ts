import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LocalStore } from './storage';
import { McpConnection } from './mcp';
import { ManagedSandbox } from './sandbox';
import { MANAGED_PISTON_URL, type SandboxStatus } from '../shared/sandbox';
import type {
  PracticeKind,
  PracticeQueueItem,
  PracticeQueueState,
  PracticeReflection,
  ReflectionDraft,
  ReflectionInput,
} from '../shared/practice';
import { runAgent, DESIGN_COACH_PROMPT } from './agent';
import { DesignStore, designDigest } from './design-storage';
import {
  emptyDesignDraft,
  type DesignCheckpoint,
  type DesignDraft,
  type DesignReview,
  type DesignSession,
  type DesignSummary,
} from '../shared/design';
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
    managedSandbox: z.boolean().default(false),
    connection: z.enum(['local', 'remote']),
    mcpUrl: z.string().max(1000),
    apiKey: z.string().max(500).optional(),
    mcpKey: z.string().max(8192).optional(),
    clearApiKey: z.boolean().optional(),
    clearMcpKey: z.boolean().optional(),
  })
  .strict();

type Scaffold = {
  attempt_id: string;
  mode: string;
  files_to_create: { relative_path: string; contents: string; sha256: string }[];
};

export const reflectionDraftSchema = z
  .object({
    reflection_id: z.string().uuid(),
    expected_version: z.number().int().min(0),
    answer: z.string().max(8000),
    takeaway: z.string().max(2000),
    next_action: z.string().max(2000),
    self_rating: z.enum(['needs_work', 'with_effort', 'recalled']),
  })
  .strict();

export class WorkbenchService {
  private apiKey = '';
  private mcpKey = '';
  private scope = '';
  private connection: Snapshot['connection'] = 'disconnected';
  private error: string | null = null;
  private busy = false;
  private problems: Problem[] = [];
  private designProblems: DesignSummary[] = [];
  private installedPacks: Snapshot['installedPacks'] = [];
  private readonly designs: DesignStore;
  private progress = '';
  private agent: AbortController | null = null;
  private agentId: string | null = null;
  private approvals = new Map<string, (allow: boolean) => void>();
  private practiceOwned = new Set<string>();
  /** Pending draft operations, including writes that wait for a history clear. */
  private draftWrites = new Set<Promise<unknown>>();
  /** Resolves after a history clear, including failure. New drafts wait for this promise. */
  private historyWrite: Promise<void> | null = null;

  constructor(
    readonly store: LocalStore,
    private readonly mcp: McpConnection,
    private readonly vault: Vault,
    private readonly emit: (event: AppEvent) => void,
    private readonly modelFactory?: (settings: Settings, key: string) => Model,
    private readonly sandbox?: ManagedSandbox,
  ) {
    this.designs = new DesignStore(store.root);
  }

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
      mode: workspace.mode,
      installedPacks: this.installedPacks,
      designProblems: this.designProblems,
      designSessions: workspace.designSessions,
      activeDesignSessionId: workspace.activeDesignSessionId,
      settings: this.settings(),
      problems: this.problems,
      sessions: workspace.sessions,
      activeProblemId: workspace.activeProblemId,
      welcomeChat: workspace.chat,
      progress: this.progress,
      connection: this.connection,
      error: this.error,
      busy: this.busy,
      chatId: this.agentId,
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
    await this.practiceAction(() => this.connect());
  }

  private async connect(): Promise<void> {
    this.practiceOwned.clear();
    this.connection = 'connecting';
    this.error = null;
    this.publish();
    try {
      await this.mcp.connect(this.store.state.settings, this.mcpKey);
      this.scope = this.mcp.accountIdentity
        ? this.store.bindAccount(this.mcpKey, this.mcp.accountIdentity)
        : this.store.scope(this.mcpKey);
      if (this.mcp.accountIdentity) await this.store.persist();
      this.problems = await this.mcp.call<Problem[]>('list_problems', {});
      this.progress = await this.mcp.call<string>('get_progress', {});
      this.designProblems = this.mcp.tools.some((tool) => tool.name === 'list_design_problems')
        ? await this.mcp.call<DesignSummary[]>('list_design_problems', {})
        : [];
      this.installedPacks = this.mcp.tools.some((tool) => tool.name === 'list_content_packs')
        ? await this.mcp.call('list_content_packs', {})
        : [];
      this.connection = 'connected';
    } catch (error) {
      this.connection = 'disconnected';
      this.problems = [];
      this.designProblems = [];
      this.error = this.sanitize(error);
    }
  }

  async updateSettings(input: SettingsUpdate): Promise<void> {
    this.idle();
    const { apiKey, mcpKey, clearApiKey, clearMcpKey, ...settings } = settingsSchema.parse(input);
    if (settings.managedSandbox && !this.store.state.settings.managedSandbox)
      throw new Error('Use Enable local execution to opt into the privileged sandbox first.');
    if (settings.managedSandbox && settings.pistonUrl !== MANAGED_PISTON_URL)
      throw new Error('The app-managed sandbox uses http://127.0.0.1:2000.');
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
    await this.practiceAction(async () => {
      if (this.store.state.settings.managedSandbox && !settings.managedSandbox)
        await this.sandbox?.stop();
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
      await this.connect();
    });
  }

  sandboxInfo(): SandboxStatus {
    return (
      this.sandbox?.status() ?? {
        phase: 'unchecked',
        managed: false,
        message: 'Sandbox manager is not available in this environment.',
      }
    );
  }
  async inspectSandbox(): Promise<SandboxStatus> {
    this.idle();
    if (!this.sandbox) throw new Error('Sandbox manager is unavailable');
    this.busy = true;
    this.publish();
    try {
      return await this.sandbox.inspect();
    } finally {
      this.busy = false;
      this.publish();
    }
  }
  async enableSandbox(): Promise<SandboxStatus> {
    this.idle();
    if (!this.sandbox) throw new Error('Sandbox manager is unavailable');
    if (this.store.state.settings.connection !== 'local' && !this.mcp.usesLocalExecution)
      throw new Error('This remote server does not support local code execution');
    this.busy = true;
    this.publish();
    let status: SandboxStatus;
    try {
      status = await this.sandbox.enable();
      this.store.state.settings.managedSandbox = true;
      this.store.state.settings.pistonUrl = MANAGED_PISTON_URL;
      await this.store.persist();
    } finally {
      this.busy = false;
      this.publish();
    }
    await this.reconnect();
    return status;
  }
  async stopSandbox(): Promise<SandboxStatus> {
    this.idle();
    if (!this.sandbox) throw new Error('Sandbox manager is unavailable');
    this.busy = true;
    this.publish();
    try {
      return await this.sandbox.stop();
    } finally {
      this.busy = false;
      this.publish();
    }
  }

  private async practiceAction<T>(action: () => Promise<T>): Promise<T> {
    this.idle();
    this.busy = true;
    this.publish();
    try {
      return await action();
    } finally {
      this.busy = false;
      this.publish();
    }
  }

  /** Keep draft writes outside the shared action lock, except during a history clear. */
  private draftWrite<T>(operation: () => Promise<T>): Promise<T> {
    const scope = this.scope;
    const invoke = () => {
      if (this.scope !== scope) throw new Error('Workspace changed. Retry the draft save.');
      return operation();
    };
    const pending = this.historyWrite ? this.historyWrite.then(invoke) : invoke();
    this.draftWrites.add(pending);
    return pending.finally(() => this.draftWrites.delete(pending));
  }
  async practiceQueue(): Promise<PracticeQueueState> {
    const names = [
      'get_practice_queue',
      'get_practice_review',
      'list_practice_sources',
      'add_practice_review',
      'record_practice_reflection',
      'list_practice_reflections',
      'reschedule_practice_review',
      'pause_practice_review',
    ];
    if (!names.every((name) => this.mcp.tools.some((tool) => tool.name === name)))
      return { supported: false, items: [], sources: [] };
    return this.practiceAction(async () => ({
      supported: true,
      items: await this.mcp.call<PracticeQueueItem[]>('get_practice_queue', { limit: 2000 }),
      sources: await this.mcp.call('list_practice_sources', { limit: 500 }),
    }));
  }
  async addPracticeReview(
    kind: PracticeKind,
    sourceId: string,
    daysAhead: number,
  ): Promise<PracticeQueueItem> {
    return this.practiceAction(() =>
      this.mcp.call('add_practice_review', {
        kind,
        source_id: sourceId,
        days_ahead: daysAhead,
      }),
    );
  }
  async reschedulePracticeReview(
    itemId: string,
    daysAhead: number,
    expectedVersion: number,
  ): Promise<PracticeQueueItem> {
    return this.practiceAction(() =>
      this.mcp.call('reschedule_practice_review', {
        item_id: itemId,
        days_ahead: daysAhead,
        expected_version: expectedVersion,
      }),
    );
  }
  async pausePracticeReview(
    itemId: string,
    paused: boolean,
    expectedVersion: number,
  ): Promise<PracticeQueueItem> {
    return this.practiceAction(() =>
      this.mcp.call('pause_practice_review', {
        item_id: itemId,
        paused,
        expected_version: expectedVersion,
      }),
    );
  }
  async practiceReflections(itemId: string): Promise<PracticeReflection[]> {
    return this.practiceAction(() =>
      this.mcp.call('list_practice_reflections', { item_id: itemId, limit: 500 }),
    );
  }
  async loadReflectionDraft(itemId: string): Promise<ReflectionDraft> {
    const scope = this.scope;
    const item = await this.mcp.call<PracticeQueueItem>('get_practice_review', { item_id: itemId });
    if (this.scope !== scope) throw new Error('Workspace changed; reopen the practice queue.');
    this.practiceOwned.add(item.id);
    const stored = this.store.workspace(this.scope).reflectionDrafts[itemId];
    return stored
      ? reflectionDraftSchema.parse(stored)
      : {
          reflection_id: randomUUID(),
          expected_version: item.version,
          answer: '',
          takeaway: '',
          next_action: '',
          self_rating: 'needs_work',
        };
  }
  async saveReflectionDraft(itemId: string, input: ReflectionDraft): Promise<void> {
    await this.draftWrite(async () => {
      const scope = this.scope;
      const draft = reflectionDraftSchema.parse(input);
      // Ownership is immutable through practice APIs. Once checked on load, local
      // autosave need not consume a remote request on every short typing pause.
      if (!this.practiceOwned.has(itemId)) {
        await this.mcp.call('get_practice_review', { item_id: itemId });
        this.practiceOwned.add(itemId);
      }
      if (this.scope !== scope) throw new Error('Workspace changed; reopen the practice queue.');
      this.store.workspace(scope).reflectionDrafts[itemId] = draft;
      await this.store.persist();
    });
  }
  async recordPracticeReflection(input: ReflectionInput): Promise<PracticeReflection> {
    const { item_id, ...draft } = input;
    const validated = reflectionDraftSchema.parse(draft);
    if (!validated.answer.trim()) throw new Error('Record your own recall answer first.');
    return this.practiceAction(async () => {
      const result = await this.mcp.call<PracticeReflection>('record_practice_reflection', {
        item_id,
        ...validated,
      });
      // Preserve an in-flight/newer local draft; clear only the committed evidence.
      const drafts = this.store.workspace(this.scope).reflectionDrafts;
      if (
        drafts[item_id] &&
        JSON.stringify(reflectionDraftSchema.parse(drafts[item_id])) === JSON.stringify(validated)
      )
        delete drafts[item_id];
      await this.store.persist();
      return result;
    });
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
    await this.practiceAction(async () => {
      const workspace = this.store.workspace(this.scope);
      if (!workspace.sessions.some((session) => session.problem.id === id))
        throw new Error('No saved attempt for this problem');
      workspace.activeProblemId = id;
      await this.store.persist();
    });
  }

  async saveCode(id: string, code: string): Promise<void> {
    await this.draftWrite(async () => {
      if (Buffer.byteLength(code, 'utf8') > 100_000) throw new Error('Code must be at most 100 KB');
      const session = this.store
        .workspace(this.scope)
        .sessions.find((session) => session.problem.id === id);
      if (!session) throw new Error('No active workspace for this problem');
      if (session.code !== code) {
        session.code = code;
        session.updatedAt = Date.now();
        session.resultStale = !!session.result;
      }
      // Equal memory values do not prove that an earlier disk write succeeded.
      await this.store.saveCode(this.scope, session);
    });
  }

  async setMode(mode: 'coding' | 'design'): Promise<void> {
    await this.practiceAction(async () => {
      this.store.workspace(this.scope).mode = mode;
      await this.store.persist();
    });
  }

  async installContentPack(packageJson: string, licenseJson: string): Promise<void> {
    if (this.store.state.settings.connection !== 'local')
      throw new Error('Install packs in a local workspace');
    await this.designAction(async () => {
      await this.mcp.call('install_content_pack', {
        package_json: packageJson,
        license_json: licenseJson,
      });
      this.problems = await this.mcp.call('list_problems', {});
      this.designProblems = await this.mcp.call('list_design_problems', {});
      this.installedPacks = await this.mcp.call('list_content_packs', {});
    });
  }

  private designSession(id?: string): DesignSession {
    const workspace = this.store.workspace(this.scope);
    const session = workspace.designSessions.find(
      (item) => item.id === (id ?? workspace.activeDesignSessionId),
    );
    if (!session) throw new Error('Choose a system-design brief first');
    return session;
  }

  private async designAction<T>(action: () => Promise<T>): Promise<T> {
    this.idle();
    this.busy = true;
    this.error = null;
    this.publish();
    try {
      return await action();
    } catch (error) {
      this.error = this.sanitize(error);
      throw new Error(this.error);
    } finally {
      try {
        await this.store.persist();
      } finally {
        this.busy = false;
        this.publish();
      }
    }
  }

  async startDesign(problemId: string, newAttempt = false): Promise<void> {
    this.idle();
    const workspace = this.store.workspace(this.scope);
    const existing = [...workspace.designSessions]
      .reverse()
      .find((item) => item.problem_id === problemId && item.status === 'in_progress');
    if (existing && !newAttempt) return this.activateDesign(existing.id);
    if (!this.designProblems.some((item) => item.id === problemId))
      throw new Error('Brief is not in the connected catalog');
    await this.designAction(async () => {
      const record = await this.mcp.call<
        Pick<
          DesignSession,
          'id' | 'problem_id' | 'brief' | 'status' | 'started_at' | 'completed_at'
        >
      >('start_design_session', { problem_id: problemId });
      const session: DesignSession = {
        ...record,
        chat: [],
        hintDepth: 0,
        latestCheckpointId: null,
        review: null,
        draftDigest: '',
        updatedAt: Date.now(),
      };
      session.draftDigest = await this.designs.save(this.scope, session.id, emptyDesignDraft());
      workspace.designSessions.push(session);
      workspace.activeDesignSessionId = session.id;
      workspace.mode = 'design';
    });
  }

  async activateDesign(sessionId: string): Promise<void> {
    await this.practiceAction(async () => {
      this.designSession(sessionId);
      this.store.workspace(this.scope).activeDesignSessionId = sessionId;
      await this.store.persist();
    });
  }

  async loadDesignDraft(sessionId: string): Promise<DesignDraft> {
    this.designSession(sessionId);
    return this.designs.load(this.scope, sessionId);
  }

  async saveDesignDraft(sessionId: string, draft: DesignDraft): Promise<string> {
    return this.draftWrite(async () => {
      const session = this.designSession(sessionId);
      if (session.status === 'completed')
        throw new Error('This session is finished; start a new attempt to make changes');
      const digest = await this.designs.save(this.scope, sessionId, draft);
      session.draftDigest = digest;
      session.updatedAt = Date.now();
      await this.store.persist();
      this.publish();
      return digest;
    });
  }

  private async captureDesign(session: DesignSession, label: string): Promise<DesignCheckpoint> {
    if (session.status === 'completed') throw new Error('This session is finished');
    const id = randomUUID();
    const { draft, digest, diagram } = await this.designs.checkpoint(this.scope, session.id, id);
    const checkpoint = await this.mcp.call<DesignCheckpoint>('save_design_checkpoint', {
      session_id: session.id,
      checkpoint_id: id,
      scene_digest: digest,
      notes: draft.notes,
      diagram,
      label,
    });
    session.latestCheckpointId = checkpoint.id;
    return checkpoint;
  }

  async checkpointDesign(label = 'Checkpoint'): Promise<DesignCheckpoint> {
    return this.designAction(() => this.captureDesign(this.designSession(), label));
  }

  async designCheckpoints(): Promise<DesignCheckpoint[]> {
    return this.mcp.call('list_design_checkpoints', { session_id: this.designSession().id });
  }

  async restoreDesignCheckpoint(checkpointId: string): Promise<DesignDraft> {
    return this.designAction(async () => {
      const session = this.designSession();
      if (session.status === 'completed')
        throw new Error('Start a new attempt to edit a finished session');
      const checkpoint = await this.mcp.call<DesignCheckpoint>('get_design_snapshot', {
        session_id: session.id,
        checkpoint_id: checkpointId,
      });
      // Preserve the current draft before restoring older evidence.
      await this.captureDesign(session, 'Before restore');
      const draft = await this.designs.restore(
        this.scope,
        session.id,
        checkpointId,
        checkpoint.scene_digest,
      );
      session.draftDigest = designDigest(draft);
      session.updatedAt = Date.now();
      return draft;
    });
  }

  async reviewDesign(): Promise<void> {
    await this.designAction(async () => {
      const session = this.designSession();
      const checkpoint = await this.captureDesign(session, 'Review');
      session.review = await this.mcp.call('evaluate_design', {
        session_id: session.id,
        checkpoint_id: checkpoint.id,
      });
    });
  }

  private recordDesign(session: DesignSession, item: ChatItem): void {
    const index = session.chat.findIndex((entry) => entry.id === item.id);
    if (index >= 0) session.chat[index] = item;
    else session.chat.push(item);
    if (session.chat.length > 200) session.chat.splice(0, session.chat.length - 200);
    this.emit({ type: 'design-chat', item, sessionId: session.id });
  }

  private async executeDesign(
    name: string,
    args: Record<string, unknown>,
    session: DesignSession,
    checkpoint: DesignCheckpoint | null,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const input: Record<string, unknown> = { session_id: session.id };
    if (name === 'get_design_hint') {
      const depth = z
        .number()
        .int()
        .min(1)
        .max(3)
        .parse(args.depth ?? 1);
      if (depth > session.hintDepth + 1)
        throw new Error('Use hints progressively, one level at a time');
      input.depth = depth;
    } else if (name === 'get_design_snapshot' || name === 'evaluate_design') {
      if (!checkpoint) throw new Error('A captured checkpoint is required');
      input.checkpoint_id = checkpoint.id;
    } else if (name !== 'get_design_brief')
      throw new Error('The design coach only has read/review tools');
    const result = await this.mcp.call(name, input, signal);
    if (name === 'get_design_hint')
      session.hintDepth = Math.max(session.hintDepth, input.depth as number);
    if (name === 'evaluate_design') session.review = result as DesignReview;
    return result;
  }

  async designHint(): Promise<void> {
    await this.designAction(async () => {
      const session = this.designSession();
      const result = (await this.executeDesign(
        'get_design_hint',
        { depth: Math.min(3, session.hintDepth + 1) },
        session,
        null,
      )) as { hint: string };
      this.recordDesign(session, {
        id: randomUUID(),
        role: 'assistant',
        text: result.hint,
        timestamp: Date.now(),
      });
    });
  }

  async finishDesign(): Promise<void> {
    await this.designAction(async () => {
      const session = this.designSession();
      if (!session.review || session.review.scene_digest !== session.draftDigest)
        throw new Error('Review your current checkpoint before finishing');
      const record = await this.mcp.call<DesignSession>('finish_design_session', {
        session_id: session.id,
        checkpoint_id: session.review.checkpoint_id,
      });
      session.status = record.status;
      session.completed_at = record.completed_at;
    });
  }

  async designExport(format: 'excalidraw' | 'workspace'): Promise<string> {
    const session = this.designSession();
    const draft = await this.designs.load(this.scope, session.id);
    return JSON.stringify(
      format === 'excalidraw'
        ? { type: 'excalidraw', version: 2, source: 'Interview Workbench', ...draft.scene }
        : {
            type: 'interview-design',
            version: 1,
            brief: session.brief,
            draft,
            review: session.review,
          },
      null,
      2,
    );
  }

  async exportWorkspace(): Promise<string> {
    this.idle();
    await this.designs.flush();
    const workspace = structuredClone(this.store.workspace(this.scope));
    const practice = await this.mcp.call<{ design_checkpoints: DesignCheckpoint[] }>(
      'export_practice_data',
      {},
    );
    const designs = [];
    for (const session of workspace.designSessions) {
      const draft = await this.designs.load(this.scope, session.id);
      const history = practice.design_checkpoints.filter((item) => item.session_id === session.id);
      const checkpoints = [];
      for (const checkpoint of history)
        checkpoints.push({
          metadata: checkpoint,
          draft: await this.designs.readCheckpoint(
            this.scope,
            session.id,
            checkpoint.id,
            checkpoint.scene_digest,
          ),
        });
      designs.push({ sessionId: session.id, draft, checkpoints });
    }
    return JSON.stringify(
      {
        type: 'interview-workbench-backup',
        version: 1,
        createdAt: new Date().toISOString(),
        workspace,
        practice,
        designs,
        installedPacks: this.installedPacks,
      },
      null,
      2,
    );
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
      try {
        await this.store.persist();
      } finally {
        this.busy = false;
        this.publish();
      }
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
      try {
        await this.store.persist();
      } finally {
        this.busy = false;
        this.publish();
      }
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
    const invoke = () => this.mcp.call(name, input, signal);
    const value =
      ['run_tests', 'submit_solution'].includes(name) &&
      (this.store.state.settings.connection === 'local' || this.mcp.usesLocalExecution) &&
      this.store.state.settings.managedSandbox
        ? await (this.sandbox
            ? this.sandbox.withExecution(invoke)
            : Promise.reject(new Error('The app-managed sandbox is unavailable')))
        : await invoke();
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
    if (signal.aborted) return Promise.resolve(false);
    const id = randomUUID();
    return new Promise((resolve) => {
      const settle = (allow: boolean) => {
        if (!this.approvals.delete(id)) return;
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        this.emit({ type: 'approval-settled', id });
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

  /** Resolve this pending approval. Reject an expired or previously resolved ID without a submission. */
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
    const design = this.store.workspace(this.scope).mode === 'design' ? this.designSession() : null;
    const checkpoint = design
      ? await this.designAction(() => this.captureDesign(design, 'Coach context'))
      : null;
    const session = this.active();
    const code = session?.code;
    const history = [...(design?.chat ?? session?.chat ?? this.store.workspace(this.scope).chat)];
    const record = (item: ChatItem) =>
      design ? this.recordDesign(design, item) : this.record(session, item);
    record({
      id: randomUUID(),
      role: 'user',
      text: text.trim(),
      timestamp: Date.now(),
    });
    this.busy = true;
    this.error = null;
    this.agent = new AbortController();
    this.agentId = randomUUID();
    this.publish();
    const context = design
      ? `Pinned system-design brief:\n${JSON.stringify(design.brief)}\nImmutable checkpoint evidence:\n${JSON.stringify(checkpoint)}\nThis is not a correctness grade. Only refer to this checkpoint, even if the live canvas changes.`
      : session
        ? `Problem: ${session.problem.title}\nAttempt ID: ${session.attemptId}\nDescription:\n${session.description}\nSaved editor draft:\n${code}\nLast tests: ${session.result ? `${session.result.tests_passed}/${session.result.tests_total} passed${session.resultStale ? ' (older draft)' : ''}` : 'Not run'}`
        : 'No selected problem. You may browse the catalog and suggest a problem; the user opens it from the sidebar.';
    try {
      const model =
        this.modelFactory?.(settings, this.apiKey) ??
        (settings.provider === 'anthropic'
          ? new AnthropicModel(this.apiKey, settings.model)
          : new OllamaModel(settings.ollamaUrl, settings.model));
      await this.store.persist();
      await runAgent({
        model,
        tools: this.mcp.tools.filter((tool) =>
          design
            ? [
                'get_design_brief',
                'get_design_snapshot',
                'get_design_hint',
                'evaluate_design',
              ].includes(tool.name)
            : [
                'list_problems',
                'get_problem_description',
                'get_hint',
                'run_tests',
                'submit_solution',
                'get_progress',
              ].includes(tool.name),
        ),
        ...(design ? { prompt: DESIGN_COACH_PROMPT } : {}),
        message: text.trim(),
        history,
        context,
        signal: this.agent.signal,
        emit: record,
        execute: async (name, args, signal) => {
          if (name === 'start_problem') throw new Error('Open problems from the sidebar');
          if (name === 'submit_solution' && !(await this.requestApproval(name, signal)))
            throw new Error('Submission approval is necessary');
          signal.throwIfAborted();
          if (design) return this.executeDesign(name, args, design, checkpoint, signal);
          return this.execute(name, args, session, code, signal);
        },
      });
    } catch (error) {
      const message = this.agent.signal.aborted ? 'Coach stopped.' : this.sanitize(error);
      record({
        id: randomUUID(),
        role: 'system',
        text: message,
        timestamp: Date.now(),
      });
      if (!this.agent.signal.aborted) this.error = message;
    } finally {
      this.agent = null;
      this.agentId = null;
      this.publish();
      try {
        await this.store.persist();
      } finally {
        this.busy = false;
        this.publish();
        this.emit({ type: 'agent-done', ...(this.error ? { error: this.error } : {}) });
      }
    }
  }

  /**
   * Abort the chat with this ID. An old ID has no effect on a different chat.
   * Without an ID, abort the active chat for window close. Do not change saved drafts.
   */
  cancelChat(chatId?: string): void {
    if (chatId === undefined || chatId === this.agentId) this.agent?.abort();
  }
  /**
   * Clear the selected conversation only after its state write completes.
   * Reject on a busy service, a missing design session, or a write failure.
   * Queued drafts continue after either result.
   */
  async clearChat(): Promise<void> {
    await this.practiceAction(async () => {
      const earlierWrites = [...this.draftWrites];
      let release!: () => void;
      this.historyWrite = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        // Include earlier edits. New draft writes wait until the clear succeeds or fails.
        const results = await Promise.allSettled(earlierWrites);
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        const next = structuredClone(this.store.state);
        const workspace = next.workspaces[this.scope];
        let target: { chat: ChatItem[] };
        let staged: { chat: ChatItem[] };
        if (workspace.mode === 'design') {
          const session = this.designSession();
          target = session;
          staged = workspace.designSessions.find((item) => item.id === session.id)!;
        } else {
          const session = this.active();
          target = session ?? this.store.workspace(this.scope);
          staged = session
            ? workspace.sessions.find((item) => item.problem.id === session.problem.id)!
            : workspace;
        }
        staged.chat = [];
        await this.store.persist(next);
        target.chat = [];
      } finally {
        this.historyWrite = null;
        release();
      }
    });
  }
  /**
   * Save drafts and workspace state before the window closes. Reject on a write failure.
   * The caller must prevent new work and wait for active calls. Connections stay open.
   */
  async prepareClose(): Promise<void> {
    await this.designs.flush();
    if (this.store.isLoaded) await this.store.persist();
  }
  /**
   * Cancel chat and release connections. Save pending data by default.
   * Set save to false only after prepareClose succeeds and further writes are disabled.
   * Reject on a write or cleanup failure.
   */
  async close({ save = true }: { save?: boolean } = {}): Promise<void> {
    this.cancelChat();
    for (const approve of this.approvals.values()) approve(false);
    try {
      if (save) await this.prepareClose();
    } finally {
      try {
        await this.mcp.close();
      } finally {
        await this.sandbox?.close();
      }
    }
  }
}
