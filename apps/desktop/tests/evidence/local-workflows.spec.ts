import { expect, test } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from '../e2e/desktop';
import { recordJourney } from './recorder';

test('coding navigation, a saved draft, and a real curated hint', async () => {
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-visual-coding-')));
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await recordJourney(
      page,
      'coding-navigation',
      'AI off. Real local MCP and saved data.',
      async (step) => {
        await step(
          'Inspect the empty workspace',
          'AI is off and the welcome view is visible.',
          async () => {
            await expect(page.getByRole('heading', { name: /Your next interview/ })).toBeVisible();
            expect((await page.evaluate(() => window.interview.snapshot())).settings.provider).toBe(
              'disabled',
            );
          },
        );
        await step(
          'Search for a missing problem',
          'The empty search result is explicit.',
          async () => {
            await page
              .getByLabel('Search problems')
              .pressSequentially('no-such-problem', { delay: 70 });
            await expect(page.getByText('No matching problems.')).toBeVisible();
          },
        );
        await step(
          'Clear the search and select medium problems',
          'The medium filter is selected.',
          async () => {
            await page.getByLabel('Search problems').fill('');
            await page.getByRole('button', { name: 'medium', exact: true }).click();
            await expect(page.getByRole('button', { name: 'medium', exact: true })).toHaveAttribute(
              'aria-pressed',
              'true',
            );
          },
        );
        await step(
          'Open Delivery Hold Clusters',
          'The problem opens in the code editor.',
          async () => {
            await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
            await expect(page.getByTestId('code-editor')).toBeVisible();
          },
        );
        await step(
          'Read the problem statement',
          'The problem tab shows the statement.',
          async () => {
            await page.getByRole('button', { name: 'problem.md', exact: true }).click();
            await expect(page.locator('.problem-description')).toBeVisible();
          },
        );
        await step(
          'Write a draft note',
          'The local backend saves the exact typed note.',
          async () => {
            await page.getByRole('button', { name: 'solution.py', exact: true }).click();
            const editor = page.locator('.monaco-editor textarea');
            await editor.focus();
            await page.keyboard.press('Control+Home');
            await page.keyboard.type('# Visual audit: explain the invariant before coding.\n', {
              delay: 40,
            });
            await expect
              .poll(
                async () =>
                  (await page.evaluate(() => window.interview.snapshot())).sessions[0].code,
              )
              .toContain('# Visual audit: explain the invariant before coding.');
          },
        );
        await step(
          'Request one curated hint',
          'The real MCP returns a first-level hint.',
          async () => {
            await page.getByRole('button', { name: 'Hint', exact: true }).click();
            await expect
              .poll(
                async () =>
                  (await page.evaluate(() => window.interview.snapshot())).sessions[0].hintDepth,
              )
              .toBe(1);
            await expect(page.locator('.chat-message.assistant').last()).toBeVisible();
          },
        );
        await step(
          'Open the saved files',
          'The file explorer shows the active attempt.',
          async () => {
            await page.getByRole('button', { name: 'Files explorer' }).click();
            await expect(page.locator('.file-tree')).toContainText('Delivery Hold Clusters');
            await expect(page.locator('.file-tree')).toContainText('solution.py');
          },
        );
        await step(
          'Inspect practice progress',
          'Progress is visible without changing the draft.',
          async () => {
            await page.getByRole('button', { name: 'Show progress' }).click();
            await expect(page.getByRole('button', { name: 'PROGRESS', exact: true })).toHaveClass(
              /active/,
            );
            expect(
              (await page.evaluate(() => window.interview.snapshot())).sessions[0].code,
            ).toContain('# Visual audit:');
          },
        );
      },
    );
  } finally {
    await app.close();
  }
});

test('design components, notes, timer, checkpoint, and review', async () => {
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-visual-design-')));
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
    await recordJourney(
      page,
      'design-review',
      'AI off. Real canvas, MCP checkpoints, and review.',
      async (step) => {
        await step('Switch to system design', 'The design catalog is visible.', async () => {
          await page.getByRole('button', { name: 'System design', exact: true }).click();
          await expect(
            page.getByRole('button', { name: /Link Alias Service/ }).first(),
          ).toBeVisible();
        });
        await step('Open a design brief', 'The editable whiteboard is visible.', async () => {
          await page
            .getByRole('button', { name: /Link Alias Service/ })
            .first()
            .click();
          await expect(page.locator('canvas.excalidraw__canvas.interactive')).toBeVisible();
        });
        for (const component of ['Client', 'Service', 'Database']) {
          await step(
            `Add a ${component.toLowerCase()}`,
            'The component and label are saved to the real canvas.',
            async () => {
              await page.getByRole('button', { name: `+ ${component}`, exact: true }).click();
              await expect
                .poll(async () =>
                  page.evaluate(async () => {
                    const state = await window.interview.snapshot();
                    const draft = await window.interview.loadDesignDraft(
                      state.activeDesignSessionId!,
                    );
                    return draft.scene.elements.filter((element) => !element.isDeleted).length;
                  }),
                )
                .toBe((['Client', 'Service', 'Database'].indexOf(component) + 1) * 2);
            },
          );
        }
        await step(
          'Write a design requirement',
          'The note is visible and saved locally.',
          async () => {
            await page
              .getByLabel('Requirements', { exact: true })
              .pressSequentially(
                'Keep each owner’s aliases separate. Define when a disabled alias stops redirecting.',
                { delay: 40 },
              );
            await expect(page.getByText(/Saved locally/)).toBeVisible();
          },
        );
        await step(
          'Start the practice timer',
          'The timer offers Pause while it runs.',
          async () => {
            await page.getByRole('button', { name: 'Start timer' }).click();
            await expect(page.getByRole('button', { name: 'Pause timer' })).toBeVisible();
          },
        );
        await step('Pause the practice timer', 'The timer offers Start again.', async () => {
          await page.getByRole('button', { name: 'Pause timer' }).click();
          await expect(page.getByRole('button', { name: 'Start timer' })).toBeVisible();
        });
        await step('Select mock practice', 'Mock mode disables curated hints.', async () => {
          await page.getByLabel('Practice mode').selectOption('mock');
          await expect(page.getByRole('button', { name: 'One curated hint' })).toBeDisabled();
        });
        await step('Return to guided practice', 'Guided mode permits curated hints.', async () => {
          await page.getByLabel('Practice mode').selectOption('guided');
          await expect(page.getByRole('button', { name: 'One curated hint' })).toBeEnabled();
        });
        await step(
          'Save a checkpoint and inspect history',
          'The history dialog contains a saved checkpoint.',
          async () => {
            await page.getByRole('button', { name: 'Checkpoint', exact: true }).click();
            await page.getByRole('button', { name: 'History', exact: true }).click();
            await expect(
              page.getByRole('dialog', { name: 'Design checkpoint history' }),
            ).toBeVisible();
          },
        );
        await step(
          'Review discussion coverage',
          'The real backend returns a review and permits completion.',
          async () => {
            await page.getByRole('button', { name: 'Close history' }).click();
            await page.getByRole('button', { name: 'Review', exact: true }).click();
            await expect(
              page.getByRole('heading', { name: 'Discussion coverage', exact: true }),
            ).toBeVisible();
            await expect(
              page.getByRole('button', { name: 'Finish practice', exact: true }),
            ).toBeEnabled();
          },
        );
        await step('Finish the design session', 'The session is marked finished.', async () => {
          await page.getByRole('button', { name: 'Finish practice', exact: true }).click();
          await expect(
            page.getByRole('button', { name: 'Session finished', exact: true }),
          ).toBeVisible();
        });
      },
    );
  } finally {
    await app.close();
  }
});
