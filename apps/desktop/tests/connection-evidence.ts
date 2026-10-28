import type { ChildProcess } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { ElectronApplication } from '@playwright/test';

type Entry = { elapsedMs: number; event: string; [key: string]: string | number | boolean };
type Evidence = { version: 1; truncated: boolean; entries: Entry[] };
type EvidenceProcess = NodeJS.Process & {
  workbenchConnectionEvidence?: Evidence;
  _getActiveHandles?: () => unknown[];
};

// Playwright executes this function in Electron. Keep its runtime dependencies inside it.
export function captureConnectionEvidence(
  { app, BrowserWindow }: Pick<typeof import('electron'), 'app' | 'BrowserWindow'>,
  runtime: NodeJS.Process = process,
) {
  const host = runtime as EvidenceProcess;
  if (host.workbenchConnectionEvidence) throw new Error('Connection observer already installed');
  const evidence: Evidence = { version: 1, truncated: false, entries: [] };
  host.workbenchConnectionEvidence = evidence;
  const start = runtime.hrtime.bigint();
  const childProcess = runtime.getBuiltinModule('child_process');
  const { errorMonitor } = runtime.getBuiltinModule('events');
  const path = runtime.getBuiltinModule('path');
  const seen = new WeakSet<ChildProcess>();
  let childNumber = 0;
  function record(event: string, values: Record<string, string | number | boolean> = {}) {
    if (evidence.entries.length >= 1000) {
      evidence.truncated = true;
      return;
    }
    evidence.entries.push({
      elapsedMs: Number((runtime.hrtime.bigint() - start) / 1_000_000n),
      event,
      ...values,
    });
  }
  function observe(child: ChildProcess, existing: boolean, spawnStartedMs?: number) {
    if (seen.has(child)) return;
    const command = path.basename(child.spawnfile || '').toLowerCase();
    const isBackend = command === 'interview-mcp' || command === 'interview-mcp.exe';
    const isPython =
      /^python(?:\d+(?:\.\d+)?)?(?:\.exe)?$/.test(command) &&
      child.spawnargs.some(
        (value, index, args) => value === '-m' && args[index + 1] === 'server.desktop',
      );
    if (!isBackend && !isPython) return;
    seen.add(child);
    const childId = ++childNumber;
    record(existing ? 'child-observed-existing' : 'child-spawn-request', {
      childId,
      ...(spawnStartedMs === undefined ? {} : { elapsedMs: spawnStartedMs }),
    });
    child.once('spawn', () => record('child-spawn', { childId }));
    (child as EventEmitter).once(errorMonitor, () => record('child-error', { childId }));
    child.once('exit', (code, signal) =>
      record('child-exit', { childId, code: code ?? -1, signaled: signal !== null }),
    );
    child.once('close', (code, signal) =>
      record('child-close', { childId, code: code ?? -1, signaled: signal !== null }),
    );
    child.stdin?.once('finish', () => record('stdin-finish', { childId }));
    let first = true;
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      record(first ? 'stdout-first-data' : 'stdout-data', { childId, bytes });
      first = false;
    });
    if (child.stdin) {
      const originalWrite = child.stdin.write;
      child.stdin.write = function (
        this: NonNullable<ChildProcess['stdin']>,
        ...args: Parameters<typeof originalWrite>
      ) {
        // Never record arguments, result bodies, credentials, paths, or child log text.
        const chunk: unknown = args[0];
        const bytes =
          typeof chunk === 'string'
            ? Buffer.byteLength(chunk)
            : Buffer.isBuffer(chunk)
              ? chunk.length
              : 0;
        const values: Record<string, string | number | boolean> = { childId, bytes };
        if (bytes > 0 && bytes <= 4096) {
          try {
            const message = JSON.parse(String(chunk));
            if (typeof message.id === 'number' && Number.isFinite(message.id))
              values.requestId = message.id;
            if (
              ['initialize', 'notifications/initialized', 'tools/list', 'tools/call'].includes(
                message.method,
              )
            )
              values.method = message.method;
            if (
              message.method === 'tools/call' &&
              [
                'list_problems',
                'get_progress',
                'list_design_problems',
                'list_content_packs',
              ].includes(message.params?.name)
            )
              values.tool = message.params.name;
          } catch {
            // An incomplete or large message contributes only its byte count.
          }
        }
        record('stdin-write', values);
        return originalWrite.apply(this, args);
      } as typeof originalWrite;
    }
  }
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = function (
    this: typeof childProcess,
    ...args: Parameters<typeof originalSpawn>
  ) {
    const startedMs = Number((runtime.hrtime.bigint() - start) / 1_000_000n);
    const child = originalSpawn.apply(this, args);
    observe(child, false, startedMs);
    return child;
  } as typeof originalSpawn;
  for (const handle of host._getActiveHandles?.() ?? [])
    if (handle instanceof childProcess.ChildProcess) observe(handle, true);

  const windows = new WeakSet<Electron.BrowserWindow>();
  function observeWindow(window: Electron.BrowserWindow) {
    if (windows.has(window)) return;
    windows.add(window);
    const contents = window.webContents;
    const originalSend = contents.send;
    contents.send = function (channel: string, ...args: unknown[]) {
      if (channel === 'workbench:event') {
        const event = args[0] as { type?: unknown; snapshot?: Record<string, unknown> } | null;
        const snapshot = event?.type === 'snapshot' ? event.snapshot : undefined;
        if (snapshot) {
          const connection = ['connecting', 'connected', 'disconnected'].includes(
            String(snapshot.connection),
          )
            ? String(snapshot.connection)
            : 'unknown';
          record('snapshot', {
            connection,
            busy: snapshot.busy === true,
            hasError: snapshot.error != null,
            problems: Array.isArray(snapshot.problems) ? snapshot.problems.length : 0,
            designProblems: Array.isArray(snapshot.designProblems)
              ? snapshot.designProblems.length
              : 0,
          });
        }
      }
      return originalSend.call(this, channel, ...args);
    };
  }
  app.on('browser-window-created', (_event, window) => observeWindow(window));
  for (const window of BrowserWindow.getAllWindows()) observeWindow(window);
  record('observer-ready');
}

export async function connectionEvidence(app: ElectronApplication): Promise<Evidence | undefined> {
  return app.evaluate(() => (process as EvidenceProcess).workbenchConnectionEvidence);
}
