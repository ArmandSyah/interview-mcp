import { expect, type Locator, type Page } from '@playwright/test';

export async function openPracticeQueue(page: Page) {
  await page.getByRole('button', { name: 'Practice queue', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Practice queue', exact: true });
  await expect(dialog.getByLabel('Practice to revisit')).toBeEnabled();
  return dialog;
}

export async function codingReminder(page: Page) {
  await expect(page.getByText('MCP connected · 5 problems')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: /Delivery Hold Clusters/ }).click();
  await expect(page.getByTestId('code-editor')).toBeVisible();
  const snapshot = await page.evaluate(() => window.interview.snapshot());
  const dialog = await openPracticeQueue(page);
  await dialog
    .getByLabel('Practice to revisit')
    .selectOption(`coding:${snapshot.sessions[0].attemptId}`);
  await dialog.getByLabel('Reminder delay (days)').fill('0');
  await dialog.getByRole('button', { name: 'Add to queue', exact: true }).click();
  await expect(dialog.locator('.practice-queue-card')).toHaveCount(1);
  await expect(dialog.getByRole('button', { name: 'Refresh queue', exact: true })).toBeEnabled();
  const queue = await page.evaluate(() => window.interview.practiceQueue());
  expect(queue.items).toHaveLength(1);
  return { dialog, item: queue.items[0], snapshot };
}

export async function repeatedClick(button: Locator) {
  await button.evaluate((element: HTMLButtonElement) => {
    element.click();
    element.click();
    element.click();
  });
}
