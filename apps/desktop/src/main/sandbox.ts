import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { MANAGED_PISTON_URL, type SandboxStatus } from '../shared/sandbox';

export const PISTON_IMAGE =
  'ghcr.io/engineer-man/piston@sha256:2f66b7456189c4d713aa986d98eccd0b6ee16d26c7ec5f21b30e942756fd127a';
const OWNER_LABEL = 'io.github.armandsyah.interview-workbench.owner';
const HEALTH_MARKER = 'interview-sandbox-ready';
type CommandOptions = { timeout: number; env: NodeJS.ProcessEnv; signal?: AbortSignal };
type Runner = (args: string[], options: CommandOptions) => Promise<string>;
const execute = promisify(execFile);
const runDocker: Runner = async (args, options) => {
  const result = await execute(process.platform === 'win32' ? 'docker.exe' : 'docker', args, {
    ...options,
    windowsHide: true,
    maxBuffer: 1_000_000,
  });
  return result.stdout;
};
type Container = {
  Id: string;
  Config: { Image: string; Labels?: Record<string, string>; Env?: string[] };
  HostConfig: {
    Privileged: boolean;
    Memory: number;
    NanoCpus: number;
    PortBindings?: Record<string, { HostIp: string; HostPort: string }[]>;
  };
  State: { Running: boolean };
};
type Options = {
  run?: Runner;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  idleMs?: number;
  emit?: (status: SandboxStatus) => void;
};

// Docker is never invoked on startup. Only explicit inspection/setup and an
// opted-in code execution touch it. No shell, sudo, context changes, or deletion.
export class ManagedSandbox {
  readonly owner: string;
  readonly project: string;
  private host = '';
  private readonly run: Runner;
  private readonly request: typeof fetch;
  private readonly env: NodeJS.ProcessEnv;
  private readonly dockerEnv: NodeJS.ProcessEnv = {};
  private readonly idleMs: number;
  private current: SandboxStatus = {
    phase: 'unchecked',
    managed: false,
    message: 'Docker is optional. Design, editing, and curated hints work without it.',
  };
  private operation: Promise<void> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private leases = 0;
  private ownsLifecycle = false;
  private closed = false;
  private abort = new AbortController();
  private generation = 0;

  constructor(
    root: string,
    private readonly composeFile: string,
    private readonly options: Options = {},
  ) {
    this.owner = createHash('sha256').update(resolve(root)).digest('hex').slice(0, 24);
    this.project = `interview-workbench-${this.owner}`;
    this.run = options.run ?? runDocker;
    this.request = options.fetch ?? fetch;
    this.env = options.env ?? process.env;
    this.idleMs = options.idleMs ?? 5 * 60_000;
    // Do not leak coach keys or honor Docker routing/TLS variables after discovery.
    for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'DOCKER_CONFIG'])
      if (this.env[name]) this.dockerEnv[name] = this.env[name];
    this.dockerEnv.INTERVIEW_SANDBOX_OWNER = this.owner;
  }

  status(): SandboxStatus {
    return { ...this.current };
  }
  private publish(phase: SandboxStatus['phase'], message: string, managed = false): void {
    this.current = { phase, message, managed };
    this.options.emit?.(this.status());
  }
  private command(
    args: string[],
    timeout = 15_000,
    discovering = false,
    cleanup = false,
  ): Promise<string> {
    if (!cleanup && this.abort.signal.aborted)
      return Promise.reject(new Error('Sandbox operation cancelled'));
    return this.run(discovering ? args : ['--host', this.host, ...args], {
      timeout,
      env: this.dockerEnv,
      signal: cleanup ? undefined : this.abort.signal,
    });
  }
  private fail(phase: SandboxStatus['phase'], message: string): never {
    this.publish(phase, message);
    throw new Error(message);
  }
  private async discover(): Promise<void> {
    const override = this.env.DOCKER_HOST;
    if (override && !this.localHost(override))
      this.fail(
        'unsupported',
        'Remote Docker endpoints are not allowed for managed local practice.',
      );
    try {
      await this.command(['--version'], 10_000, true);
    } catch {
      this.fail(
        'docker-missing',
        'Docker CLI not found. Install Docker with Compose, then check again.',
      );
    }
    try {
      const context =
        this.env.DOCKER_CONTEXT || (await this.command(['context', 'show'], 10_000, true)).trim();
      if (!/^[a-zA-Z0-9_.-]{1,120}$/.test(context))
        this.fail('unsupported', 'The selected Docker context is not supported.');
      const endpoint = JSON.parse(
        await this.command(
          ['context', 'inspect', context, '--format', '{{json .Endpoints.docker.Host}}'],
          10_000,
          true,
        ),
      ) as unknown;
      this.host =
        override && !this.env.DOCKER_CONTEXT
          ? override
          : typeof endpoint === 'string'
            ? endpoint
            : '';
    } catch (error) {
      if (this.current.phase === 'unsupported') throw error;
      this.fail(
        'docker-stopped',
        'Cannot inspect the Docker context. Start Docker and check again.',
      );
    }
    if (!this.localHost(this.host))
      this.fail(
        'unsupported',
        'Use a local Docker socket or Docker Desktop context, not TCP or SSH.',
      );
    let info: { OSType?: string; Architecture?: string; CgroupVersion?: string };
    try {
      info = JSON.parse(await this.command(['info', '--format', '{{json .}}']));
      await this.command(['compose', 'version', '--short']);
    } catch {
      this.fail(
        'docker-stopped',
        'Docker is unavailable or Compose v2 is missing. Start Docker and check again.',
      );
    }
    if (info.OSType !== 'linux' || !['x86_64', 'amd64'].includes(info.Architecture ?? ''))
      this.fail(
        'unsupported',
        'The pinned sandbox requires Linux AMD64 containers. Design practice still works on this machine.',
      );
    if (info.CgroupVersion !== '2')
      this.fail(
        'unsupported',
        'Piston requires cgroup v2. Update your local Docker environment before enabling execution.',
      );
  }
  private localHost(host: string): boolean {
    return (
      /^unix:\/\/\/[^\r\n\0]+$/.test(host) || /^npipe:\/\/\/\/\.\/pipe\/[a-zA-Z0-9_.-]+$/.test(host)
    );
  }
  private assertOwned(container: Container): void {
    const labels = container.Config?.Labels ?? {};
    const bindings = container.HostConfig?.PortBindings?.['2000/tcp'];
    if (
      !/^[a-f0-9]{64}$/.test(container.Id) ||
      labels[OWNER_LABEL] !== this.owner ||
      labels['com.docker.compose.project'] !== this.project ||
      labels['com.docker.compose.service'] !== 'piston' ||
      container.Config.Image !== PISTON_IMAGE ||
      !container.Config.Env?.includes('PISTON_DISABLE_NETWORKING=true') ||
      container.HostConfig.Privileged !== true ||
      !Number.isFinite(container.HostConfig.Memory) ||
      container.HostConfig.Memory <= 0 ||
      container.HostConfig.Memory > 2 * 1024 ** 3 ||
      !Number.isFinite(container.HostConfig.NanoCpus) ||
      container.HostConfig.NanoCpus <= 0 ||
      container.HostConfig.NanoCpus > 1_500_000_000 ||
      bindings?.length !== 1 ||
      bindings[0].HostIp !== '127.0.0.1' ||
      bindings[0].HostPort !== '2000'
    )
      this.fail(
        'error',
        'Container ownership or sandbox configuration does not match. No containers were changed.',
      );
  }
  private async ownedContainers(cleanup = false): Promise<Container[]> {
    const ids = (
      await this.command(
        [
          'ps',
          '--all',
          '--no-trunc',
          '--filter',
          `label=com.docker.compose.project=${this.project}`,
          '--format',
          '{{.ID}}',
        ],
        15_000,
        false,
        cleanup,
      )
    )
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (ids.length > 1 || ids.some((id) => !/^[a-f0-9]{64}$/.test(id)))
      this.fail(
        'error',
        'Unexpected containers in the app sandbox project. No containers were changed.',
      );
    if (!ids.length) return [];
    const containers = JSON.parse(
      await this.command(['inspect', ...ids], 15_000, false, cleanup),
    ) as Container[];
    if (!Array.isArray(containers) || containers.length !== ids.length)
      this.fail('error', 'Docker returned invalid container metadata. No containers were changed.');
    for (const container of containers) this.assertOwned(container);
    return containers;
  }
  private async json(path: string, init: RequestInit = {}, timeout = 5000): Promise<unknown> {
    const response = await this.request(`${MANAGED_PISTON_URL}/api/v2/${path}`, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(timeout)]),
    });
    if (!response.ok || !response.body) throw new Error('Sandbox API request failed');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 512_000) throw new Error('Sandbox API response is too large');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  private async runtimes(): Promise<{ python: boolean } | null> {
    try {
      const value = await this.json('runtimes');
      if (!Array.isArray(value)) return null;
      return {
        python: value.some(
          (runtime) => runtime?.language === 'python' && runtime?.version === '3.12.0',
        ),
      };
    } catch {
      if (this.abort.signal.aborted) throw new Error('Sandbox operation cancelled');
      return null;
    }
  }
  private async executionCheck(): Promise<void> {
    const result = (await this.json('execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        language: 'python',
        version: '3.12.0',
        files: [{ name: 'health.py', content: `print('${HEALTH_MARKER}')` }],
        run_timeout: 3000,
        run_memory_limit: 64 * 1024 ** 2,
      }),
    })) as { run?: { code?: number; stdout?: string; signal?: string | null } };
    if (result.run?.code !== 0 || result.run.stdout?.trim() !== HEALTH_MARKER || result.run.signal)
      throw new Error('Python is installed but the sandbox execution check failed.');
  }
  private async prepare(allowStart: boolean): Promise<void> {
    this.publish('checking', 'Checking the local Docker context and sandbox…');
    await this.discover();
    let containers = await this.ownedContainers();
    let runtime = await this.runtimes();
    let managed = containers.some((container) => container.State.Running);
    this.ownsLifecycle = managed;
    if (!runtime && allowStart) {
      this.ownsLifecycle = true;
      this.publish(
        'starting',
        'Starting the pinned local sandbox. The first image download may take a few minutes.',
        true,
      );
      await this.command(
        [
          'compose',
          '--project-name',
          this.project,
          '--file',
          this.composeFile,
          'up',
          '--detach',
          '--wait',
          '--wait-timeout',
          '180',
          '--pull',
          'missing',
          'piston',
        ],
        300_000,
      );
      containers = await this.ownedContainers();
      if (!containers.some((container) => container.State.Running))
        throw new Error('The app-owned sandbox did not start.');
      managed = true;
      runtime = await this.runtimes();
    }
    if (!runtime) {
      this.publish(
        'stopped',
        'No sandbox is listening. Choose Enable local execution to set it up.',
      );
      return;
    }
    if (!runtime.python && managed && allowStart) {
      this.publish(
        'installing',
        'Installing Python 3.12 in the app-owned sandbox. No model or host Python is installed.',
        true,
      );
      await this.json(
        'packages',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ language: 'python', version: '3.12.0' }),
        },
        300_000,
      );
      runtime = await this.runtimes();
    }
    if (!runtime?.python) {
      this.publish(
        'unsupported',
        managed
          ? 'Python 3.12 is missing. Enable local execution to install it in the app-owned sandbox.'
          : 'An existing sandbox is listening, but Python 3.12 is missing. Install it yourself; the app will not change someone else’s sandbox.',
        managed,
      );
      return;
    }
    await this.executionCheck();
    this.publish(
      'ready',
      managed
        ? 'Local execution is ready. The app-owned container stops after five idle minutes and on exit.'
        : 'Using your existing sandbox. This app will not install packages in it or stop it.',
      managed,
    );
  }
  private exclusive(operation: () => Promise<void>, generation = this.generation): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Sandbox manager is closing'));
    if (generation !== this.generation)
      return Promise.reject(new Error('Sandbox operation cancelled'));
    if (this.operation)
      return this.operation.catch(() => {}).then(() => this.exclusive(operation, generation));
    const pending = operation()
      .catch((error) => {
        if (
          !['docker-missing', 'docker-stopped', 'unsupported', 'error'].includes(this.current.phase)
        )
          this.publish(
            'error',
            'Sandbox setup failed. Check Docker and port 2000; existing practice files and runtime data were kept.',
          );
        // Never expose raw Docker output: it can contain registry credentials/paths.
        throw new Error(this.current.message);
      })
      .finally(() => {
        this.operation = null;
        if (this.abort.signal.aborted && !this.closed) this.abort = new AbortController();
      });
    this.operation = pending;
    return pending;
  }
  async inspect(): Promise<SandboxStatus> {
    this.cancelIdle();
    try {
      await this.exclusive(() => this.prepare(false));
      return this.status();
    } finally {
      this.scheduleIdle();
    }
  }
  async enable(): Promise<SandboxStatus> {
    this.cancelIdle();
    try {
      await this.exclusive(() => this.prepare(true));
      if (this.current.phase !== 'ready') throw new Error(this.current.message);
      return this.status();
    } finally {
      this.scheduleIdle();
    }
  }
  async withExecution<T>(operation: () => Promise<T>): Promise<T> {
    this.cancelIdle();
    this.leases++;
    try {
      await this.enable();
      if (this.closed) throw new Error('Sandbox manager is closing');
      return await operation();
    } finally {
      this.leases--;
      this.scheduleIdle();
    }
  }
  private cancelIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
  private scheduleIdle(): void {
    if (this.closed || this.leases || !this.ownsLifecycle) return;
    this.cancelIdle();
    this.idleTimer = setTimeout(() => {
      void this.stop().catch(() => {});
    }, this.idleMs);
    this.idleTimer.unref?.();
  }
  async stop(): Promise<SandboxStatus> {
    if (this.leases || this.operation)
      throw new Error('Wait for the current sandbox operation before stopping it.');
    this.cancelIdle();
    await this.exclusive(async () => {
      if (this.leases) throw new Error('A sandbox execution is starting; wait before stopping.');
      await this.stopOwned();
    });
    return this.status();
  }
  private async stopOwned(cleanup = false): Promise<void> {
    if (!this.host || !this.ownsLifecycle) return;
    const containers = await this.ownedContainers(cleanup);
    for (const container of containers) {
      // Revalidate immediately before a scoped stop; never compose down or delete volumes.
      if (container.State.Running)
        await this.command(['stop', '--time', '10', container.Id], 20_000, false, cleanup);
    }
    this.publish(
      'stopped',
      'App-owned sandbox stopped. Python runtime data and all practice files were kept.',
      true,
    );
  }
  async close(): Promise<void> {
    this.cancelIdle();
    this.closed = true;
    this.abort.abort();
    // Cancel setup, then revalidate and stop only owned containers. No runtime
    // volume is removed, including after a partial image/runtime download.
    if (this.operation) await this.operation.catch(() => {});
    await this.stopOwned(true).catch(() => {});
  }

  // A close request can fail to save drafts. Cancel setup without disabling retries.
  cancelPending(): void {
    this.generation++;
    if (this.operation) this.abort.abort();
  }
}
