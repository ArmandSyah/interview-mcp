import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import type { ChatItem, PracticeSession, SettingsUpdate } from '../shared/types';

export type StoredSettings = Omit<
  SettingsUpdate,
  'apiKey' | 'mcpKey' | 'clearApiKey' | 'clearMcpKey'
>;
type Workspace = { sessions: PracticeSession[]; activeProblemId: string | null; chat: ChatItem[] };
type StoredState = {
  version: 1;
  settings: StoredSettings;
  credentials: { apiKey?: string; mcpKey?: string };
  workspaces: Record<string, Workspace>;
};

export const defaultSettings: StoredSettings = {
  provider: 'disabled',
  model: 'qwen3:4b',
  ollamaUrl: 'http://127.0.0.1:11434',
  corpusPath: '',
  pistonUrl: 'http://127.0.0.1:2000',
  connection: 'local',
  mcpUrl: '',
};

export class LocalStore {
  state: StoredState = {
    version: 1,
    settings: { ...defaultSettings },
    credentials: {},
    workspaces: {},
  };
  private writes: Promise<void> = Promise.resolve();
  private loaded = false;
  constructor(readonly root: string) {}

  get isLoaded(): boolean {
    return this.loaded;
  }

  async load(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      const raw = JSON.parse(
        await readFile(join(this.root, 'workspace.json'), 'utf8'),
      ) as StoredState;
      if (raw.version !== 1 || !raw.workspaces || !raw.settings)
        throw new Error('Unsupported workspace data');
      this.state = {
        ...raw,
        settings: { ...defaultSettings, ...raw.settings },
        credentials: raw.credentials ?? {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error(
          'Cannot read saved workspace. Your existing files have not been overwritten.',
        );
    }
    this.loaded = true;
  }

  scope(mcpKey = ''): string {
    const identity =
      this.state.settings.connection === 'local'
        ? 'local'
        : `remote:${this.state.settings.mcpUrl}:${createHash('sha256').update(mcpKey).digest('hex')}`;
    return createHash('sha256').update(identity).digest('hex').slice(0, 24);
  }

  workspace(scope: string): Workspace {
    const workspace = (this.state.workspaces[scope] ??= {
      sessions: [],
      activeProblemId: null,
      chat: [],
    });
    workspace.chat ??= [];
    return workspace;
  }

  path(scope: string, id: string): string {
    if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(id) || !/^[a-f0-9]{24}$/.test(scope))
      throw new Error('Invalid workspace path');
    const root = resolve(this.root, 'practice');
    const path = resolve(root, scope, id, 'solution.py');
    if (relative(root, path).startsWith('..')) throw new Error('Invalid workspace path');
    return path;
  }

  async saveCode(scope: string, session: PracticeSession): Promise<void> {
    if (!this.loaded) throw new Error('Workspace could not be loaded; saving is disabled');
    const path = this.path(scope, session.problem.id);
    await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
    const code = session.code;
    const data = JSON.stringify(this.state, null, 2);
    return this.enqueue(async () => {
      await this.atomicWrite(path, code);
      await this.atomicWrite(join(this.root, 'workspace.json'), data);
    });
  }

  async persist(): Promise<void> {
    if (!this.loaded) throw new Error('Workspace could not be loaded; saving is disabled');
    const data = JSON.stringify(this.state, null, 2);
    return this.enqueue(() => this.atomicWrite(join(this.root, 'workspace.json'), data));
  }

  private enqueue(write: () => Promise<void>): Promise<void> {
    const pending = this.writes.catch(() => {}).then(write);
    this.writes = pending;
    return pending;
  }

  private async atomicWrite(path: string, data: string): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, data, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
  }
}
