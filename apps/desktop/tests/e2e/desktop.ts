import { _electron as electron, test, type ElectronApplication } from '@playwright/test';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { desktopEnvironment } from '../desktop-environment';
import { captureConnectionEvidence, connectionEvidence } from '../connection-evidence';

export async function launch(
  data: string,
  developmentUrl = '',
  entryPoint?: string,
): Promise<ElectronApplication> {
  const info = test.info();
  const name = `electron-${randomUUID()}`;
  const app = await electron.launch({
    tracesDir: info.outputPath(`${name}-raw`),
    ...(process.env.INTERVIEW_DESKTOP_EXECUTABLE
      ? { executablePath: process.env.INTERVIEW_DESKTOP_EXECUTABLE }
      : {}),
    args: [
      ...(process.env.INTERVIEW_DESKTOP_EXECUTABLE ? [] : [entryPoint ?? resolve('.')]),
      ...(process.platform === 'linux' ? ['--ozone-platform=x11'] : []),
    ],
    env: desktopEnvironment(data, developmentUrl),
    timeout: 30_000,
  });
  const trace = app.context().tracing;
  try {
    await app.evaluate(captureConnectionEvidence, undefined);
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
        const evidence = await connectionEvidence(app).catch(() => undefined);
        if (evidence) {
          const path = info.outputPath(`${name}-connection.json`);
          await writeFile(path, JSON.stringify(evidence, null, 2));
          await info.attach(`${name}-connection`, {
            path,
            contentType: 'application/json',
          });
        }
      } catch {
        await info
          .attach(`${name}-connection-error`, {
            body: 'Connection artifact could not be saved.',
            contentType: 'text/plain',
          })
          .catch(() => {});
      }
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
