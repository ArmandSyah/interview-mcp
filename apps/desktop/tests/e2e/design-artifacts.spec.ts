import { expect, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';
import type { DesignScene } from '../../src/shared/design';

test('native design: local image paste, checkpoint restore, all export formats and a read-only checkpoint coach', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'interview-design-artifacts-'));
  let app = await launch(directory);
  let server: Server | undefined;
  const errors: string[] = [];
  const external: string[] = [];
  try {
    let page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (/^https?:/.test(request.url())) external.push(request.url());
    });
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'System design', exact: true }).click();
    await page
      .getByRole('button', { name: /Link Alias Service/ })
      .first()
      .click();
    const canvas = page.getByTestId('design-canvas');
    await expect(canvas.locator('.excalidraw')).toBeVisible();
    await page.getByRole('button', { name: '+ Service', exact: true }).click();
    await canvas.click({ position: { x: 160, y: 250 } });
    // Exercise Excalidraw's real clipboard import without touching the OS clipboard.
    const imageData = await canvas.evaluate((element) => {
      const image = document.createElement('canvas');
      image.width = image.height = 2;
      const context = image.getContext('2d')!;
      context.fillStyle = '#9347ff';
      context.fillRect(0, 0, 2, 2);
      const dataURL = image.toDataURL('image/png');
      const bytes = Uint8Array.from(atob(dataURL.split(',')[1]), (character) =>
        character.charCodeAt(0),
      );
      const clipboard = new DataTransfer();
      clipboard.items.add(new File([bytes], 'local-reference.png', { type: 'image/png' }));
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }),
      );
      return dataURL;
    });
    await expect
      .poll(async () => {
        const snapshot = await page.evaluate(() => window.interview.snapshot());
        const draft = await page.evaluate(
          (id) => window.interview.loadDesignDraft(id),
          snapshot.activeDesignSessionId!,
        );
        return draft.scene.elements.filter(
          (element) => element.type === 'image' && !element.isDeleted,
        ).length;
      })
      .toBe(1);
    const requirement =
      'Offline image evidence: owners can disable aliases without exposing another owner’s data.';
    await page.getByLabel('Requirements', { exact: true }).fill(requirement);
    await page.getByRole('button', { name: 'Checkpoint', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.interview.snapshot())).designSessions[0]
            .latestCheckpointId,
      )
      .toBeTruthy();
    const snapshot = await page.evaluate(() => window.interview.snapshot());
    const checkpointId = snapshot.designSessions[0].latestCheckpointId!;
    expect(checkpointId).toBeTruthy();
    const paths = {
      excalidraw: join(directory, 'export.excalidraw'),
      json: join(directory, 'export.json'),
      png: join(directory, 'export.png'),
    };
    await app.evaluate(({ dialog }, outputs) => {
      dialog.showSaveDialog = (async (...args: unknown[]) => {
        const options = args.at(-1) as { defaultPath: string };
        const extension = options.defaultPath.split('.').at(-1) as keyof typeof outputs;
        return { canceled: false, filePath: outputs[extension] };
      }) as typeof dialog.showSaveDialog;
    }, paths);
    // Export must flush notes immediately, without waiting for the autosave delay.
    const newerRequirement = requirement + ' Immediate export contains this new explanation.';
    await page.getByLabel('Requirements', { exact: true }).fill(newerRequirement);
    await page.getByLabel('Export design').selectOption('workspace');
    await expect
      .poll(async () => {
        try {
          return JSON.parse(await readFile(paths.json, 'utf8')).draft.notes.requirements;
        } catch {
          return '';
        }
      })
      .toBe(newerRequirement);
    await page.getByLabel('Export design').selectOption('excalidraw');
    await expect
      .poll(async () => {
        try {
          return JSON.parse(await readFile(paths.excalidraw, 'utf8')).type;
        } catch {
          return '';
        }
      })
      .toBe('excalidraw');
    const scene = JSON.parse(await readFile(paths.excalidraw, 'utf8')) as DesignScene;
    expect(Object.values(scene.files).map((file) => file.dataURL)).toContain(imageData);
    expect(scene.elements.some((element) => element.type === 'image' && !element.isDeleted)).toBe(
      true,
    );
    await page.getByLabel('Export design').selectOption('png');
    await expect
      .poll(async () => {
        try {
          return (await readFile(paths.png)).subarray(0, 8).toString('hex');
        } catch {
          return '';
        }
      })
      .toBe('89504e470d0a1a0a');
    const size = await app.evaluate(
      ({ nativeImage }, path) => nativeImage.createFromPath(path).getSize(),
      paths.png,
    );
    expect(size.width).toBeGreaterThan(20);
    expect(size.height).toBeGreaterThan(20);
    const exportedImagePixels = await page.evaluate(
      async (encoded) => {
        const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
        const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let matching = 0;
        for (let index = 0; index < pixels.length; index += 4)
          if (
            pixels[index] === 147 &&
            pixels[index + 1] === 71 &&
            pixels[index + 2] === 255 &&
            pixels[index + 3] === 255
          )
            matching++;
        image.close();
        return matching;
      },
      (await readFile(paths.png)).toString('base64'),
    );
    expect(exportedImagePixels).toBeGreaterThan(0);
    const sentinel = join(directory, 'cancelled.json');
    await writeFile(sentinel, 'existing export must survive cancellation');
    await app.evaluate(({ dialog }, path) => {
      process.env.INTERVIEW_TEST_EXPORT_CANCELLED = '0';
      dialog.showSaveDialog = (async () => {
        process.env.INTERVIEW_TEST_EXPORT_CANCELLED = '1';
        return { canceled: true, filePath: path };
      }) as typeof dialog.showSaveDialog;
    }, sentinel);
    await page.getByLabel('Export design').selectOption('workspace');
    await expect
      .poll(() => app.evaluate(() => process.env.INTERVIEW_TEST_EXPORT_CANCELLED))
      .toBe('1');
    expect(await readFile(sentinel, 'utf8')).toBe('existing export must survive cancellation');
    expect(external).toEqual([]);
    await page.getByTestId('main-menu-trigger').click();
    await page.getByTestId('clear-canvas-button').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect
      .poll(async () => {
        const state = await page.evaluate(() => window.interview.snapshot());
        const draft = await page.evaluate(
          (id) => window.interview.loadDesignDraft(id),
          state.activeDesignSessionId!,
        );
        return draft.scene.elements.filter((element) => !element.isDeleted).length;
      })
      .toBe(0);
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await page
      .locator('.design-history-item')
      .filter({ hasText: 'Checkpoint' })
      .getByRole('button', { name: 'Restore', exact: true })
      .click();
    await expect(page.getByLabel('Requirements', { exact: true })).toHaveValue(requirement);
    let requests = 0;
    let modelCheckpoint = '';
    server = createServer(async (request, response) => {
      try {
        let body = '';
        for await (const chunk of request) body += chunk;
        const payload = JSON.parse(body) as {
          messages: { role: string; content: string }[];
          tools: { function: { name: string } }[];
        };
        expect(body).not.toContain(imageData);
        expect(body).not.toContain('data:image/');
        expect(payload.tools.map((tool) => tool.function.name).sort()).toEqual([
          'evaluate_design',
          'get_design_brief',
          'get_design_hint',
          'get_design_snapshot',
        ]);
        response.setHeader('Content-Type', 'application/x-ndjson');
        if (++requests === 1) {
          const context = payload.messages.at(-1)!.content;
          expect(context).toContain(requirement);
          expect(context).toContain('"type":"image"');
          modelCheckpoint = /"id":"([^"]+)"/.exec(
            context.split('Immutable checkpoint evidence:')[1],
          )![1];
          response.end(
            JSON.stringify({
              message: {
                content: '',
                tool_calls: [
                  {
                    function: {
                      name: 'get_design_snapshot',
                      arguments: { session_id: 'forged', checkpoint_id: 'forged' },
                    },
                  },
                  { function: { name: 'finish_design_session', arguments: {} } },
                  { function: { name: 'get_design_hint', arguments: { depth: 1 } } },
                  { function: { name: 'get_design_hint', arguments: { depth: 2 } } },
                ],
              },
              done: true,
            }) + '\n',
          );
        } else {
          const replies = payload.messages.filter((message) => message.role === 'tool');
          expect(replies.some((message) => message.content.includes(modelCheckpoint))).toBe(true);
          expect(replies.some((message) => message.content.includes('not available'))).toBe(true);
          expect(replies.some((message) => message.content.includes('Only one hint'))).toBe(true);
          response.end(
            JSON.stringify({
              message: {
                content:
                  'What recovery guarantee do you promise when disabling an alias fails halfway?',
              },
              done: true,
            }) + '\n',
          );
        }
      } catch (error) {
        errors.push(`Model fixture: ${error instanceof Error ? error.message : String(error)}`);
        response.statusCode = 500;
        response.end('Model fixture assertion failed');
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture endpoint');
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    await page.getByLabel('Provider').selectOption('ollama');
    await page.getByLabel('Ollama URL').fill(`http://127.0.0.1:${address.port}`);
    await page.getByRole('button', { name: 'Save & connect', exact: true }).click();
    await page.getByRole('button', { name: 'coach', exact: true }).click();
    await page.getByLabel('Message the design coach').fill('Ask me about my first failure mode.');
    await page.getByRole('button', { name: 'Send design message', exact: true }).click();
    await expect(
      page.getByText(
        'What recovery guarantee do you promise when disabling an alias fails halfway?',
      ),
    ).toBeVisible();
    expect(requests).toBe(2);
    const after = await page.evaluate(() => window.interview.snapshot());
    expect(after.designSessions[0].status).toBe('in_progress');
    expect(after.designSessions[0].hintDepth).toBe(1);
    const draft = await page.evaluate(
      (id) => window.interview.loadDesignDraft(id),
      after.activeDesignSessionId!,
    );
    expect(draft.notes.requirements).toBe(requirement);
    expect(Object.values(draft.scene.files).map((file) => file.dataURL)).toContain(imageData);
    await page.screenshot({ path: 'test-results/workbench-design-artifacts.png', fullPage: true });
    expect(errors).toEqual([]);
    expect(external.every((url) => url === `http://127.0.0.1:${address.port}/api/chat`)).toBe(true);
    await app.close();
    app = await launch(directory);
    page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 design briefs')).toBeVisible({
      timeout: 20_000,
    });
    const reopened = await page.evaluate(async () => {
      const state = await window.interview.snapshot();
      return window.interview.loadDesignDraft(state.activeDesignSessionId!);
    });
    expect(Object.values(reopened.scene.files).map((file) => file.dataURL)).toContain(imageData);
    expect(
      reopened.scene.elements.some((element) => element.type === 'image' && !element.isDeleted),
    ).toBe(true);
  } finally {
    await app.close();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }
});
