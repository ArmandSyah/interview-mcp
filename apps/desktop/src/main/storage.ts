import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import type { ChatItem, PracticeSession, SettingsUpdate } from '../shared/types';
import type { DesignSession } from '../shared/design';
import { MANAGED_PISTON_URL } from '../shared/sandbox';
import type { ReflectionDraft } from '../shared/practice';

export type StoredSettings = Omit<
  SettingsUpdate,
  'apiKey' | 'mcpKey' | 'clearApiKey' | 'clearMcpKey'
>;
type Workspace = {
  sessions: PracticeSession[];
  activeProblemId: string | null;
  chat: ChatItem[];
  mode: 'coding' | 'design';
  designSessions: DesignSession[];
  activeDesignSessionId: string | null;
  reflectionDrafts: Record<string, ReflectionDraft>;
};
type StoredState = {
  version: 2;
  settings: StoredSettings;
  credentials: { apiKey?: string; mcpKey?: string };
  workspaces: Record<string, Workspace>;
  accountScopes?: Record<string, string>;
  credentialAccounts?: Record<string, string>;
};

export const defaultSettings: StoredSettings = {
  provider: 'disabled',
  model: 'qwen3:4b',
  ollamaUrl: 'http://127.0.0.1:11434',
  corpusPath: '',
  pistonUrl: 'http://127.0.0.1:2000',
  managedSandbox: false,
  connection: 'local',
  mcpUrl: '',
};

export class LocalStore {
  state: StoredState = {
    version: 2,
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
      const contents = await readFile(join(this.root, 'workspace.json'), 'utf8');
      const raw = JSON.parse(contents) as Omit<StoredState, 'version'> & { version: number };
      if (![1, 2].includes(raw.version) || !raw.workspaces || !raw.settings)
        throw new Error('Unsupported workspace data');
      for (const mapping of [raw.accountScopes, raw.credentialAccounts]) {
        if (
          mapping !== undefined &&
          (!mapping ||
            typeof mapping !== 'object' ||
            Array.isArray(mapping) ||
            Object.entries(mapping).some(
              ([key, value]) =>
                !/^[a-f0-9]{24}$/.test(key) ||
                typeof value !== 'string' ||
                !/^[a-f0-9]{24}$/.test(value),
            ))
        )
          throw new Error('Invalid account workspace mapping');
      }
      if (
        raw.settings.managedSandbox !== undefined &&
        typeof raw.settings.managedSandbox !== 'boolean'
      )
        throw new Error('Invalid sandbox opt-in');
      if (raw.settings.managedSandbox === true && raw.settings.pistonUrl !== MANAGED_PISTON_URL)
        throw new Error('Invalid managed sandbox endpoint');
      for (const workspace of Object.values(raw.workspaces)) {
        workspace.chat ??= [];
        if (!Array.isArray(workspace.sessions) || !Array.isArray(workspace.chat))
          throw new Error('Unsupported workspace data');
        workspace.mode ??= 'coding';
        workspace.designSessions ??= [];
        workspace.activeDesignSessionId ??= null;
        workspace.reflectionDrafts ??= {};
        if (
          !['coding', 'design'].includes(workspace.mode) ||
          !Array.isArray(workspace.designSessions) ||
          typeof workspace.reflectionDrafts !== 'object' ||
          Array.isArray(workspace.reflectionDrafts)
        )
          throw new Error('Unsupported workspace data');
      }
      if (raw.version === 1) {
        await mkdir(join(this.root, 'backups'), { recursive: true, mode: 0o700 });
        await writeFile(
          join(this.root, 'backups', 'workspace-v1-' + randomUUID() + '.json'),
          contents,
          {
            encoding: 'utf8',
            mode: 0o600,
            flag: 'wx',
          },
        );
      }
      this.state = {
        ...raw,
        version: 2,
        settings: { ...defaultSettings, ...raw.settings },
        credentials: raw.credentials ?? {},
      };
      if (raw.version === 1) {
        this.loaded = true;
        await this.persist();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error(
          'Cannot read saved workspace. Your existing files have not been overwritten.',
        );
    }
    this.loaded = true;
  }

  scope(mcpKey = '', account?: { userId: string; issuer: string } | null): string {
    const identity =
      this.state.settings.connection === 'local'
        ? 'local'
        : account
          ? `account:${JSON.stringify([this.state.settings.mcpUrl, account.issuer, account.userId])}`
          : `remote:${this.state.settings.mcpUrl}:${createHash('sha256').update(mcpKey).digest('hex')}`;
    const scope = createHash('sha256').update(identity).digest('hex').slice(0, 24);
    if (this.state.settings.connection === 'local') return scope;
    if (account) return this.state.accountScopes?.[scope] ?? scope;
    const accountScope = this.state.credentialAccounts?.[scope];
    return accountScope ? (this.state.accountScopes?.[accountScope] ?? accountScope) : scope;
  }

  bindAccount(mcpKey: string, account: { userId: string; issuer: string }): string {
    const settings = this.state.settings;
    if (settings.connection !== 'remote') throw new Error('An account needs a remote connection');
    const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
    const legacy = digest(
      `remote:${settings.mcpUrl}:${createHash('sha256').update(mcpKey).digest('hex')}`,
    );
    const stable = digest(
      `account:${JSON.stringify([settings.mcpUrl, account.issuer, account.userId])}`,
    );
    const accounts = (this.state.accountScopes ??= {});
    const credentials = (this.state.credentialAccounts ??= {});
    // Keep earlier files in place. Never combine two account workspaces.
    accounts[stable] ??=
      credentials[legacy] === undefined &&
      this.state.workspaces[legacy] &&
      !Object.values(accounts).includes(legacy)
        ? legacy
        : stable;
    credentials[legacy] = stable;
    return accounts[stable];
  }

  workspace(scope: string): Workspace {
    const workspace = (this.state.workspaces[scope] ??= {
      sessions: [],
      activeProblemId: null,
      chat: [],
      mode: 'coding',
      designSessions: [],
      activeDesignSessionId: null,
      reflectionDrafts: {},
    });
    workspace.chat ??= [];
    workspace.mode ??= 'coding';
    workspace.designSessions ??= [];
    workspace.activeDesignSessionId ??= null;
    workspace.reflectionDrafts ??= {};
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

  /** Write a state snapshot without replacing memory. The default is the active state. */
  async persist(state: StoredState = this.state): Promise<void> {
    if (!this.loaded) throw new Error('Workspace could not be loaded; saving is disabled');
    const data = JSON.stringify(state, null, 2);
    return this.enqueue(() => this.atomicWrite(join(this.root, 'workspace.json'), data));
  }

  private enqueue(write: () => Promise<void>): Promise<void> {
    const pending = this.writes.catch(() => {}).then(write);
    this.writes = pending;
    return pending;
  }

  private async atomicWrite(path: string, data: string): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(data, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  }
}
