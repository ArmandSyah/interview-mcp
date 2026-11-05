import { expect, test } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';

for (const panel of ['coach', 'results'] as const) {
  for (const ending of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur'] as const) {
    test(`${panel} resize stops after ${ending}`, async () => {
      const app = await launch(await mkdtemp(join(tmpdir(), 'interview-panel-resize-')));
      try {
        const page = await app.firstWindow();
        await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
        const separator = page.getByRole('separator', { name: `Resize ${panel} panel` });
        const area = page.locator(`.${panel === 'coach' ? 'coach' : 'results'}-panel`);
        const dimension = async () => {
          const bounds = await area.boundingBox();
          if (!bounds) throw new Error(`${panel} panel is not visible`);
          return panel === 'coach' ? bounds.width : bounds.height;
        };
        const before = await dimension();
        await separator.evaluate((element) => {
          element.addEventListener(
            'pointerdown',
            (event) => {
              (element as HTMLElement).dataset.pointer = String((event as PointerEvent).pointerId);
            },
            { once: true },
          );
        });
        const bounds = await separator.boundingBox();
        if (!bounds) throw new Error(`${panel} separator is not visible`);
        const x = bounds.x + bounds.width / 2;
        const y = bounds.y + bounds.height / 2;
        await page.mouse.move(x, y);
        await page.mouse.down();
        if (ending === 'pointerup') {
          await separator.evaluate((element) => {
            const pointerId = Number((element as HTMLElement).dataset.pointer) + 1;
            for (const type of ['pointermove', 'pointerup', 'pointercancel'])
              element.dispatchEvent(
                new PointerEvent(type, { bubbles: true, pointerId, clientX: 0, clientY: 0 }),
              );
          });
          expect(await dimension(), 'A different pointer must not move or cancel this drag').toBe(
            before,
          );
        }
        await page.mouse.move(x - (panel === 'coach' ? 40 : 0), y - (panel === 'results' ? 40 : 0));
        await expect.poll(dimension).toBeGreaterThan(before);
        const resized = await dimension();
        if (ending === 'pointerup') await page.mouse.up();
        else
          await separator.evaluate((element, ending) => {
            const pointerId = Number((element as HTMLElement).dataset.pointer);
            if (ending === 'lostpointercapture') element.releasePointerCapture(pointerId);
            else if (ending === 'blur') window.dispatchEvent(new Event('blur'));
            else
              element.dispatchEvent(
                new PointerEvent('pointercancel', { bubbles: true, pointerId }),
              );
          }, ending);
        await page.mouse.move(x + 100, y + 100);
        await expect
          .poll(dimension, {
            message: `${panel}: ${ending} must stop changes from later pointer movement`,
          })
          .toBe(resized);
        await page.mouse.up();
        // A cancelled drag must not prevent the next drag.
        const next = await separator.boundingBox();
        if (!next) throw new Error(`${panel} separator disappeared`);
        await page.mouse.move(next.x + next.width / 2, next.y + next.height / 2);
        await page.mouse.down();
        await page.mouse.move(next.x + next.width / 2 + 20, next.y + next.height / 2 + 20);
        await page.mouse.up();
        await expect.poll(dimension).toBeLessThan(resized);
      } finally {
        await app.close();
      }
    });
  }

  test(`${panel} resize stays within its size limits`, async () => {
    const app = await launch(await mkdtemp(join(tmpdir(), 'interview-panel-bounds-')));
    try {
      const page = await app.firstWindow();
      await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
      const separator = page.getByRole('separator', { name: `Resize ${panel} panel` });
      const area = page.locator(`.${panel}-panel`);
      const dimension = async () => {
        const bounds = await area.boundingBox();
        if (!bounds) throw new Error(`${panel} panel is not visible`);
        return panel === 'coach' ? bounds.width : bounds.height;
      };
      const bounds = await separator.boundingBox();
      if (!bounds) throw new Error(`${panel} separator is not visible`);
      const x = bounds.x + bounds.width / 2;
      const y = bounds.y + bounds.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x - 2000, y - 2000);
      const maximum = await dimension();
      expect(maximum).toBeGreaterThan(panel === 'coach' ? 280 : 130);
      expect(maximum).toBeLessThanOrEqual(panel === 'coach' ? 540 : 450);
      await page.mouse.move(x - 4000, y - 4000);
      await expect.poll(dimension).toBe(maximum);
      await page.mouse.move(x + 2000, y + 2000);
      await expect.poll(dimension).toBe(panel === 'coach' ? 280 : 130);
      await page.mouse.up();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    } finally {
      await app.close();
    }
  });
}
