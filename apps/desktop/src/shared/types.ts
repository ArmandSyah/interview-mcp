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
  settings: Settings;
  problems: Problem[];
  sessions: PracticeSession[];
  activeProblemId: string | null;
  welcomeChat: ChatItem[];
  progress: string;
  connection: 'connected' | 'disconnected' | 'connecting';
  error: string | null;
  busy: boolean;
  workspacePath: string;
};
export type Approval = { id: string; tool: string; description: string };
export type AppEvent =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'chat'; item: ChatItem; problemId: string }
  | { type: 'approval'; approval: Approval }
  | { type: 'agent-done'; error?: string }
  | { type: 'flush-before-close' };
export type DesktopAPI = {
  snapshot(): Promise<Snapshot>;
  reconnect(): Promise<void>;
  startProblem(id: string): Promise<void>;
  activateProblem(id: string): Promise<void>;
  saveCode(problemId: string, code: string): Promise<void>;
  runTests(submit: boolean): Promise<void>;
  hint(): Promise<void>;
  chat(text: string): Promise<void>;
  cancelChat(): Promise<void>;
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
