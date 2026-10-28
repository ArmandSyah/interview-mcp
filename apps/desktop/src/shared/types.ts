export type Problem = {
  id: string;
  title: string;
  difficulty: 'easy' | 'medium' | 'hard';
  tags: string[];
  pattern_tags: string[];
};
export type TestCase = {
  index: number;
  passed: boolean;
  input: unknown[];
  expected: unknown;
  actual: unknown;
  user_stdout: string;
  user_stderr: string;
  error: string | null;
  wall_time_ms: number;
};
export type TestRun = {
  execution_source?: 'local_report';
  verification?: 'not_server_verified';
  attempt_id: string;
  problem_id: string;
  tests_total: number;
  tests_passed: number;
  tests: TestCase[];
  all_passed: boolean;
};
export type Submission = {
  completed: boolean;
  test_run: TestRun;
  followup_questions: string | null;
  message: string;
};
export type ChatItem = {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  tool?: string;
  status?: 'running' | 'done' | 'error';
  timestamp: number;
};
export type PracticeSession = {
  problem: Problem;
  attemptId: string;
  code: string;
  description: string;
  chat: ChatItem[];
  result: TestRun | null;
  resultStale: boolean;
  submitted: boolean;
  hintDepth: number;
  updatedAt: number;
};
export type Settings = {
  provider: 'disabled' | 'ollama' | 'anthropic';
  model: string;
  ollamaUrl: string;
  corpusPath: string;
  pistonUrl: string;
  managedSandbox: boolean;
  connection: 'local' | 'remote';
  mcpUrl: string;
  hasApiKey: boolean;
  hasMcpKey: boolean;
  secureStorage: boolean;
};
export type SettingsUpdate = Omit<Settings, 'hasApiKey' | 'hasMcpKey' | 'secureStorage'> & {
  apiKey?: string;
  mcpKey?: string;
  clearApiKey?: boolean;
  clearMcpKey?: boolean;
};
export type Snapshot = {
  /** Opaque local workspace ID. Token replacement for one account keeps this ID. */
  workspaceId: string;
  installedPacks: {
    pack_id: string;
    title: string;
    version: string;
    revision: string;
    updates_until: string;
    perpetual: true;
  }[];
  mode: 'coding' | 'design';
  designProblems: import('./design').DesignSummary[];
  designSessions: import('./design').DesignSession[];
  activeDesignSessionId: string | null;
  settings: Settings;
  problems: Problem[];
  sessions: PracticeSession[];
  activeProblemId: string | null;
  welcomeChat: ChatItem[];
  progress: string;
  connection: 'connected' | 'disconnected' | 'connecting';
  error: string | null;
  busy: boolean;
  chatId: string | null;
  workspacePath: string;
};
export type Approval = { id: string; tool: string; description: string };
export type AppEvent =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'chat'; item: ChatItem; problemId: string }
  | { type: 'design-chat'; item: ChatItem; sessionId: string }
  | { type: 'approval'; approval: Approval }
  | { type: 'approval-settled'; id: string }
  | { type: 'sandbox'; status: import('./sandbox').SandboxStatus }
  | { type: 'agent-done'; error?: string }
  | { type: 'flush-before-close' };
export type DesktopAPI = {
  practiceQueue(): Promise<import('./practice').PracticeQueueState>;
  addPracticeReview(
    kind: import('./practice').PracticeKind,
    sourceId: string,
    daysAhead: number,
  ): Promise<import('./practice').PracticeQueueItem>;
  reschedulePracticeReview(
    itemId: string,
    daysAhead: number,
    expectedVersion: number,
  ): Promise<import('./practice').PracticeQueueItem>;
  pausePracticeReview(
    itemId: string,
    paused: boolean,
    expectedVersion: number,
  ): Promise<import('./practice').PracticeQueueItem>;
  practiceReflections(itemId: string): Promise<import('./practice').PracticeReflection[]>;
  loadReflectionDraft(itemId: string): Promise<import('./practice').ReflectionDraft>;
  saveReflectionDraft(itemId: string, draft: import('./practice').ReflectionDraft): Promise<void>;
  recordPracticeReflection(
    input: import('./practice').ReflectionInput,
  ): Promise<import('./practice').PracticeReflection>;
  sandboxInfo(): Promise<import('./sandbox').SandboxStatus>;
  inspectSandbox(): Promise<import('./sandbox').SandboxStatus>;
  enableSandbox(): Promise<import('./sandbox').SandboxStatus | null>;
  stopSandbox(): Promise<import('./sandbox').SandboxStatus>;
  licenseNotices(): Promise<string>;
  updateInfo(): Promise<import('./updates').UpdateStatus>;
  checkUpdates(
    channel: import('./updates').ReleaseChannel,
  ): Promise<import('./updates').UpdateStatus>;
  downloadUpdate(): Promise<import('./updates').UpdateStatus>;
  openUpdateInstaller(): Promise<void>;
  exportWorkspace(): Promise<string | null>;
  installContentPack(): Promise<void>;
  distributionInfo(): Promise<{ contentSigningConfigured: boolean; checkoutConfigured: boolean }>;
  openCheckout(): Promise<void>;
  setMode(mode: 'coding' | 'design'): Promise<void>;
  startDesign(problemId: string, newAttempt?: boolean): Promise<void>;
  activateDesign(sessionId: string): Promise<void>;
  loadDesignDraft(sessionId: string): Promise<import('./design').DesignDraft>;
  saveDesignDraft(sessionId: string, draft: import('./design').DesignDraft): Promise<string>;
  checkpointDesign(label?: string): Promise<import('./design').DesignCheckpoint>;
  designCheckpoints(): Promise<import('./design').DesignCheckpoint[]>;
  restoreDesignCheckpoint(checkpointId: string): Promise<import('./design').DesignDraft>;
  reviewDesign(): Promise<void>;
  designHint(): Promise<void>;
  finishDesign(): Promise<void>;
  exportDesign(
    format: 'excalidraw' | 'workspace' | 'png',
    png?: Uint8Array,
  ): Promise<string | null>;
  snapshot(): Promise<Snapshot>;
  reconnect(): Promise<void>;
  startProblem(id: string): Promise<void>;
  activateProblem(id: string): Promise<void>;
  saveCode(problemId: string, code: string): Promise<void>;
  runTests(submit: boolean): Promise<void>;
  hint(): Promise<void>;
  chat(text: string): Promise<void>;
  grade(): Promise<void>;
  cancelChat(chatId?: string): Promise<void>;
  approve(id: string, allow: boolean): Promise<void>;
  updateSettings(settings: SettingsUpdate): Promise<void>;
  chooseCorpus(): Promise<string | null>;
  exportSolution(): Promise<string | null>;
  clearChat(): Promise<void>;
  closeReady(saved: boolean): Promise<void>;
  onEvent(callback: (event: AppEvent) => void): () => void;
};

declare global {
  interface Window {
    interview: DesktopAPI;
  }
}
