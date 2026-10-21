import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { ManagedSandbox } from '../src/main/sandbox';
import type { SandboxStatus } from '../src/shared/sandbox';

// Opt-in CI integration. Never starts Docker during ordinary unit tests.
it.skipIf(process.env.INTERVIEW_DESKTOP_TEST_MANAGED_SANDBOX !== '1')(
  'real app-managed Piston: setup, isolated execution, stop, and cached-runtime restart',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'interview-managed-piston-'));
    const statuses: SandboxStatus[] = [];
    const manager = new ManagedSandbox(directory, resolve('resources/compose.sandbox.yml'), {
      emit: (status) => statuses.push(status),
    });
    try {
      expect(await manager.enable()).toMatchObject({ phase: 'ready', managed: true });
      const installationCount = statuses.filter((status) => status.phase === 'installing').length;
      expect(installationCount).toBe(1);
      const result = await manager.withExecution(async () => {
        const payload = {
          language: 'python',
          version: '3.12.0',
          run_timeout: 3000,
          run_memory_limit: 64 * 1024 ** 2,
          files: [
            {
              content: `import socket\nprint(6 * 7)\ntry:\n    socket.create_connection(('1.1.1.1', 443), timeout=1)\nexcept OSError:\n    print('network-disabled')\nelse:\n    raise AssertionError('solution networking is enabled')\n`,
            },
          ],
        };
        const response = await fetch('http://127.0.0.1:2000/api/v2/execute', {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const body = await response.text();
        expect(
          response.status,
          `POST /api/v2/execute after setup: arguments=${JSON.stringify(payload)}, expected HTTP 200, actual HTTP ${response.status}: ${body}`,
        ).toBe(200);
        return JSON.parse(body);
      });
      expect(result.run).toMatchObject({ code: 0, stdout: '42\nnetwork-disabled\n', signal: null });
      expect((await manager.stop()).phase).toBe('stopped');
      expect((await manager.enable()).phase).toBe('ready');
      expect(statuses.filter((status) => status.phase === 'installing')).toHaveLength(
        installationCount,
      );
    } finally {
      await manager.close();
    }
    expect(manager.status().phase).toBe('stopped');
  },
  360_000,
);
