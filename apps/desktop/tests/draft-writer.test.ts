import { expect, it, vi } from 'vitest';
import { DraftWriter } from '../src/renderer/draft-writer';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it('keeps the latest draft visible until its write succeeds', async () => {
  const first = deferred();
  const second = deferred();
  const save = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const writer = new DraftWriter<string>(save);
  writer.set('attempt', 'first');
  const flush = writer.flush();
  await Promise.resolve();
  expect(writer.get('attempt'), 'flush() must retain the in-flight draft').toBe('first');
  writer.set('attempt', 'latest');
  first.resolve();
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls).toEqual([
    ['attempt', 'first'],
    ['attempt', 'latest'],
  ]);
  expect(writer.get('attempt'), 'The first result must not clear the newer draft').toBe('latest');
  expect(writer.dirty).toBe(true);
  second.resolve();
  await flush;
  expect(writer.dirty).toBe(false);
  expect(writer.get('attempt')).toBeUndefined();
});

it('joins concurrent flush requests and waits for edits that arrive during a write', async () => {
  const first = deferred();
  const second = deferred();
  const save = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const writer = new DraftWriter<string>(save);
  writer.set('attempt', 'first');
  let completed = false;
  const flush = writer.flush();
  void flush.then(() => {
    completed = true;
  });
  expect(writer.flush(), 'Concurrent flush() must join the same operation').toBe(flush);
  await Promise.resolve();
  writer.set('attempt', 'latest');
  first.resolve();
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(completed, 'flush() must wait for save(attempt, latest)').toBe(false);
  second.resolve();
  await flush;
  expect(completed).toBe(true);
});

it.each([false, true])(
  'retries the latest draft after a failed save (new edit: %s)',
  async (edit) => {
    const first = deferred();
    const save = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const writer = new DraftWriter<string>(save);
    writer.set('attempt', 'first');
    const flush = writer.flush();
    const failure = expect(flush).rejects.toThrow('Disk unavailable');
    await Promise.resolve();
    if (edit) writer.set('attempt', 'latest');
    first.reject(new Error('Disk unavailable'));
    await failure;
    expect(writer.get('attempt')).toBe(edit ? 'latest' : 'first');
    await writer.flush();
    expect(save.mock.calls).toEqual([
      ['attempt', 'first'],
      ['attempt', edit ? 'latest' : 'first'],
    ]);
    expect(writer.dirty).toBe(false);
  },
);

it('saves independent drafts in order and combines edits before their write starts', async () => {
  const first = deferred();
  const save = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
  const writer = new DraftWriter<string>(save);
  writer.set('a', 'first');
  const flush = writer.flush();
  await Promise.resolve();
  writer.set('b', 'old');
  writer.set('b', 'latest');
  expect(save).toHaveBeenCalledTimes(1);
  first.resolve();
  await flush;
  expect(save.mock.calls).toEqual([
    ['a', 'first'],
    ['b', 'latest'],
  ]);
  await writer.flush();
  expect(save).toHaveBeenCalledTimes(2);
});

it('does not join a completed write when a new edit arrives before promise cleanup', async () => {
  const save = vi.fn(async () => {});
  const writer = new DraftWriter<string>(save);
  writer.set('attempt', 'first');
  const first = writer.flush();
  await Promise.resolve();
  await Promise.resolve();
  writer.set('attempt', '');
  await writer.flush();
  await first;
  expect(save.mock.calls, 'The second flush must save the empty replacement draft').toEqual([
    ['attempt', 'first'],
    ['attempt', ''],
  ]);
  expect(writer.dirty).toBe(false);
});
