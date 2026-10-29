import { expect, it, vi } from 'vitest';
import { ManagedSandbox, PISTON_IMAGE } from '../src/main/sandbox';
import type { SandboxStatus } from '../src/shared/sandbox';
import { readFile } from 'node:fs/promises';

const id = 'a'.repeat(64);
it('keeps the manual and bundled sandbox configuration pinned to the verified image', async () => {
  for (const path of ['resources/compose.sandbox.yml', '../../compose.desktop.yml']) {
    const config = await readFile(path, 'utf8');
    expect(config).toContain(`image: ${PISTON_IMAGE}`);
    expect(config).toContain("ports: ['127.0.0.1:2000:2000']");
    expect(config).toContain("PISTON_DISABLE_NETWORKING: 'true'");
    expect(config).toContain('mem_limit: 2g');
    expect(config).toContain('cpus: 1.5');
  }
  expect(await readFile('resources/compose.sandbox.yml', 'utf8')).toContain(
    '${INTERVIEW_SANDBOX_OWNER:?',
  );
});
function fixture(
  initial: {
    running?: boolean;
    owned?: boolean;
    python?: boolean;
    foreign?: boolean;
    host?: string;
    architecture?: string;
    failStart?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const state = { running: false, owned: false, python: false, foreign: false, ...initial };
  const statuses: SandboxStatus[] = [];
  let manager: ManagedSandbox;
  const run = vi.fn(
    async (raw: string[], options: { env: NodeJS.ProcessEnv; signal?: AbortSignal }) => {
      const args = raw[0] === '--host' ? raw.slice(2) : raw;
      if (args[0] === '--version') return 'Docker version 28';
      if (args[0] === 'context' && args[1] === 'show') return 'desktop-linux';
      if (args[0] === 'context' && args[1] === 'inspect')
        return JSON.stringify(initial.host ?? 'unix:///var/run/docker.sock');
      if (args[0] === 'info')
        return JSON.stringify({
          OSType: 'linux',
          Architecture: initial.architecture ?? 'x86_64',
          CgroupVersion: '2',
        });
      if (args[0] === 'compose' && args[1] === 'version') return '2.42.0';
      if (args[0] === 'ps') return state.owned || state.foreign ? id : '';
      if (args[0] === 'inspect')
        return JSON.stringify([
          {
            Id: id,
            Config: {
              Image: PISTON_IMAGE,
              Env: ['PISTON_DISABLE_NETWORKING=true'],
              Labels: {
                'io.github.armandsyah.interview-workbench.owner': state.foreign
                  ? 'someone-else'
                  : manager.owner,
                'com.docker.compose.project': manager.project,
                'com.docker.compose.service': 'piston',
              },
            },
            HostConfig: {
              Privileged: true,
              Memory: 2 * 1024 ** 3,
              NanoCpus: 1_500_000_000,
              PortBindings: { '2000/tcp': [{ HostIp: '127.0.0.1', HostPort: '2000' }] },
            },
            State: { Running: state.running },
          },
        ]);
      if (args[0] === 'compose') {
        expect(options.env.INTERVIEW_SANDBOX_OWNER).toBe(manager.owner);
        expect(options.env.ANTHROPIC_API_KEY).toBeUndefined();
        state.owned = true;
        state.running = true;
        if (state.failStart) throw new Error('registry-secret-should-never-be-shown');
        return '';
      }
      if (args[0] === 'stop') {
        expect(args).toEqual(['stop', '--time', '10', id]);
        state.running = false;
        return id;
      }
      throw new Error(`Unexpected Docker fixture command: ${args.join(' ')}`);
    },
  );
  const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url).startsWith('http://127.0.0.1:2000/api/v2/')).toBe(true);
    expect(init?.redirect).toBe('error');
    if (!state.running) throw new TypeError('Sandbox unreachable');
    if (String(url).endsWith('/runtimes'))
      return Response.json(
        state.python ? [{ language: 'python', version: '3.12.0', aliases: ['py'] }] : [],
      );
    if (String(url).endsWith('/packages')) {
      expect(state.owned).toBe(true);
      expect(JSON.parse(init?.body as string)).toEqual({ language: 'python', version: '3.12.0' });
      state.python = true;
      return Response.json({ language: 'python', version: '3.12.0' });
    }
    if (String(url).endsWith('/execute')) {
      expect(JSON.parse(init?.body as string).files[0].content).toBe(
        "print('interview-sandbox-ready')",
      );
      return Response.json({ run: { code: 0, stdout: 'interview-sandbox-ready\n', signal: null } });
    }
    throw new Error('Unexpected fixture HTTP request');
  });
  manager = new ManagedSandbox('/tmp/fixture-owned-workspace', '/tmp/fixture-compose.yml', {
    run,
    fetch: request as typeof fetch,
    env: initial.env ?? { PATH: '/fixture/bin', ANTHROPIC_API_KEY: 'never-forward-me' },
    idleMs: 100,
    emit: (status) => statuses.push(status),
  });
  const mutations = () =>
    run.mock.calls.filter(([args]) => args.includes('up') || args.includes('stop'));
  return { manager, state, run, request, statuses, mutations };
}

it('does nothing on construction and inspection never starts a container', async () => {
  const { manager, run, mutations } = fixture();
  expect(run).not.toHaveBeenCalled();
  expect(manager.status().phase).toBe('unchecked');
  expect((await manager.inspect()).phase).toBe('stopped');
  expect(mutations()).toEqual([]);
  await manager.close();
  expect(mutations()).toEqual([]);
});

it('cancels a pending command and permits another inspection if window closure fails', async () => {
  const { manager, run, mutations } = fixture();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  run.mockImplementationOnce(
    (_args, options) =>
      new Promise<string>((_resolve, reject) => {
        options.signal!.addEventListener(
          'abort',
          () => reject(new Error('Cancelled fixture command')),
          { once: true },
        );
        entered();
      }),
  );
  const inspect = manager.inspect();
  const rejected = expect(inspect).rejects.toThrow();
  await started;
  const queued = expect(manager.inspect()).rejects.toThrow('Sandbox operation cancelled');
  manager.cancelPending();
  await rejected;
  await queued;
  expect(run).toHaveBeenCalledTimes(1);
  expect((await manager.inspect()).phase).toBe('stopped');
  expect(mutations()).toEqual([]);
  await manager.close();
});

it('cancelled runtime discovery cannot start a container', async () => {
  const { manager, request, mutations, statuses } = fixture();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  request.mockImplementationOnce(
    (_url, options) =>
      new Promise<Response>((_resolve, reject) => {
        options!.signal!.addEventListener(
          'abort',
          () => reject(new Error('Cancelled runtime request')),
          { once: true },
        );
        entered();
      }),
  );
  const rejected = expect(manager.enable()).rejects.toThrow();
  await started;
  manager.cancelPending();
  await rejected;
  expect(mutations()).toEqual([]);
  expect(statuses.some((status) => status.phase === 'starting')).toBe(false);
  await manager.close();
  expect(mutations()).toEqual([]);
});

it('starts the pinned app-owned sandbox, installs Python, checks execution, and stops without deleting data', async () => {
  const { manager, state, run, request, statuses } = fixture();
  expect((await manager.enable()).phase).toBe('ready');
  expect(manager.status().managed).toBe(true);
  expect(statuses.map((status) => status.phase)).toEqual([
    'checking',
    'starting',
    'installing',
    'ready',
  ]);
  expect(request.mock.calls.some(([url]) => String(url).endsWith('/packages'))).toBe(true);
  await manager.stop();
  expect(state.running).toBe(false);
  expect(state.python).toBe(true);
  await manager.withExecution(async () => expect(state.running).toBe(true));
  expect(request.mock.calls.filter(([url]) => String(url).endsWith('/packages'))).toHaveLength(1);
  await manager.close();
  expect(state.running).toBe(false);
  expect(run.mock.calls.every(([args]) => !args.includes('down') && !args.includes('rm'))).toBe(
    true,
  );
});

it('reuses an existing sandbox but never installs, stops, or assumes ownership', async () => {
  const { manager, request, mutations } = fixture({ running: true, python: true });
  expect((await manager.enable()).managed).toBe(false);
  await manager.withExecution(async () => 'candidate tests');
  await manager.stop();
  await manager.close();
  expect(mutations()).toEqual([]);
  expect(request.mock.calls.some(([url]) => String(url).endsWith('/packages'))).toBe(false);
});

it('does not install missing Python into an externally owned sandbox', async () => {
  const { manager, request, mutations } = fixture({ running: true });
  await expect(manager.enable()).rejects.toThrow('will not change someone else');
  await manager.close();
  expect(mutations()).toEqual([]);
  expect(request.mock.calls.some(([url]) => String(url).endsWith('/packages'))).toBe(false);
});

it.each([
  { env: { DOCKER_HOST: 'tcp://127.0.0.1:2375' }, message: 'Remote Docker' },
  { host: 'ssh://example.test', message: 'local Docker socket' },
  { architecture: 'aarch64', message: 'Linux AMD64' },
  { foreign: true, message: 'ownership' },
])('rejects unsupported routing/platform/ownership without mutations: %j', async (initial) => {
  const { manager, mutations } = fixture(initial);
  await expect(manager.enable()).rejects.toThrow(initial.message);
  await manager.close();
  expect(mutations()).toEqual([]);
});

it('reports missing Docker without forwarding raw process errors', async () => {
  const { manager, run } = fixture();
  run.mockRejectedValueOnce(Object.assign(new Error('private-machine-path'), { code: 'ENOENT' }));
  await expect(manager.inspect()).rejects.toThrow('Docker CLI not found');
  expect(manager.status().phase).toBe('docker-missing');
  expect(JSON.stringify(manager.status())).not.toContain('private-machine-path');
  await manager.close();
});

it('protects active executions from idle stop, then stops after release', async () => {
  vi.useFakeTimers();
  const { manager, state } = fixture();
  try {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const job = manager.withExecution(() => gate);
    await vi.waitFor(() => expect(manager.status().phase).toBe('ready'));
    await vi.advanceTimersByTimeAsync(500);
    expect(state.running).toBe(true);
    await expect(manager.stop()).rejects.toThrow('current sandbox operation');
    release();
    await job;
    await vi.advanceTimersByTimeAsync(100);
    expect(state.running).toBe(false);
  } finally {
    await manager.close();
    vi.useRealTimers();
  }
});

it('cleans up only owned running containers after partial setup failure and redacts errors', async () => {
  const { manager, state, mutations } = fixture({ failStart: true });
  await expect(manager.enable()).rejects.toThrow('Sandbox setup failed');
  expect(JSON.stringify(manager.status())).not.toContain('registry-secret');
  await manager.close();
  expect(state.running).toBe(false);
  expect(mutations()).toHaveLength(2);
});

it('cancels a runtime download on exit and still stops the owned container', async () => {
  const { manager, request, state } = fixture();
  const original = request.getMockImplementation()!;
  request.mockImplementation(async (url, init) => {
    if (!String(url).endsWith('/packages')) return original(url, init);
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('Canceled download')), {
        once: true,
      });
    });
  });
  const setup = manager.enable();
  const failed = expect(setup).rejects.toThrow('Sandbox setup failed');
  await vi.waitFor(() => expect(manager.status().phase).toBe('installing'));
  await manager.close();
  await failed;
  expect(state.running).toBe(false);
  expect(state.owned).toBe(true);
  expect(state.python).toBe(false);
});

it('rechecks ownership before stopping instead of trusting an earlier ready result', async () => {
  const { manager, state, mutations } = fixture();
  await manager.enable();
  state.foreign = true;
  await expect(manager.stop()).rejects.toThrow('ownership');
  await manager.close();
  expect(state.running).toBe(true);
  expect(mutations()).toHaveLength(1); // initial setup only; no stop of the changed container
});
