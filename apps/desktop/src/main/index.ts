import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, safeStorage } from 'electron';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { LocalStore } from './storage';
import { McpConnection } from './mcp';
import { WorkbenchService } from './service';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'interview',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);
if (process.env.INTERVIEW_DESKTOP_DATA_DIR)
  app.setPath('userData', resolve(process.env.INTERVIEW_DESKTOP_DATA_DIR));
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
let window: BrowserWindow | null = null;
let service: WorkbenchService;
let closing = false;
let closeRequested = false;
let draftFlushed = false;
const devUrl = process.env.INTERVIEW_DESKTOP_DEV_URL;

app.on('second-instance', () => {
  window?.restore();
  window?.focus();
});
async function finishQuit() {
  if (closing) return;
  closing = true;
  try {
    await service?.close();
  } finally {
    app.quit();
  }
}
app.on('window-all-closed', () => {
  void finishQuit();
});
app.on('before-quit', (event) => {
  if (closing || !service) return;
  event.preventDefault();
  if (window && !window.isDestroyed()) window.close();
  else void finishQuit();
});

void app.whenReady().then(async () => {
  const root = app.isPackaged ? process.resourcesPath : resolve(__dirname, '../../../..');
  const renderer = resolve(__dirname, '../renderer');
  protocol.handle('interview', (request) => {
    const url = new URL(request.url);
    const path = resolve(renderer, `.${decodeURIComponent(url.pathname)}`);
    if (url.hostname !== 'workbench' || relative(renderer, path).startsWith('..'))
      return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(path).toString());
  });
  window = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1040,
    minHeight: 660,
    title: 'Interview Workbench',
    backgroundColor: '#121419',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: 'Workbench', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: 'View',
        submenu: [
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { role: 'togglefullscreen' },
          ...(!app.isPackaged ? [{ role: 'toggleDevTools' as const }] : []),
        ],
      },
    ]),
  );
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (
      !url.startsWith('interview://workbench/') &&
      !(devUrl && new URL(url).origin === new URL(devUrl).origin)
    )
      event.preventDefault();
  });
  window.on('close', (event) => {
    if (draftFlushed || !service) return;
    event.preventDefault();
    if (!closeRequested) {
      closeRequested = true;
      window?.webContents.send('workbench:event', { type: 'flush-before-close' });
    }
  });
  const vault = {
    available: () =>
      safeStorage.isEncryptionAvailable() &&
      (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    encrypt: (value: string) => safeStorage.encryptString(value).toString('base64'),
    decrypt: (value: string) => safeStorage.decryptString(Buffer.from(value, 'base64')),
  };
  const store = new LocalStore(app.getPath('userData'));
  const backend = app.isPackaged
    ? join(
        process.resourcesPath,
        'backend',
        process.platform === 'win32' ? 'interview-mcp.exe' : 'interview-mcp',
      )
    : undefined;
  service = new WorkbenchService(
    store,
    new McpConnection(root, store.root, backend),
    vault,
    (event) => {
      if (window && !window.isDestroyed()) window.webContents.send('workbench:event', event);
    },
  );
  function handler(channel: string, action: (...args: unknown[]) => unknown) {
    ipcMain.handle(`workbench:${channel}`, (event, ...args: unknown[]) => {
      const senderUrl = event.senderFrame?.url;
      if (
        !window ||
        event.sender !== window.webContents ||
        !senderUrl ||
        !(
          senderUrl.startsWith('interview://workbench/') ||
          (devUrl && new URL(senderUrl).origin === new URL(devUrl).origin)
        )
      )
        throw new Error('Untrusted IPC sender');
      return action(...args);
    });
  }
  const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,60}$/);
  handler('snapshot', () => service.snapshot());
  handler('reconnect', () => service.reconnect());
  handler('start', (value) => service.startProblem(id.parse(value)));
  handler('activate', (value) => service.activateProblem(id.parse(value)));
  handler('save', (value, code) =>
    service.saveCode(id.parse(value), z.string().max(100_000).parse(code)),
  );
  handler('run', (submit) => service.runTests(z.boolean().parse(submit)));
  handler('hint', () => service.hint());
  handler('chat', (text) => service.chat(z.string().min(1).max(8000).parse(text)));
  handler('cancel', () => service.cancelChat());
  handler('approve', (value, allow) =>
    service.approve(z.string().uuid().parse(value), z.boolean().parse(allow)),
  );
  handler('settings', (settings) =>
    service.updateSettings(settings as Parameters<WorkbenchService['updateSettings']>[0]),
  );
  handler('clear-chat', () => service.clearChat());
  handler('close-ready', (saved) => {
    if (!closeRequested) return;
    if (!z.boolean().parse(saved)) {
      closeRequested = false;
      return;
    }
    draftFlushed = true;
    window?.close();
  });
  handler('corpus', async () => {
    const result = await dialog.showOpenDialog(window!, {
      title: 'Select exported runtime questions',
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  handler('export', async () => {
    const snapshot = service.snapshot();
    const session = snapshot.sessions.find((item) => item.problem.id === snapshot.activeProblemId);
    if (!session) throw new Error('Open a problem first');
    const result = await dialog.showSaveDialog(window!, {
      title: 'Export your solution',
      defaultPath: `${session.problem.id}-solution.py`,
      filters: [{ name: 'Python', extensions: ['py'] }],
    });
    if (result.canceled || !result.filePath) return null;
    await writeFile(result.filePath, session.code, { encoding: 'utf8', mode: 0o600 });
    return result.filePath;
  });
  await window.loadURL(devUrl || 'interview://workbench/index.html');
  window.show();
  try {
    await service.initialize();
  } catch (error) {
    await dialog.showMessageBox(window, {
      type: 'error',
      title: 'Cannot open workspace',
      message:
        error instanceof Error
          ? error.message
          : 'Startup failed. Your saved workspace was not overwritten.',
    });
  }
});
