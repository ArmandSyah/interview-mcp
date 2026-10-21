import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { writeExport } from '../src/main/export-file';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
}));

it.each(['text', 'bytes'] as const)(
  'writes and replaces %s exports without temporary files',
  async (kind) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'interview-export-file-'));
    const path = join(root, 'output');
    const data = kind === 'text' ? 'Unicode export: λ\n' : new Uint8Array([0, 1, 127, 255]);
    await writeExport(path, 'Previous export');
    await expect(writeExport(path, data)).resolves.toBeUndefined();
    expect(await fs.readFile(path)).toEqual(Buffer.from(data));
    expect(await fs.readdir(root)).toEqual(['output']);
    if (process.platform !== 'win32') expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
  },
);

it.each(['open', 'write', 'sync', 'close', 'rename'] as const)(
  'keeps the selected file after an export %s error and allows retry',
  async (phase) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'interview-export-error-'));
    const path = join(root, 'output');
    await fs.writeFile(path, 'Previous export');
    const originalOpen = fs.open;
    const failure = new Error(`Fixture ${phase} failure`);
    const rename =
      phase === 'rename' ? vi.spyOn(fs, 'rename').mockRejectedValueOnce(failure) : undefined;
    const open = vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      if (phase === 'open') throw failure;
      const file = await originalOpen(...args);
      if (phase === 'write') {
        const write = file.writeFile.bind(file);
        file.writeFile = async () => {
          await write('Partial data');
          throw failure;
        };
      }
      if (phase === 'sync')
        file.sync = async () => {
          throw failure;
        };
      if (phase === 'close') {
        const close = file.close.bind(file);
        file.close = async () => {
          await close();
          throw failure;
        };
      }
      return file;
    });
    try {
      await expect(writeExport(path, 'New export')).rejects.toThrow(`Fixture ${phase} failure`);
      expect(await fs.readFile(path, 'utf8')).toBe('Previous export');
      expect(await fs.readdir(root)).toEqual(['output']);
    } finally {
      open.mockRestore();
      rename?.mockRestore();
    }
    await writeExport(path, 'New export');
    expect(await fs.readFile(path, 'utf8')).toBe('New export');
  },
);

it('does not replace a directory selected as an export file', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'interview-export-directory-'));
  const path = join(root, 'directory');
  await fs.mkdir(path);
  await fs.writeFile(join(path, 'keep'), 'Preserved data');
  await expect(writeExport(path, 'New export')).rejects.toThrow();
  expect(await fs.readFile(join(path, 'keep'), 'utf8')).toBe('Preserved data');
  expect(await fs.readdir(root)).toEqual(['directory']);
});

for (const kind of ['hard', 'symbolic'] as const) {
  it.skipIf(kind === 'symbolic' && process.platform === 'win32')(
    `replaces a selected ${kind} link without changing the other file`,
    async () => {
      const root = await fs.mkdtemp(join(tmpdir(), 'interview-export-link-'));
      const original = join(root, 'original');
      const selected = join(root, 'selected');
      await fs.writeFile(original, 'Original contents');
      if (kind === 'hard') await fs.link(original, selected);
      else await fs.symlink(original, selected);
      await writeExport(selected, 'Export contents');
      expect(await fs.readFile(selected, 'utf8')).toBe('Export contents');
      expect(await fs.readFile(original, 'utf8')).toBe('Original contents');
      expect((await fs.lstat(selected)).isSymbolicLink()).toBe(false);
      expect((await fs.readdir(root)).sort()).toEqual(['original', 'selected']);
    },
  );
}

it('does not perform temporary-file cleanup after file replacement succeeds', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'interview-export-commit-'));
  const path = join(root, 'output');
  await fs.writeFile(path, 'Previous export');
  const unlink = vi.spyOn(fs, 'unlink').mockRejectedValueOnce(new Error('Fixture cleanup failure'));
  try {
    await expect(writeExport(path, 'Committed export')).resolves.toBeUndefined();
    expect(unlink).not.toHaveBeenCalled();
    expect(await fs.readFile(path, 'utf8')).toBe('Committed export');
    expect(await fs.readdir(root)).toEqual(['output']);
  } finally {
    unlink.mockRestore();
  }
});
