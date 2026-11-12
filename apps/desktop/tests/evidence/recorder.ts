import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const beforeActionMs = 1000;
const resultHoldMs = 3000;
const captureIntervalMs = 250;

type Step = {
  title: string;
  expected: string;
  screenshot: string;
  startedMs: number;
  verifiedMs?: number;
  endedMs?: number;
  controls?: { role: string; name: string; enabled: boolean }[];
  status: 'running' | 'passed' | 'failed';
};
type Walkthrough = (
  step: (title: string, expected: string, actionAndCheck: () => Promise<void>) => Promise<void>,
) => Promise<void>;

/** Record actual UI actions. Assertions run before each result is held for reading. */
export async function recordJourney(
  page: Page,
  name: string,
  services: string,
  walkthrough: Walkthrough,
) {
  const info = test.info();
  const directory = info.outputPath(name);
  await mkdir(directory, { recursive: true });
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  execFileSync(ffmpeg, ['-version'], { stdio: 'ignore' });
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
  const errors: string[] = [];
  const onError = (error: Error) => errors.push(error.message);
  page.on('pageerror', onError);
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await page.evaluate(() => {
    const cursor = document.createElement('div');
    cursor.dataset.evidenceCursor = '';
    cursor.style.cssText =
      'position:fixed;z-index:2147483646;width:18px;height:18px;border:2px solid #9347ff;border-radius:50%;background:#ffffffb0;transform:translate(-50%,-50%);pointer-events:none;display:none';
    document.body.append(cursor);
    // Native dialogs occupy the top layer. Keep the pointer inside the active dialog.
    const observer = new MutationObserver(() => {
      const parent = [...document.querySelectorAll('dialog[open]')].at(-1) || document.body;
      if (cursor.parentElement !== parent) parent.append(cursor);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['open'],
    });
    const controller = new AbortController();
    document.addEventListener(
      'mousemove',
      (event) => {
        cursor.style.display = '';
        cursor.style.left = `${event.clientX}px`;
        cursor.style.top = `${event.clientY}px`;
      },
      { signal: controller.signal },
    );
    cursor.addEventListener(
      'evidence-cleanup',
      () => {
        controller.abort();
        observer.disconnect();
      },
      { once: true },
    );
  });
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);
  const frames: { file: string; startedMs: number }[] = [];
  const steps: Step[] = [];
  let running = true;
  let captureError: unknown;
  const recording = (async () => {
    try {
      while (running) {
        const startedMs = elapsed();
        const file = `frame-${String(frames.length).padStart(5, '0')}.png`;
        await page.screenshot({ path: join(directory, file) });
        frames.push({ file, startedMs });
        await delay(Math.max(0, captureIntervalMs - (elapsed() - startedMs)));
      }
    } catch (error) {
      captureError = error;
    }
  })();
  let failed = false;
  try {
    await walkthrough(async (title, expected, actionAndCheck) => {
      const entry: Step = {
        title,
        expected,
        screenshot: `step-${String(steps.length + 1).padStart(2, '0')}.png`,
        startedMs: elapsed(),
        status: 'running',
      };
      steps.push(entry);
      await test.step(title, async () => {
        try {
          await delay(beforeActionMs);
          await actionAndCheck();
          expect(errors, `${title}: no renderer exceptions`).toEqual([]);
          entry.verifiedMs = elapsed();
          entry.controls = await page
            .locator(
              'button, input, select, textarea, a[href], [role="button"], [role="tab"], [role="slider"]',
            )
            .evaluateAll((elements) =>
              elements
                .filter((element) => element.getClientRects().length > 0)
                .map((element) => {
                  const control = element as HTMLInputElement;
                  return {
                    role: element.getAttribute('role') || element.tagName.toLowerCase(),
                    // Record labels only. Input values and link destinations can contain secrets.
                    name: (
                      element.getAttribute('aria-label') ||
                      element.getAttribute('title') ||
                      control.labels?.[0]?.textContent ||
                      element.textContent ||
                      element.getAttribute('placeholder') ||
                      ''
                    )
                      .trim()
                      .slice(0, 160),
                    enabled: !control.disabled && element.getAttribute('aria-disabled') !== 'true',
                  };
                }),
            );
          await page.screenshot({
            path: join(directory, entry.screenshot),
            style: '[data-evidence-cursor] { visibility: hidden !important; }',
          });
          await info.attach(title, {
            path: join(directory, entry.screenshot),
            contentType: 'image/png',
          });
          await delay(resultHoldMs);
          entry.endedMs = elapsed();
          entry.status = 'passed';
        } catch (error) {
          entry.status = 'failed';
          throw error;
        }
      });
    });
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    running = false;
    await recording;
    const endedMs = elapsed();
    page.off('pageerror', onError);
    await page
      .evaluate(() => {
        const cursor = document.querySelector('[data-evidence-cursor]');
        cursor?.dispatchEvent(new Event('evidence-cleanup'));
        cursor?.remove();
      })
      .catch(() => {});
    const manifest = {
      version: 1,
      name,
      services,
      revision,
      dirty,
      capturedAt: new Date().toISOString(),
      beforeActionMs,
      resultHoldMs,
      durationMs: endedMs,
      status: 'failed',
      steps,
      frames,
    };
    try {
      if (!failed && captureError) throw captureError;
      if (!failed && frames.length) {
        // Use measured frame intervals. A slow screenshot must not speed up playback.
        const input =
          frames
            .map(
              (frame, index) =>
                `file '${frame.file}'\nduration ${((frames[index + 1]?.startedMs ?? endedMs) - frame.startedMs) / 1000}\n`,
            )
            .join('') + `file '${frames.at(-1)!.file}'\n`;
        await writeFile(join(directory, 'frames.txt'), input);
        // Put captions below the app image. Dialogs cannot hide them, and they cannot cover controls.
        const scaledHeight = Math.round((viewport.height * 1280) / viewport.width);
        const timestamp = (ms: number) => {
          const ticks = Math.floor(ms / 10);
          return `${Math.floor(ticks / 360000)}:${String(Math.floor(ticks / 6000) % 60).padStart(2, '0')}:${String(Math.floor(ticks / 100) % 60).padStart(2, '0')}.${String(ticks % 100).padStart(2, '0')}`;
        };
        const captionText = (value: string) => value.replace(/[\\{}\r\n]/g, ' ');
        const subtitles =
          `[Script Info]\nScriptType: v4.00+\nPlayResX: 1280\nPlayResY: ${scaledHeight + 88}\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,DejaVu Sans,19,&H00FFFFFF,&H00FFFFFF,&H00121419,&H00121419,0,0,0,0,100,100,0,0,1,0,0,2,20,20,16,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` +
          steps
            .map(
              (step, index) =>
                `Dialogue: 0,${timestamp(step.startedMs)},${timestamp(steps[index + 1]?.startedMs ?? endedMs)},Default,,0,0,0,,${index + 1}. ${captionText(step.title)}\\N{\\fs14}${captionText(services)}`,
            )
            .join('\n') +
          '\n';
        await writeFile(join(directory, 'captions.ass'), subtitles);
        execFileSync(
          ffmpeg,
          [
            '-nostdin',
            '-hide_banner',
            '-loglevel',
            'error',
            '-y',
            '-f',
            'concat',
            '-safe',
            '0',
            '-i',
            join(directory, 'frames.txt'),
            '-filter_complex',
            `fps=4,scale=1280:${scaledHeight}:flags=lanczos,pad=iw:ih+88:0:0:color=0x121419,subtitles=captions.ass,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3`,
            '-loop',
            '0',
            join(directory, `${name}.gif`),
          ],
          { cwd: directory, timeout: 120_000, stdio: 'pipe' },
        );
        await info.attach(`${name} slow walkthrough`, {
          path: join(directory, `${name}.gif`),
          contentType: 'image/gif',
        });
        manifest.status = 'passed';
      }
    } finally {
      await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
      await info.attach(`${name} manifest`, {
        path: join(directory, 'manifest.json'),
        contentType: 'application/json',
      });
    }
  }
}
