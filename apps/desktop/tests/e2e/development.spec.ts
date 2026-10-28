import { expect, test, type ElectronApplication } from '@playwright/test';
import { createServer } from 'vite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';

test('development server: coding, local whiteboard fonts, and saved design notes', async () => {
  test.skip(!!process.env.INTERVIEW_DESKTOP_EXECUTABLE, 'Development uses the source app');
  const errors: string[] = [];
  const external: string[] = [];
  const server = await createServer({
    server: { port: 0, strictPort: false },
    clearScreen: false,
    customLogger: {
      info: () => {},
      warn: (message) => errors.push(message),
      warnOnce: (message) => errors.push(message),
      error: (message) => {
        errors.push(message);
        console.error('Development server error:', message);
      },
      clearScreen: () => {},
      hasErrorLogged: () => false,
      hasWarned: false,
    },
  });
  let app: ElectronApplication | undefined;
  try {
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw new Error('Missing Vite test port');
    const url = `http://127.0.0.1:${address.port}`;
    app = await launch(await mkdtemp(join(tmpdir(), 'interview-dev-e2e-')), url);
    const page = await app.firstWindow();
    page.on('pageerror', (error) => {
      errors.push(error.message);
      console.error('Development renderer error:', error.message);
    });
    page.on('console', (message) => {
      if (message.type() === 'error') {
        errors.push(message.text());
        console.error('Development console:', message.text());
      }
    });
    page.on('request', (request) => {
      if (/^https?:/.test(request.url()) && !request.url().startsWith(url + '/'))
        external.push(request.url());
    });
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
    await expect(page.getByTestId('code-editor')).toBeVisible();
    await page.getByRole('button', { name: 'System design', exact: true }).click();
    await page
      .getByRole('button', { name: /Link Alias Service/ })
      .first()
      .click();
    await expect(page.getByTestId('design-canvas').locator('.excalidraw')).toBeVisible();
    await page.getByRole('button', { name: '+ Client', exact: true }).click();
    await page
      .getByLabel('Requirements', { exact: true })
      .fill('Development draft must stay local.');
    await page.getByRole('button', { name: 'Checkpoint', exact: true }).click();
    await expect
      .poll(async () => {
        const snapshot = await page.evaluate(() => window.interview.snapshot());
        const draft = await page.evaluate(
          (id) => window.interview.loadDesignDraft(id),
          snapshot.activeDesignSessionId!,
        );
        return draft.notes.requirements;
      })
      .toBe('Development draft must stay local.');
    const fonts = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts]
        .filter((font) => font.status === 'loaded')
        .map((font) => font.family);
    });
    expect(fonts.some((font) => /Excalifont|Virgil/.test(font))).toBe(true);
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  } finally {
    const timer = setTimeout(() => app?.process().kill('SIGKILL'), 5000);
    try {
      await app?.close();
    } finally {
      clearTimeout(timer);
    }
    await server.close();
  }
});
