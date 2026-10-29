import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  safeStorage,
  shell,
} from 'electron';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chmod, mkdir, open, readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LocalStore } from './storage';
import { McpConnection } from './mcp';
import { WorkbenchService, reflectionDraftSchema } from './service';
import trust from '../../../../server/distribution/trust.json';
import { ReleaseUpdates } from './updates';
import { ManagedSandbox } from './sandbox';
import { writeExport } from './export-file';

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
let finalizingClose = false;
let closeCommit: Promise<void> | null = null;
let initialization: Promise<void> = Promise.resolve();
let rendererLoaded = false;
const pendingRequests = new Set<Promise<unknown>>();
const devUrl = process.env.INTERVIEW_DESKTOP_DEV_URL;

app.on('second-instance', () => {
  window?.restore();
  window?.focus();
});
async function finishQuit() {
  if (closing) return;
  closing = true;
  try {
    await initialization;
    await service?.close({ save: !draftFlushed });
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
    if (draftFlushed || !service || !rendererLoaded) return;
    event.preventDefault();
    closeRequested = true;
    updates.cancelPending();
    service.cancelSandboxSetup();
    window?.webContents.send('workbench:event', { type: 'flush-before-close' });
  });
  const vault = {
    available: () =>
      safeStorage.isEncryptionAvailable() &&
      (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    encrypt: (value: string) => safeStorage.encryptString(value).toString('base64'),
    decrypt: (value: string) => safeStorage.decryptString(Buffer.from(value, 'base64')),
  };
  const store = new LocalStore(app.getPath('userData'));
  const updates = new ReleaseUpdates(store.root, app.getVersion(), trust.releasePublicKey);
  const sandbox = new ManagedSandbox(
    store.root,
    app.isPackaged
      ? join(process.resourcesPath, 'sandbox', 'compose.sandbox.yml')
      : join(root, 'apps/desktop/resources/compose.sandbox.yml'),
    {
      emit: (status) => {
        if (window && !window.isDestroyed())
          window.webContents.send('workbench:event', { type: 'sandbox', status });
      },
    },
  );
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
    undefined,
    sandbox,
  );
  function handler(channel: string, action: (...args: unknown[]) => unknown) {
    ipcMain.handle(`workbench:${channel}`, async (event, ...args: unknown[]) => {
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
      if (finalizingClose && !['close-ready', 'cancel', 'snapshot'].includes(channel))
        throw new Error('The window is closing.');
      if (
        closeRequested &&
        [
          'chat',
          'grade',
          'sandbox-inspect',
          'sandbox-enable',
          'sandbox-stop',
          'run',
          'settings',
          'update-check',
          'update-download',
          'update-install',
        ].includes(channel)
      )
        throw new Error('The window is closing.');
      const operation = Promise.resolve().then(() => action(...args));
      if (['close-ready', 'cancel', 'snapshot'].includes(channel)) return operation;
      pendingRequests.add(operation);
      try {
        return await operation;
      } finally {
        pendingRequests.delete(operation);
      }
    });
  }
  const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,60}$/);
  handler('snapshot', () => {
    if (closeRequested) window?.webContents.send('workbench:event', { type: 'flush-before-close' });
    return service.snapshot();
  });
  handler('practice-queue', () => service.practiceQueue());
  handler('practice-add', (kind, id, days) =>
    service.addPracticeReview(
      z.enum(['coding', 'design']).parse(kind),
      z.string().max(100).parse(id),
      z.number().int().min(0).max(365).parse(days),
    ),
  );
  handler('practice-reschedule', (id, days, version) =>
    service.reschedulePracticeReview(
      z.string().uuid().parse(id),
      z.number().int().min(0).max(365).parse(days),
      z.number().int().min(0).parse(version),
    ),
  );
  handler('practice-pause', (id, paused, version) =>
    service.pausePracticeReview(
      z.string().uuid().parse(id),
      z.boolean().parse(paused),
      z.number().int().min(0).parse(version),
    ),
  );
  handler('practice-history', (id) => service.practiceReflections(z.string().uuid().parse(id)));
  handler('practice-draft-load', (id) => service.loadReflectionDraft(z.string().uuid().parse(id)));
  handler('practice-draft-save', (id, draft) =>
    service.saveReflectionDraft(z.string().uuid().parse(id), reflectionDraftSchema.parse(draft)),
  );
  handler('practice-reflect', (input) =>
    service.recordPracticeReflection(
      reflectionDraftSchema.extend({ item_id: z.string().uuid() }).parse(input),
    ),
  );
  handler('sandbox-info', () => service.sandboxInfo());
  handler('sandbox-inspect', () => service.inspectSandbox());
  handler('sandbox-stop', () => service.stopSandbox());
  handler('sandbox-enable', async () => {
    if (service.snapshot().busy) throw new Error('Wait for the current operation');
    if (!service.settings().managedSandbox) {
      const result = await dialog.showMessageBox(window!, {
        type: 'warning',
        title: 'Enable local code execution?',
        message: 'Piston needs a privileged Docker container on your computer.',
        detail:
          'Use only your own trusted workstation or an isolated local Docker VM. The app downloads a pinned image and Python runtime, binds port 2000 to loopback, and disables networking for solutions. It manages only its own container, stops it when idle or on exit, and keeps runtime data. Existing sandboxes are reused without changes. No model is installed and no paid service is provisioned.',
        buttons: ['Keep practicing without execution', 'Enable local execution'],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response !== 1) return null;
    }
    if (closeRequested || finalizingClose) throw new Error('The window is closing.');
    return service.enableSandbox();
  });
  handler('license-notices', async () => {
    const fonts = await readFile(
      app.isPackaged
        ? join(renderer, 'third-party/notices.txt')
        : join(root, 'apps/desktop/licenses/notices.txt'),
      'utf8',
    );
    const additional = await Promise.all(
      ['PROJECT-LICENSE.txt', 'dependency-notices.txt'].map((name) =>
        readFile(join(renderer, 'third-party', name), 'utf8').catch(() => ''),
      ),
    );
    return [fonts, ...additional].join('\n\n');
  });
  handler('update-info', () => updates.info());
  handler('update-check', (channel) => updates.check(z.enum(['stable', 'beta']).parse(channel)));
  handler('update-download', () => updates.download());
  handler('update-install', async () => {
    if (service.snapshot().busy)
      throw new Error('Finish or stop the current practice operation first');
    const installer = await updates.installerPath();
    if (closeRequested || finalizingClose) throw new Error('The window is closing.');
    const confirmation = await dialog.showMessageBox(window!, {
      type: 'question',
      title: 'Open verified installer?',
      message:
        'Your practice data will be backed up first. The installer may close this app. Open it now?',
      buttons: ['Keep practicing', 'Back up & open installer'],
      defaultId: 0,
      cancelId: 0,
    });
    if (confirmation.response !== 1) return;
    if (closeRequested || finalizingClose) throw new Error('The window is closing.');
    const backup = await service.exportWorkspace();
    const directory = join(store.root, 'backups');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = await open(join(directory, 'pre-update-' + randomUUID() + '.json'), 'wx', 0o600);
    try {
      await file.writeFile(backup, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    if (installer.endsWith('.AppImage')) await chmod(installer, 0o700);
    if (closeRequested || finalizingClose) throw new Error('The window is closing.');
    const error = await shell.openPath(installer);
    if (error) throw new Error(error);
  });
  handler('export-workspace', async () => {
    const data = await service.exportWorkspace();
    const result = await dialog.showSaveDialog(window!, {
      title: 'Export practice backup (without credentials)',
      defaultPath: 'interview-practice-backup.json',
      filters: [{ name: 'Practice backup', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return null;
    await writeExport(result.filePath, data);
    return result.filePath;
  });
  handler('distribution-info', () => ({
    contentSigningConfigured: !!trust.contentPublicKey,
    checkoutConfigured: !!trust.checkoutUrl,
  }));
  handler('checkout', async () => {
    const url = new URL(trust.checkoutUrl);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !(
        url.hostname.endsWith('.lemonsqueezy.com') ||
        ['buy.stripe.com', 'checkout.stripe.com'].includes(url.hostname)
      )
    )
      throw new Error('A supported hosted checkout is not configured');
    await shell.openExternal(url.href);
  });
  handler('install-pack', async () => {
    if (!trust.contentPublicKey)
      throw new Error('Content signing is not configured in this preview build');
    if (service.snapshot().busy) throw new Error('Wait for the current operation');
    const result = await dialog.showOpenDialog(window!, {
      title: 'Select your signed content pack and license',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Signed JSON', extensions: ['json'] }],
    });
    if (result.canceled) return;
    if (result.filePaths.length !== 2)
      throw new Error('Select exactly one signed pack file and its signed license file');
    const selected = [];
    for (const path of result.filePaths) {
      if ((await stat(path)).size > 24_000_000) throw new Error('Signed package is too large');
      const json = await readFile(path, 'utf8');
      const envelope = JSON.parse(json) as { payload?: unknown };
      if (typeof envelope.payload !== 'string') throw new Error('Not a signed package or license');
      const payload = JSON.parse(
        Buffer.from(envelope.payload, 'base64').toString('utf8'),
      ) as Record<string, unknown>;
      selected.push({ json, license: 'license_id' in payload });
    }
    const pack = selected.find((item) => !item.license),
      license = selected.find((item) => item.license);
    if (!pack || !license) throw new Error('Select one pack and one license');
    await service.installContentPack(pack.json, license.json);
  });
  handler('mode', (mode) => service.setMode(z.enum(['coding', 'design']).parse(mode)));
  handler('design-start', (value, fresh) =>
    service.startDesign(id.parse(value), z.boolean().parse(fresh)),
  );
  handler('design-activate', (value) => service.activateDesign(z.string().uuid().parse(value)));
  handler('design-load', (value) => service.loadDesignDraft(z.string().uuid().parse(value)));
  handler('design-save', (value, draft) =>
    service.saveDesignDraft(
      z.string().uuid().parse(value),
      draft as Parameters<WorkbenchService['saveDesignDraft']>[1],
    ),
  );
  handler('design-checkpoint', (label) =>
    service.checkpointDesign(z.string().min(1).max(80).parse(label)),
  );
  handler('design-history', () => service.designCheckpoints());
  handler('design-restore', (value) =>
    service.restoreDesignCheckpoint(z.string().uuid().parse(value)),
  );
  handler('design-review', () => service.reviewDesign());
  handler('design-hint', () => service.designHint());
  handler('design-finish', () => service.finishDesign());
  handler('design-export', async (value, bytes) => {
    const format = z.enum(['excalidraw', 'workspace', 'png']).parse(value);
    let data: string | Uint8Array;
    if (format === 'png') {
      if (
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength > 20_000_000 ||
        !Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      )
        throw new Error('Invalid PNG export');
      data = bytes;
    } else data = await service.designExport(format);
    const extension = format === 'workspace' ? 'json' : format;
    const result = await dialog.showSaveDialog(window!, {
      title: 'Export your design',
      defaultPath: `my-design.${extension}`,
      filters: [{ name: 'Design export', extensions: [extension] }],
    });
    if (result.canceled || !result.filePath) return null;
    await writeExport(result.filePath, data);
    return result.filePath;
  });
  handler('reconnect', () => service.reconnect());
  handler('start', (value) => service.startProblem(id.parse(value)));
  handler('activate', (value) => service.activateProblem(id.parse(value)));
  handler('save', (value, code) =>
    service.saveCode(id.parse(value), z.string().max(100_000).parse(code)),
  );
  handler('run', (submit) => service.runTests(z.boolean().parse(submit)));
  handler('hint', () => service.hint());
  handler('chat', (text) => service.chat(z.string().min(1).max(8000).parse(text)));
  handler('grade', () => service.grade());
  handler('cancel', (chatId) => service.cancelChat(z.string().uuid().optional().parse(chatId)));
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
    if (closeCommit) return closeCommit;
    finalizingClose = true;
    closeCommit = (async () => {
      try {
        await initialization;
        while (pendingRequests.size) await Promise.allSettled([...pendingRequests]);
        await service.prepareClose();
        draftFlushed = true;
        window?.close();
      } catch (error) {
        finalizingClose = false;
        closeRequested = false;
        throw error;
      } finally {
        closeCommit = null;
      }
    })();
    return closeCommit;
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
    await writeExport(result.filePath, session.code);
    return result.filePath;
  });
  let initialized!: () => void;
  initialization = new Promise<void>((resolve) => {
    initialized = resolve;
  });
  try {
    while (!rendererLoaded && !window.isDestroyed()) {
      try {
        await window.loadURL(devUrl || 'interview://workbench/index.html');
        rendererLoaded = true;
      } catch {
        if (window.isDestroyed()) return;
        window.show();
        const startupWindow = window;
        let onClosed!: () => void;
        const closed = new Promise<null>((resolve) => {
          onClosed = () => resolve(null);
          startupWindow.once('closed', onClosed);
        });
        const result = await Promise.race([
          closed,
          dialog.showMessageBox(startupWindow, {
            type: 'error',
            title: 'Cannot load the workspace page',
            message: 'The workspace page did not load. Your saved data did not change.',
            buttons: ['Retry', 'Close'],
            defaultId: 0,
            cancelId: 1,
          }),
        ]).finally(() => startupWindow.removeListener('closed', onClosed));
        if (!result || window.isDestroyed()) return;
        if (result.response !== 0) {
          window.close();
          return;
        }
      }
    }
    if (window.isDestroyed()) return;
    window.show();
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
  } finally {
    initialized();
  }
});
