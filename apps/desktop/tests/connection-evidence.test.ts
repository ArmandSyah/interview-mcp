import { ChildProcess } from 'node:child_process';
import { EventEmitter, errorMonitor } from 'node:events';
import * as path from 'node:path';
import { expect, it, vi } from 'vitest';
import { captureConnectionEvidence } from './connection-evidence';

function fixture({
  existing = false,
  command = '/fixture/interview-mcp',
  args = [] as string[],
} = {}) {
  const stdin = Object.assign(new EventEmitter(), { write: vi.fn(() => false) });
  const stdout = new EventEmitter();
  const child = Object.assign(new ChildProcess(), {
    spawnfile: command,
    spawnargs: [command, ...args],
    stdin,
    stdout,
  });
  const originalWrite = stdin.write;
  const originalSpawn = vi.fn(() => child);
  const children = { ChildProcess, spawn: originalSpawn };
  const originalSend = vi.fn();
  const window = { webContents: { send: originalSend } };
  const app = new EventEmitter();
  let ms = 0;
  const runtime = {
    hrtime: { bigint: () => BigInt(ms * 1_000_000) },
    getBuiltinModule: (name: string) =>
      name === 'child_process' ? children : name === 'events' ? { errorMonitor } : path,
    _getActiveHandles: () => (existing ? [child] : []),
    workbenchConnectionEvidence: undefined as
      { version: number; truncated: boolean; entries: Record<string, unknown>[] } | undefined,
  };
  captureConnectionEvidence(
    { app, BrowserWindow: { getAllWindows: () => [window] } } as unknown as Parameters<
      typeof captureConnectionEvidence
    >[0],
    runtime as unknown as NodeJS.Process,
  );
  return {
    app,
    child,
    children,
    stdin,
    stdout,
    originalWrite,
    originalSpawn,
    originalSend,
    window,
    evidence: () => runtime.workbenchConnectionEvidence!,
    time: (value: number) => {
      ms = value;
    },
  };
}

it('records child phases and safe RPC metadata without a change to writes or spawn results', () => {
  const value = fixture();
  value.time(12);
  expect(value.children.spawn()).toBe(value.child);
  value.child.emit('spawn');
  const secret = 'fixture-private-body-must-not-enter-evidence';
  const request = JSON.stringify({
    id: 1,
    method: 'tools/call',
    params: { name: 'list_problems', arguments: { private: secret } },
  });
  const callback = vi.fn();
  expect(value.child.stdin!.write(request, 'utf8', callback)).toBe(false);
  expect(value.originalWrite).toHaveBeenCalledWith(request, 'utf8', callback);
  value.time(23);
  value.stdout.emit('data', Buffer.from(secret));
  value.stdout.emit('data', Buffer.from('more-private-data'));
  value.stdin.emit('finish');
  value.time(30);
  value.child.emit('exit', 0, null);
  value.child.emit('close', 0, null);
  expect(value.evidence().entries).toEqual([
    { elapsedMs: 0, event: 'observer-ready' },
    { elapsedMs: 12, event: 'child-spawn-request', childId: 1 },
    { elapsedMs: 12, event: 'child-spawn', childId: 1 },
    {
      elapsedMs: 12,
      event: 'stdin-write',
      childId: 1,
      bytes: Buffer.byteLength(request),
      requestId: 1,
      method: 'tools/call',
      tool: 'list_problems',
    },
    { elapsedMs: 23, event: 'stdout-first-data', childId: 1, bytes: Buffer.byteLength(secret) },
    { elapsedMs: 23, event: 'stdout-data', childId: 1, bytes: 17 },
    { elapsedMs: 23, event: 'stdin-finish', childId: 1 },
    { elapsedMs: 30, event: 'child-exit', childId: 1, code: 0, signaled: false },
    { elapsedMs: 30, event: 'child-close', childId: 1, code: 0, signaled: false },
  ]);
  expect(JSON.stringify(value.evidence())).not.toContain(secret);
  expect(JSON.stringify(value.evidence())).not.toContain('/fixture/');
});

it('marks a child found after spawn without inventing its start time or adding duplicate observers', () => {
  const value = fixture({ existing: true });
  value.children.spawn();
  value.stdout.emit('data', 'hello');
  expect(value.evidence().entries.map((entry) => entry.event)).toEqual([
    'child-observed-existing',
    'observer-ready',
    'stdout-first-data',
  ]);
});

it('records the request time before synchronous process creation finishes', () => {
  const value = fixture();
  value.time(10);
  value.originalSpawn.mockImplementation(() => {
    value.time(35);
    return value.child;
  });
  value.children.spawn();
  value.child.emit('spawn');
  expect(value.evidence().entries.slice(-2)).toEqual([
    { elapsedMs: 10, event: 'child-spawn-request', childId: 1 },
    { elapsedMs: 35, event: 'child-spawn', childId: 1 },
  ]);
});

for (const request of [
  JSON.stringify({
    id: 'fixture-private-id',
    method: 'fixture-private-method',
    params: { name: 'fixture-private-tool' },
  }),
  '{incomplete-fixture-private-body',
  JSON.stringify({ id: 8, method: 'initialize', params: { private: 'x'.repeat(5000) } }),
  'null',
]) {
  it(`keeps only the byte count for an unlisted or unreadable request (${request.length} bytes)`, () => {
    const value = fixture();
    value.children.spawn();
    value.child.stdin!.write(Buffer.from(request));
    expect(value.evidence().entries.at(-1)).toEqual({
      elapsedMs: 0,
      event: 'stdin-write',
      childId: 1,
      bytes: Buffer.byteLength(request),
    });
  });
}

for (const command of [
  '/fixture/interview-mcp.exe',
  '/fixture/python',
  '/fixture/python3.12',
  '/fixture/python.exe',
]) {
  it(`observes a local backend without recording its path (${path.basename(command)})`, () => {
    const value = fixture({ command, args: ['-m', 'server.desktop'] });
    value.children.spawn();
    expect(value.evidence().entries.at(-1)?.event).toBe('child-spawn-request');
  });
}

it('does not observe an unrelated process or Python module', () => {
  for (const command of ['/fixture/other', '/fixture/python']) {
    const value = fixture({ command, args: ['-m', 'other.module'] });
    value.children.spawn();
    value.stdout.emit('data', 'fixture-private-output');
    expect(value.evidence().entries).toHaveLength(1);
    expect(value.child.stdin!.write).toBe(value.originalWrite);
  }
});

it('records only connection state and counts from snapshots without changing the event', () => {
  const value = fixture();
  const event = {
    type: 'snapshot',
    snapshot: {
      connection: 'connecting',
      busy: true,
      error: 'fixture-private-error',
      problems: [{ title: 'fixture-private-title' }],
      designProblems: [],
      settings: { apiKey: 'fixture-private-key' },
      workspacePath: '/fixture/private',
    },
  };
  value.window.webContents.send('workbench:event', event);
  expect(value.originalSend).toHaveBeenCalledWith('workbench:event', event);
  expect(value.evidence().entries.at(-1)).toEqual({
    elapsedMs: 0,
    event: 'snapshot',
    connection: 'connecting',
    busy: true,
    hasError: true,
    problems: 1,
    designProblems: 0,
  });
  expect(JSON.stringify(value.evidence())).not.toContain('fixture-private');
  value.window.webContents.send('workbench:event', {
    type: 'chat-delta',
    text: 'fixture-private-chat',
  });
  value.window.webContents.send('other-channel', event);
  expect(value.evidence().entries).toHaveLength(2);
});

it('observes newly created windows once and bounds the record count', () => {
  const value = fixture();
  const window = { webContents: { send: vi.fn() } };
  value.app.emit('browser-window-created', {}, window);
  value.app.emit('browser-window-created', {}, window);
  for (let index = 0; index < 1005; index++)
    window.webContents.send('workbench:event', {
      type: 'snapshot',
      snapshot: { connection: 'connected', busy: false },
    });
  expect(window.webContents.send).not.toBe(value.window.webContents.send);
  expect(value.evidence().entries).toHaveLength(1000);
  expect(value.evidence().truncated).toBe(true);
});

it('records an error indicator without consuming an unhandled child error', () => {
  const value = fixture();
  value.children.spawn();
  expect(() => value.child.emit('error', new Error('fixture-private-error'))).toThrow(
    'fixture-private-error',
  );
  expect(value.evidence().entries.at(-1)).toEqual({
    elapsedMs: 0,
    event: 'child-error',
    childId: 1,
  });
  expect(JSON.stringify(value.evidence())).not.toContain('fixture-private');
});

it('preserves the transport error listener and its original error object', () => {
  const value = fixture();
  value.children.spawn();
  const listener = vi.fn();
  const error = new Error('fixture-private-transport-error');
  value.child.on('error', listener);
  expect(value.child.emit('error', error)).toBe(true);
  expect(listener).toHaveBeenCalledExactlyOnceWith(error);
  expect(value.evidence().entries.at(-1)).toMatchObject({ event: 'child-error', childId: 1 });
  expect(JSON.stringify(value.evidence())).not.toContain(error.message);
});
