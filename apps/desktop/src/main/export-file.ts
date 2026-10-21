import { randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';

/** Write export bytes before file replacement. Errors leave the selected file unchanged. */
export async function writeExport(path: string, data: string | Uint8Array): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch((cleanup: NodeJS.ErrnoException) => {
      if (cleanup.code !== 'ENOENT') throw cleanup;
    });
    throw error;
  }
}
