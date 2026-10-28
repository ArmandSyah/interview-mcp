import { expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './desktop';
import { gateIpc } from './ipc-gate';
import { controlledCoach, openCoach } from './chat-fixture';

type TimerState = {
  original: typeof setTimeout;
  deadlines: { handle: ReturnType<typeof setTimeout>; expire: () => void }[];
};
type TimerGlobal = typeof globalThis & { approvalTestTimers?: TimerState };

// Capture the real approval deadline. Do not replace the renderer or approval handler.
async function approvalDeadline(app: ElectronApplication) {
  await app.evaluate(() => {
    const target = globalThis as TimerGlobal;
    const state: TimerState = { original: setTimeout, deadlines: [] };
    target.approvalTestTimers = state;
    target.setTimeout = ((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      const handle = state.original(callback, delay, ...args);
      if (delay === 60_000) state.deadlines.push({ handle, expire: () => callback(...args) });
      return handle;
    }) as typeof setTimeout;
  });
  return {
    expire: () =>
      app.evaluate(() => {
        const state = (globalThis as TimerGlobal).approvalTestTimers!;
        if (state.deadlines.length !== 1)
          throw new Error(`Expected one approval deadline, received ${state.deadlines.length}`);
        clearTimeout(state.deadlines[0].handle);
        state.deadlines[0].expire();
      }),
    restore: () =>
      app.evaluate(() => {
        const target = globalThis as TimerGlobal;
        if (!target.approvalTestTimers) return;
        target.setTimeout = target.approvalTestTimers.original;
        delete target.approvalTestTimers;
      }),
  };
}

for (const choice of ['Submit this draft', 'Keep practicing', 'Escape']) {
  test(`approval failure preserves the dialog and permits retry after ${choice}`, async () => {
    const coach = await controlledCoach(true);
    const app = await launch(await mkdtemp(join(tmpdir(), 'interview-approval-retry-')));
    let approve: Awaited<ReturnType<typeof gateIpc>> | undefined;
    try {
      const page = await app.firstWindow();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const { composer, send } = await openCoach(page, coach.url);
      await composer.fill('Discuss submission of this draft.');
      await send.click();
      const dialog = page.getByRole('dialog', { name: 'Approve submission?' });
      await expect(dialog).toBeVisible();
      approve = await gateIpc(app, 'approve');
      if (choice === 'Escape') await page.keyboard.press('Escape');
      else await dialog.getByRole('button', { name: choice, exact: true }).click();
      await expect.poll(() => approve!.calls()).toHaveLength(1);
      expect((await approve.calls())[0][1]).toBe(choice === 'Submit this draft');
      await approve.release(0, 'Fixture approval transport failure');
      await expect(
        dialog,
        'A failed decision must keep the approval available for retry',
      ).toBeVisible();
      await expect(dialog.getByRole('alert')).toHaveText('Fixture approval transport failure');
      if (choice === 'Submit this draft')
        await page.screenshot({ path: 'test-results/workbench-approval-recovery.png' });
      await expect(
        dialog.getByRole('button', { name: 'Keep practicing', exact: true }),
      ).toBeEnabled();
      expect(coach.requests, 'The coach must wait for a successful decision').toHaveLength(1);
      expect((await page.evaluate(() => window.interview.snapshot())).sessions[0].submitted).toBe(
        false,
      );
      await dialog.getByRole('button', { name: 'Keep practicing', exact: true }).click();
      await expect.poll(() => approve!.calls()).toHaveLength(2);
      await approve.release(1);
      await expect(dialog).toHaveCount(0);
      await expect.poll(() => coach.requests).toHaveLength(2);
      coach.finish(1, ' Continue with your draft.');
      await expect(page.getByRole('button', { name: 'Stop coach', exact: true })).toHaveCount(0);
      expect((await page.evaluate(() => window.interview.snapshot())).sessions[0].submitted).toBe(
        false,
      );
      expect(errors, 'Approval failures must not cause an unhandled rejection').toEqual([]);
    } finally {
      await approve?.restore().catch(() => {});
      await app.close();
      await coach.close();
    }
  });
}

test('one pending approval prevents repeated clicks, conflicting decisions, and Escape', async () => {
  const coach = await controlledCoach(true);
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-approval-repeat-')));
  let approve: Awaited<ReturnType<typeof gateIpc>> | undefined;
  try {
    const page = await app.firstWindow();
    const { composer, send } = await openCoach(page, coach.url);
    await composer.fill('Discuss this draft.');
    await send.click();
    const dialog = page.getByRole('dialog', { name: 'Approve submission?' });
    await expect(dialog).toBeVisible();
    await page.mouse.click(8, 8);
    await expect(dialog, 'A backdrop click must not select an approval decision').toBeVisible();
    expect(coach.requests).toHaveLength(1);
    approve = await gateIpc(app, 'approve');
    await dialog.evaluate((element) => {
      const buttons = element.querySelectorAll('button');
      buttons[0].click();
      buttons[0].click();
      buttons[1].click();
    });
    await expect.poll(() => approve!.calls()).not.toHaveLength(0);
    await page.evaluate(() => window.interview.snapshot());
    expect(
      await approve.calls(),
      'Repeated approval clicks must produce one denial request',
    ).toHaveLength(1);
    expect((await approve.calls())[0][1]).toBe(false);
    await expect(dialog).toBeVisible();
    for (const button of await dialog.getByRole('button').all())
      await expect(button).toBeDisabled();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    expect(await approve.calls()).toHaveLength(1);
    await approve.release(0);
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => coach.requests).toHaveLength(2);
    coach.finish(1, ' Decision received.');
    await expect(page.getByRole('button', { name: 'Stop coach', exact: true })).toHaveCount(0);
  } finally {
    await approve?.restore().catch(() => {});
    await app.close();
    await coach.close();
  }
});

test('approval expiry closes the dialog before the coach finishes and never submits', async () => {
  const coach = await controlledCoach(true);
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-approval-expiry-')));
  let deadline: Awaited<ReturnType<typeof approvalDeadline>> | undefined;
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const { composer, send } = await openCoach(page, coach.url);
    deadline = await approvalDeadline(app);
    await composer.fill('Wait for my decision.');
    await send.click();
    const dialog = page.getByRole('dialog', { name: 'Approve submission?' });
    await expect(dialog).toBeVisible();
    await deadline.expire();
    await expect.poll(() => coach.requests).toHaveLength(2);
    await expect(
      dialog,
      'An expired approval must not cover a chat that is still active',
    ).toHaveCount(0);
    const snapshot = await page.evaluate(() => window.interview.snapshot());
    expect(snapshot.busy).toBe(true);
    expect(snapshot.sessions[0].submitted).toBe(false);
    await expect(page.getByRole('button', { name: 'Stop coach', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Stop coach', exact: true }).click();
    await expect.poll(() => coach.requests[1].closed).toBe(true);
    await expect(page.getByRole('button', { name: 'Stop coach', exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await deadline?.restore().catch(() => {});
    await app.close();
    await coach.close();
  }
});

for (const failure of [false, true]) {
  test(`a late approval ${failure ? 'error' : 'response'} does not dismiss the next approval`, async () => {
    const coach = await controlledCoach([1, 2]);
    const app = await launch(await mkdtemp(join(tmpdir(), 'interview-approval-late-')));
    let approve: Awaited<ReturnType<typeof gateIpc>> | undefined;
    try {
      const page = await app.firstWindow();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const { composer, send } = await openCoach(page, coach.url);
      await composer.fill('Review the submission request.');
      await send.click();
      const dialog = page.getByRole('dialog', { name: 'Approve submission?' });
      await expect(dialog).toBeVisible();
      approve = await gateIpc(app, 'approve', 'response');
      await dialog.getByRole('button', { name: 'Keep practicing', exact: true }).click();
      await expect.poll(() => approve!.calls()).toHaveLength(1);
      await expect.poll(() => coach.requests).toHaveLength(2);
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole('button', { name: 'Keep practicing', exact: true }),
      ).toBeEnabled();
      await approve.release(0, failure ? 'Fixture obsolete approval failure' : undefined);
      await page.evaluate(() => window.interview.snapshot());
      await expect(dialog).toBeVisible();
      await expect(
        page.getByRole('alert').filter({ hasText: 'Fixture obsolete approval failure' }),
      ).toHaveCount(0);
      await dialog.getByRole('button', { name: 'Keep practicing', exact: true }).click();
      await expect.poll(() => approve!.calls()).toHaveLength(2);
      const calls = await approve.calls();
      expect(calls[0][0], 'Each approval must have its own ID').not.toBe(calls[1][0]);
      await approve.release(1);
      await expect(dialog).toHaveCount(0);
      await expect.poll(() => coach.requests).toHaveLength(3);
      coach.finish(2, ' Both requests were denied.');
      await expect(page.getByRole('button', { name: 'Stop coach', exact: true })).toHaveCount(0);
      expect((await page.evaluate(() => window.interview.snapshot())).sessions[0].submitted).toBe(
        false,
      );
      expect(errors).toEqual([]);
    } finally {
      await approve?.restore().catch(() => {});
      await app.close();
      await coach.close();
    }
  });
}

test('an approval request received after expiry cannot submit or restore the old dialog', async () => {
  const coach = await controlledCoach(true);
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-approval-expired-request-')));
  let deadline: Awaited<ReturnType<typeof approvalDeadline>> | undefined;
  let approve: Awaited<ReturnType<typeof gateIpc>> | undefined;
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const { composer, send } = await openCoach(page, coach.url);
    deadline = await approvalDeadline(app);
    await composer.fill('Wait for my decision.');
    await send.click();
    const dialog = page.getByRole('dialog', { name: 'Approve submission?' });
    await expect(dialog).toBeVisible();
    approve = await gateIpc(app, 'approve');
    await dialog.getByRole('button', { name: 'Submit this draft', exact: true }).click();
    await expect.poll(() => approve!.calls()).toHaveLength(1);
    await deadline.expire();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => coach.requests).toHaveLength(2);
    await approve.release(0);
    await page.evaluate(() => window.interview.snapshot());
    coach.finish(1, ' The request expired.');
    await expect(page.getByRole('button', { name: 'Stop coach', exact: true })).toHaveCount(0);
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('alert').filter({ hasText: 'Approval has expired' })).toHaveCount(
      0,
    );
    const snapshot = await page.evaluate(() => window.interview.snapshot());
    expect(snapshot.sessions[0].submitted).toBe(false);
    expect(snapshot.sessions[0].result).toBeNull();
    expect(errors).toEqual([]);
  } finally {
    await approve?.restore().catch(() => {});
    await deadline?.restore().catch(() => {});
    await app.close();
    await coach.close();
  }
});

test('explicit approval submits the captured draft to real Piston once', async () => {
  test.skip(process.env.INTERVIEW_DESKTOP_TEST_PISTON !== '1', 'This story requires local Piston');
  const coach = await controlledCoach(true);
  const app = await launch(await mkdtemp(join(tmpdir(), 'interview-approval-piston-')));
  let approve: Awaited<ReturnType<typeof gateIpc>> | undefined;
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const { composer, send } = await openCoach(page, coach.url);
    const before = await page.evaluate(() => window.interview.snapshot());
    await composer.fill('Submit this starter draft only after my approval.');
    await send.click();
    const dialog = page.getByRole('dialog', { name: 'Approve submission?' });
    await expect(dialog).toBeVisible();
    expect((await page.evaluate(() => window.interview.snapshot())).sessions[0].result).toBeNull();
    approve = await gateIpc(app, 'approve');
    await dialog
      .getByRole('button', { name: 'Submit this draft', exact: true })
      .evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });
    await expect.poll(() => approve!.calls()).toHaveLength(1);
    await page.evaluate(() => window.interview.snapshot());
    expect(await approve.calls()).toHaveLength(1);
    expect((await approve.calls())[0][1]).toBe(true);
    await approve.release(0);
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => coach.requests, { timeout: 30_000 }).toHaveLength(2);
    coach.finish(1, ' The starter draft did not pass its tests.');
    await expect(page.getByRole('button', { name: 'Stop coach', exact: true })).toHaveCount(0);
    const snapshot = await page.evaluate(() => window.interview.snapshot());
    expect(snapshot.error).toBeNull();
    expect(snapshot.sessions[0].code).toBe(before.sessions[0].code);
    expect(snapshot.sessions[0].result).toMatchObject({ tests_total: 7, all_passed: false });
    expect(snapshot.sessions[0].submitted, 'Approval does not mark a failed draft completed').toBe(
      false,
    );
    expect(
      snapshot.sessions[0].chat.filter((item) => item.tool === 'submit_solution'),
    ).toHaveLength(1);
    expect(snapshot.sessions[0].chat.find((item) => item.tool === 'submit_solution')?.status).toBe(
      'done',
    );
    expect(errors).toEqual([]);
  } finally {
    await approve?.restore().catch(() => {});
    await app.close();
    await coach.close();
  }
});
