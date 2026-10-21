import { _electron as electron, test, type ElectronApplication } from '@playwright/test';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { desktopEnvironment } from '../desktop-environment';

export async function launch(data: string, developmentUrl = ''): Promise<ElectronApplication> {
  const info = test.info();
  const name = `electron-${randomUUID()}`;
  const app = await electron.launch({
    tracesDir: info.outputPath(`${name}-raw`),
    ...(process.env.INTERVIEW_DESKTOP_EXECUTABLE
      ? { executablePath: process.env.INTERVIEW_DESKTOP_EXECUTABLE }
      : {}),
    args: [
      ...(process.env.INTERVIEW_DESKTOP_EXECUTABLE ? [] : [resolve('.')]),
      ...(process.platform === 'linux' ? ['--ozone-platform=x11'] : []),
    ],
    env: desktopEnvironment(data, developmentUrl),
    timeout: 30_000,
  });
  const trace = app.context().tracing;
  try {
    await (await app.firstWindow()).waitForLoadState('domcontentloaded');
    await trace.start({
      name: 'context',
      live: true,
      screenshots: true,
      snapshots: true,
      sources: true,
    });
  } catch (error) {
    await app.close().catch(() => {});
    throw error;
  }
  const originalClose = app.close.bind(app);
  let closing: Promise<void> | undefined;
  app.close = () => {
    closing ??= (async () => {
      try {
        const path = info.outputPath(`${name}.zip`);
        await trace.stop({ path });
        await info.attach(name, { path, contentType: 'application/zip' });
      } catch (error) {
        // Native window-close tests can end Electron before this helper runs.
        await info
          .attach(`${name}-trace-error`, {
            body: error instanceof Error ? error.message : String(error),
            contentType: 'text/plain',
          })
          .catch(() => {});
      } finally {
        await originalClose();
      }
    })();
    return closing;
  };
  return app;
}
