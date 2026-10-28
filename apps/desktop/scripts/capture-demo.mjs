import { _electron as electron, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Capture actual UI actions with a disposable workspace and a scripted model.
// The MCP engine, permission checks, autosave, and reviews are not mocked.
const root = resolve('../..');
const destination = resolve(root, 'docs/media');
const framesPerSecond = 6;
const force = process.argv.includes('--force');
if (process.argv.some((argument, index) => index > 1 && argument !== '--force'))
  throw new Error('Usage: npm run demo [-- --force]');
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const encoder = spawnSync(ffmpeg, ['-version'], { encoding: 'utf8' });
if (encoder.error || encoder.status !== 0)
  throw new Error('Install FFmpeg or set FFMPEG_PATH to its executable.');
const names = [
  'agent-workflow.gif',
  'offline-design.gif',
  'coding-workbench.png',
  'design-workbench.png',
  'practice-queue.png',
  'capture-manifest.json',
];
await mkdir(destination, { recursive: true });
if (!force)
  for (const name of names) {
    try {
      await access(join(destination, name));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    throw new Error(`Refusing to replace ${name}. Use --force to regenerate the demo assets.`);
  }
const temporary = await mkdtemp(join(tmpdir(), 'interview-readme-demo-'));
const output = join(temporary, 'assets');
await mkdir(output);
const errors = [];
const externalRequests = [];
let requests = 0;
let toolResults = 0;
const question = 'What should I establish before I write the merge loop?';
const answer =
  'What does the active cluster represent after each hold? State that invariant before you write the loop.';
const draftCode =
  '# My next step: state the invariant before writing the loop.\n' +
  'def merge_delivery_holds(holds: list[list[int]], grace_days: int) -> list[list[int]]:\n' +
  '    pass\n';
const fixture = createServer(async (request, response) => {
  try {
    if (request.method !== 'POST' || request.url !== '/api/chat')
      throw new Error('Unexpected model fixture request');
    let body = '';
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 1_000_000) throw new Error('Model fixture request is too large');
    }
    const payload = JSON.parse(body);
    expect(payload.tools.some((tool) => tool.function.name === 'get_hint')).toBe(true);
    response.setHeader('Content-Type', 'application/x-ndjson');
    if (++requests === 1) {
      expect(payload.messages.at(-1).content).toContain(draftCode);
      await delay(600);
      response.end(
        JSON.stringify({
          message: {
            content: '',
            tool_calls: [
              {
                function: {
                  name: 'get_hint',
                  arguments: {
                    attempt_id: 'model-cannot-select-another-attempt',
                    current_code: 'model-cannot-replace-the-draft',
                    depth: 1,
                  },
                },
              },
            ],
          },
          done: true,
        }) + '\n',
      );
    } else if (requests === 2) {
      const result = payload.messages.find((message) => message.role === 'tool');
      expect(result?.content).toContain('Nearby holds');
      toolResults++;
      // Keep the real tool result visible before streaming the fixture response.
      await delay(4500);
      for (const token of answer.match(/\S+\s*/g)) {
        response.write(JSON.stringify({ message: { content: token }, done: false }) + '\n');
        await delay(75);
      }
      response.end(JSON.stringify({ message: { content: '' }, done: true }) + '\n');
    } else throw new Error('Unexpected additional model turn');
  } catch (error) {
    errors.push(error.message);
    response.statusCode = 500;
    response.end('Model fixture failed');
  }
});
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}`;
let app;
let activeRecording;
const recordings = [];

async function record(page, name, actions) {
  const directory = join(temporary, name);
  await mkdir(directory);
  let running = true;
  let count = 0;
  let failure;
  const steps = [];
  const note =
    name === 'agent-workflow'
      ? 'Scripted model. Real MCP tools.'
      : 'AI off. Real canvas and checkpoints.';
  await page.evaluate((note) => {
    const caption = document.createElement('div');
    caption.dataset.demoCaption = '';
    caption.style.cssText =
      'position:fixed;bottom:42px;left:50%;transform:translateX(-50%);z-index:2147483647;max-width:700px;padding:13px 24px;border:1px solid #bea4ef;border-radius:10px;background:#121419f2;color:#f6f2ff;font:600 19px/1.5 system-ui,sans-serif;text-align:center;pointer-events:none;box-shadow:0 4px 18px #0008';
    const title = document.createElement('div');
    title.dataset.demoStep = '';
    caption.append(title);
    const detail = document.createElement('div');
    detail.textContent = note;
    detail.style.cssText = 'font-size:13px;font-weight:400;color:#bea4ef';
    caption.append(detail);
    document.body.append(caption);
    const cursor = document.createElement('div');
    cursor.dataset.demoCursor = '';
    cursor.style.cssText =
      'position:fixed;z-index:2147483646;width:18px;height:18px;border:2px solid #9347ff;border-radius:50%;background:#ffffffb0;transform:translate(-50%,-50%);pointer-events:none;display:none';
    document.body.append(cursor);
    const move = (event) => {
      cursor.style.display = '';
      cursor.style.left = event.clientX + 'px';
      cursor.style.top = event.clientY + 'px';
    };
    document.addEventListener('mousemove', move);
    window.__removeDemoAnnotations = () => {
      document.removeEventListener('mousemove', move);
      caption.remove();
      cursor.remove();
      delete window.__removeDemoAnnotations;
    };
  }, note);
  const caption = async (text) => {
    steps.push({ caption: text, start_frame: count });
    await page.evaluate((text) => {
      document.querySelector('[data-demo-step]').textContent = text;
    }, text);
  };
  const recording = (async () => {
    try {
      while (running) {
        const started = performance.now();
        await page.screenshot({
          path: join(directory, `frame-${String(count++).padStart(4, '0')}.png`),
        });
        await delay(Math.max(0, 1000 / framesPerSecond - (performance.now() - started)));
      }
    } catch (error) {
      failure = error;
    }
  })();
  activeRecording = async () => {
    running = false;
    await recording;
  };
  try {
    await actions(caption);
  } finally {
    await activeRecording();
    activeRecording = undefined;
    await page.evaluate(() => window.__removeDemoAnnotations?.());
  }
  if (failure) throw failure;
  const result = spawnSync(
    ffmpeg,
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-framerate',
      String(framesPerSecond),
      '-i',
      join(directory, 'frame-%04d.png'),
      '-filter_complex',
      'scale=1280:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3',
      '-loop',
      '0',
      join(output, name + '.gif'),
    ],
    { encoding: 'utf8', timeout: 90_000 },
  );
  if (result.error || result.status !== 0)
    throw new Error(result.stderr || 'GIF conversion failed');
  recordings.push({
    file: name + '.gif',
    frames: count,
    frames_per_second: framesPerSecond,
    duration_seconds: Number((count / framesPerSecond).toFixed(1)),
    steps,
  });
}

try {
  app = await electron.launch({
    args: [resolve('.'), ...(process.platform === 'linux' ? ['--ozone-platform=x11'] : [])],
    env: {
      ...process.env,
      INTERVIEW_DESKTOP_DATA_DIR: join(temporary, 'workspace'),
      INTERVIEW_DESKTOP_PROBLEMS_DIR: join(root, 'problems/examples'),
      INTERVIEW_DESKTOP_DEV_URL: '',
    },
    timeout: 30_000,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (/^https?:/.test(request.url()) && !request.url().startsWith(fixtureUrl + '/'))
      externalRequests.push(request.url());
  });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 900),
  );
  await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
  expect((await page.evaluate(() => window.interview.snapshot())).settings.provider).toBe(
    'disabled',
  );
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await page.getByLabel('Provider').selectOption('ollama');
  await page.getByLabel('Ollama URL').fill(fixtureUrl);
  await page.getByRole('button', { name: 'Save & connect', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await record(page, 'agent-workflow', async (caption) => {
    await caption('1. Open a coding problem');
    await delay(1800);
    await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
    await expect(page.getByTestId('code-editor')).toBeVisible();
    await delay(2500);
    await caption('2. Save your own draft');
    await delay(800);
    const editor = page.locator('.monaco-editor textarea');
    await editor.focus();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
    await editor.evaluate((element, content) => {
      const data = new DataTransfer();
      data.setData('text/plain', content);
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, draftCode);
    await delay(3500);
    await caption('3. Ask one focused question');
    await delay(1000);
    await page.getByLabel('Message the coach').pressSequentially(question, { delay: 90 });
    await delay(1500);
    await caption('4. Send the saved draft to the coach');
    await delay(1000);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(() => requests).toBe(2);
    await caption('5. Inspect the real MCP hint result');
    await page.getByText('get_hint', { exact: true }).click();
    await delay(3500);
    await page.getByText('get_hint', { exact: true }).click();
    await caption('6. Read the next question. Your draft stays unchanged.');
    await expect(page.getByText(answer, { exact: true })).toBeVisible();
    const snapshot = await page.evaluate(() => window.interview.snapshot());
    expect(snapshot.sessions[0].code).toBe(draftCode);
    expect(snapshot.sessions[0].hintDepth).toBe(1);
    expect(
      snapshot.sessions[0].chat.some((item) => item.tool === 'get_hint' && item.status === 'done'),
    ).toBe(true);
    await delay(6500);
  });
  await page.screenshot({ path: join(output, 'coding-workbench.png') });
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await page.getByLabel('Provider').selectOption('disabled');
  await page.getByRole('button', { name: 'Save & connect', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await page.evaluate(() => window.interview.snapshot())).settings.provider).toBe(
    'disabled',
  );
  await record(page, 'offline-design', async (caption) => {
    await caption('1. Open a system-design brief');
    await delay(1500);
    await page.getByRole('button', { name: 'System design', exact: true }).click();
    await delay(1200);
    await page
      .getByRole('button', { name: /Link Alias Service/ })
      .first()
      .click();
    await expect(page.locator('.excalidraw')).toBeVisible();
    await delay(1800);
    await caption('2. Add components to the canvas');
    await delay(600);
    for (const component of ['Client', 'Service', 'Database', 'Cache']) {
      await page.getByRole('button', { name: `+ ${component}`, exact: true }).click();
      await delay(1200);
    }
    await expect
      .poll(async () => {
        const state = await page.evaluate(() => window.interview.snapshot());
        const draft = await page.evaluate(
          (id) => window.interview.loadDesignDraft(id),
          state.activeDesignSessionId,
        );
        return draft.scene.elements.filter((element) => !element.isDeleted).length;
      })
      .toBe(8);
    await caption('3. Draw connections with the arrow tool');
    await delay(600);
    // Draw real edges with the canvas tool. Do not inject a prebuilt scene.
    const state = await page.evaluate(() => window.interview.snapshot());
    const canvasDraft = await page.evaluate(
      (id) => window.interview.loadDesignDraft(id),
      state.activeDesignSessionId,
    );
    const canvas = page.getByTestId('design-canvas');
    const bounds = await canvas.boundingBox();
    const zoom = canvasDraft.scene.appState.zoom?.value ?? 1;
    const point = (x, y) => ({
      x: bounds.x + (x + (canvasDraft.scene.appState.scrollX ?? 0)) * zoom,
      y: bounds.y + (y + (canvasDraft.scene.appState.scrollY ?? 0)) * zoom,
    });
    const nodes = canvasDraft.scene.elements.filter((element) => element.type !== 'text');
    await canvas.click({ position: { x: bounds.width - 80, y: bounds.height - 130 } });
    for (let index = 0; index < 2; index++) {
      const from = nodes[index];
      const to = nodes[index + 1];
      const start = point(from.x + from.width, from.y + from.height / 2);
      const end = point(to.x, to.y + to.height / 2);
      await page.keyboard.press('a');
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      for (let step = 1; step <= 8; step++) {
        await page.mouse.move(
          start.x + ((end.x - start.x) * step) / 8,
          start.y + ((end.y - start.y) * step) / 8,
        );
        await delay(100);
      }
      await page.mouse.up();
      await page.keyboard.press('Escape');
      await delay(1100);
    }
    // Deselect the edge so its style panel does not cover the diagram.
    await canvas.click({ position: { x: bounds.width - 80, y: bounds.height - 130 } });
    await delay(300);
    await expect
      .poll(async () => {
        const draft = await page.evaluate(
          (id) => window.interview.loadDesignDraft(id),
          state.activeDesignSessionId,
        );
        return draft.scene.elements.filter(
          (element) => element.type === 'arrow' && !element.isDeleted,
        ).length;
      })
      .toBe(2);
    await caption('4. Record a design requirement');
    await delay(600);
    const requirement =
      "Define when a disabled alias stops redirecting. Keep each owner's aliases separate.";
    await page
      .getByLabel('Requirements', { exact: true })
      .pressSequentially(requirement, { delay: 40 });
    await delay(1800);
    await caption('5. Explain a tradeoff');
    await delay(600);
    await page
      .getByLabel('Decisions & tradeoffs', { exact: true })
      .fill('Compare cached reads with the visibility guarantee before choosing a cache policy.');
    await delay(1800);
    await caption('6. Save an immutable checkpoint');
    await delay(600);
    await page.getByRole('button', { name: 'Checkpoint', exact: true }).click();
    await delay(600);
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Design checkpoint history' })).toBeVisible();
    await delay(2300);
    await page.getByRole('button', { name: 'Close history', exact: true }).click();
    await caption('7. Review discussion coverage, not correctness');
    await delay(600);
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Discussion coverage', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Finish practice', exact: true })).toBeEnabled();
    await expect(page.getByText('Older checkpoint—review again after your edits.')).toHaveCount(0);
    await delay(5500);
  });
  await page.screenshot({ path: join(output, 'design-workbench.png') });
  await page.getByRole('button', { name: 'Practice queue', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Practice queue', exact: true });
  const snapshot = await page.evaluate(() => window.interview.snapshot());
  await dialog
    .getByLabel('Practice to revisit')
    .selectOption(`design:${snapshot.activeDesignSessionId}`);
  await dialog.getByLabel('Reminder delay (days)').fill('0');
  await dialog.getByRole('button', { name: 'Add to queue', exact: true }).click();
  await dialog.getByRole('button', { name: 'Recall & reflect', exact: true }).click();
  await dialog
    .getByLabel('Your recall answer')
    .fill(
      'I must explain the contract before I choose a cache. I still need to compare failure behavior.',
    );
  await dialog
    .getByLabel('What needed help or surprised you?')
    .fill('Separating availability from the disable guarantee.');
  await dialog
    .getByLabel('Next independent step')
    .fill('Trace a stale redirect after an owner disables an alias.');
  await page.screenshot({ path: join(output, 'practice-queue.png') });
  expect(errors).toEqual([]);
  expect(externalRequests).toEqual([]);
  expect(toolResults).toBe(1);
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  await writeFile(
    join(output, 'capture-manifest.json'),
    JSON.stringify(
      {
        captured_at: new Date().toISOString(),
        app_version: pkg.version,
        source: 'Actual Electron UI with the Python MCP engine over stdio',
        model: 'Deterministic loopback Ollama wire-format fixture; no live model inference',
        workspace: 'Disposable workspace with public examples and scripted sample drafts only',
        annotations:
          'Step captions and a pointer added only for the recording; screenshots show the unmodified app UI',
        recordings,
        screenshots: names.filter((name) => name.endsWith('.png')),
        assertions: {
          default_ai_disabled: true,
          real_mcp_hint_completed: true,
          saved_draft_unchanged_by_model: true,
          model_requests: requests,
          tool_results: toolResults,
          offline_design_ai_disabled: true,
          unexpected_network_requests: externalRequests.length,
          renderer_errors: errors.length,
        },
      },
      null,
      2,
    ) + '\n',
  );
  // Failed capture checks leave the previous public assets untouched.
  for (const name of names)
    await copyFile(
      join(output, name),
      join(destination, name),
      force ? 0 : constants.COPYFILE_EXCL,
    );
  console.log(`Captured verified demo assets in ${destination}`);
} finally {
  await activeRecording?.();
  await app?.close();
  await new Promise((resolve) => fixture.close(resolve));
}
