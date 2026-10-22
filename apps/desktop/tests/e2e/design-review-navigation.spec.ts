import { expect, test, type Page } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';

async function evidence(page: Page) {
  return page.evaluate(async () => {
    const snapshot = await window.interview.snapshot();
    const session = snapshot.designSessions.find(
      (item) => item.id === snapshot.activeDesignSessionId,
    )!;
    return { session, draft: await window.interview.loadDesignDraft(session.id) };
  });
}

for (const transition of ['mode change', 'restart'] as const) {
  test(`an unchanged design review stays valid after ${transition}`, async () => {
    const data = await mkdtemp(join(tmpdir(), 'interview-design-review-navigation-'));
    let app = await launch(data);
    try {
      let page = await app.firstWindow();
      await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
      await page.getByRole('button', { name: 'System design', exact: true }).click();
      await page
        .getByRole('button', { name: /Link Alias Service/ })
        .first()
        .click();
      await expect(page.getByTestId('design-canvas').locator('.excalidraw')).toBeVisible();
      await page.getByRole('button', { name: '+ Database', exact: true }).click();
      await page
        .getByRole('textbox', { name: 'Requirements', exact: true })
        .fill('Owner access is necessary.');
      await page.getByRole('button', { name: 'Review', exact: true }).click();
      const finish = () => page.getByRole('button', { name: 'Finish practice', exact: true });
      await expect(finish()).toBeEnabled();
      const reviewed = await evidence(page);
      expect(reviewed.draft.scene.elements).toHaveLength(2);
      expect(reviewed.session.draftDigest).toBe(reviewed.session.review!.scene_digest);

      if (transition === 'mode change') {
        await page.getByRole('button', { name: 'Coding', exact: true }).click();
        await page.getByRole('button', { name: 'System design', exact: true }).click();
      } else {
        await app.close();
        app = await launch(data);
        page = await app.firstWindow();
        await expect(page.getByText('MCP connected · 5 design briefs')).toBeVisible({
          timeout: 20_000,
        });
      }
      await expect(page.getByTestId('design-canvas').locator('.excalidraw')).toBeVisible();
      await page.getByRole('button', { name: 'review', exact: true }).click();
      // Opening history flushes the loaded canvas before these comparisons.
      await page.getByRole('button', { name: 'History', exact: true }).click();
      await page
        .getByRole('dialog', { name: 'Design checkpoint history' })
        .getByRole('button', { name: 'Close history' })
        .click();
      const restored = await evidence(page);
      expect
        .soft(restored.draft.scene.elements, `${transition}: unchanged canvas elements`)
        .toEqual(reviewed.draft.scene.elements);
      expect
        .soft(restored.session.review, `${transition}: immutable review`)
        .toEqual(reviewed.session.review);
      expect
        .soft(restored.session.draftDigest, `${transition}: unchanged evidence digest`)
        .toBe(reviewed.session.draftDigest);
      await expect
        .soft(page.getByText('Older checkpoint—review again after your edits.'))
        .toHaveCount(0);
      await expect.soft(finish()).toBeEnabled();
      await page.screenshot({
        path: `test-results/design-review-${transition.replaceAll(' ', '-')}.png`,
        fullPage: true,
      });

      // A real diagram edit must continue to invalidate the review.
      await page.getByRole('button', { name: '+ Cache', exact: true }).click();
      await expect(page.getByText('Older checkpoint—review again after your edits.')).toBeVisible();
      await expect(finish()).toBeDisabled();
      await page.getByRole('button', { name: 'Review checkpoint', exact: true }).click();
      await expect(finish()).toBeEnabled();
      await finish().click();
      await expect(
        page.getByRole('button', { name: 'Session finished', exact: true }),
      ).toBeDisabled();
    } finally {
      await app.close().catch(() => {});
    }
  });
}
