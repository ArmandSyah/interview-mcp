import type { ElectronApplication } from '@playwright/test';

type Call = { args: unknown[]; release: (error?: string) => void };
type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown;
type Gate = { original: Handler; calls: Call[] };
type TestIpc = Electron.IpcMain & {
  _invokeHandlers: Map<string, Handler>;
  workbenchTestGates?: Map<string, Gate>;
};

// Delay the real IPC handler. Keep the real renderer, preload, service, and disk writes.
// Electron has no public API to get an existing handler. Fail if its test adapter changes.
export async function gateIpc(app: ElectronApplication, method: string) {
  const channel = `workbench:${method}`;
  await app.evaluate(({ ipcMain }, channel) => {
    const ipc = ipcMain as TestIpc;
    const original = ipc._invokeHandlers?.get(channel);
    if (!original) throw new Error(`No IPC handler for ${channel}`);
    ipc.workbenchTestGates ??= new Map();
    if (ipc.workbenchTestGates.has(channel)) throw new Error(`Duplicate IPC gate: ${channel}`);
    const gate: Gate = { original, calls: [] };
    ipc.workbenchTestGates.set(channel, gate);
    ipc.removeHandler(channel);
    ipc.handle(channel, async (event, ...args: unknown[]) => {
      await new Promise<void>((resolve, reject) => {
        gate.calls.push({
          args,
          release: (error) => (error ? reject(new Error(error)) : resolve()),
        });
      });
      return original(event, ...args);
    });
  }, channel);
  return {
    calls: () =>
      app.evaluate(
        ({ ipcMain }, channel) =>
          (ipcMain as TestIpc).workbenchTestGates!.get(channel)!.calls.map((call) => call.args),
        channel,
      ),
    release: (index: number, error?: string) =>
      app.evaluate(
        ({ ipcMain }, { channel, index, error }) => {
          const call = (ipcMain as TestIpc).workbenchTestGates!.get(channel)!.calls[index];
          if (!call) throw new Error(`No call ${index} for ${channel}`);
          call.release(error);
        },
        { channel, index, error },
      ),
    restore: () =>
      app.evaluate(({ ipcMain }, channel) => {
        const ipc = ipcMain as TestIpc;
        const gate = ipc.workbenchTestGates?.get(channel);
        if (!gate) return;
        ipc.removeHandler(channel);
        ipc.handle(channel, gate.original);
        ipc.workbenchTestGates!.delete(channel);
        for (const call of gate.calls) call.release();
      }, channel),
  };
}
