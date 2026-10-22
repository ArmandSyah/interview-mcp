import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  MAX_DIAGRAM_ELEMENTS,
  MAX_DIAGRAM_LABEL_CHARACTERS,
  MAX_DIAGRAM_SUMMARY_BYTES,
  canonicalDesignJSON,
  emptyDesignDraft,
  type DesignDraft,
  type DesignScene,
  type DiagramElement,
} from '../shared/design';

const elementId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const fileSchema = z
  .object({
    id: elementId,
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    dataURL: z.string().max(6_000_000),
    created: z.number().finite(),
    lastRetrieved: z.number().finite().optional(),
  })
  .strict();
export const draftSchema = z
  .object({
    version: z.literal(1),
    scene: z
      .object({
        elements: z.array(z.record(z.string(), z.unknown())).max(MAX_DIAGRAM_ELEMENTS),
        appState: z.record(z.string(), z.unknown()),
        files: z.record(elementId, fileSchema),
      })
      .strict(),
    notes: z
      .object({
        requirements: z.string().max(5000),
        api: z.string().max(5000),
        data: z.string().max(5000),
        capacity: z.string().max(5000),
        tradeoffs: z.string().max(5000),
        failure_modes: z.string().max(5000),
      })
      .strict(),
    practiceMode: z.enum(['guided', 'mock']),
    elapsedSeconds: z.number().int().min(0).max(10_000_000),
  })
  .strict();
const shapeTypes = new Set([
  'rectangle',
  'diamond',
  'ellipse',
  'text',
  'arrow',
  'line',
  'freedraw',
  'image',
  'frame',
]);
type StoredFile = Omit<DesignScene['files'][string], 'dataURL'> & { sha256: string };
type StoredDraft = Omit<DesignDraft, 'scene'> & {
  scene: Omit<DesignScene, 'files'> & { files: Record<string, StoredFile> };
};
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function imageBytes(file: DesignScene['files'][string]): Buffer {
  const prefix = 'data:' + file.mimeType + ';base64,';
  if (!file.dataURL.startsWith(prefix))
    throw new Error('Only local raster image assets are supported');
  const encoded = file.dataURL.slice(prefix.length);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('Invalid image data');
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > 4_000_000) throw new Error('An image must be at most 4 MB');
  const valid =
    (file.mimeType === 'image/png' &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
    (file.mimeType === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216) ||
    (file.mimeType === 'image/gif' && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) ||
    (file.mimeType === 'image/webp' &&
      bytes.subarray(0, 4).toString() === 'RIFF' &&
      bytes.subarray(8, 12).toString() === 'WEBP');
  if (!valid) throw new Error('Image contents do not match the declared raster format');
  return bytes;
}
export function validateDraft(input: unknown): DesignDraft {
  const parsed = draftSchema.parse(input);
  const contents = JSON.stringify(parsed);
  if (Buffer.byteLength(contents) > 18_000_000) throw new Error('Design workspace is too large');
  // IPC preserves undefined optional properties; JSON files do not. Hash exactly
  // the durable representation so saving/reloading cannot invalidate a review.
  const draft = JSON.parse(contents) as DesignDraft;
  const ids = new Set<string>();
  for (const element of draft.scene.elements) {
    const id = elementId.parse(element.id);
    if (ids.has(id) || !shapeTypes.has(String(element.type)))
      throw new Error('Invalid or unsupported diagram element');
    ids.add(id);
    for (const field of ['x', 'y', 'width', 'height']) {
      if (
        typeof element[field] !== 'number' ||
        !Number.isFinite(element[field]) ||
        Math.abs(element[field] as number) > 10_000_000
      )
        throw new Error('Invalid diagram coordinates');
    }
    if (typeof element.text === 'string' && element.text.length > 12_000)
      throw new Error('Diagram text is too long');
    if (element.type === 'text' && element.fontFamily === 9)
      throw new Error('The server-only Liberation font is not supported in this desktop canvas');
    if (
      element.type === 'image' &&
      !element.isDeleted &&
      (typeof element.fileId !== 'string' || !draft.scene.files[element.fileId])
    )
      throw new Error('An image asset is missing; the previous saved scene was preserved');
    // Links remain inert in the workbench; remote embeds are never accepted.
    element.link = null;
  }
  let total = 0;
  for (const [id, file] of Object.entries(draft.scene.files)) {
    if (file.id !== id) throw new Error('Image asset identity mismatch');
    total += imageBytes(file).length;
  }
  if (total > 12_000_000) throw new Error('Total image assets must be at most 12 MB');
  return draft;
}
export function summarizeDiagram(draft: DesignDraft): DiagramElement[] {
  const elements = draft.scene.elements.filter((element) => !element.isDeleted);
  const labels = new Map<string, string>();
  for (const element of elements)
    if (element.type === 'text' && typeof element.containerId === 'string')
      labels.set(element.containerId, String(element.text ?? ''));
  const summary = elements.map((element) => {
    const data = element.customData as Record<string, unknown> | undefined;
    const binding = (key: string) => {
      const value = element[key] as { elementId?: unknown } | null | undefined;
      return typeof value?.elementId === 'string' ? value.elementId.slice(0, 128) : null;
    };
    const label = labels.get(String(element.id)) ?? String(element.text ?? '');
    return {
      id: String(element.id),
      type: String(element.type),
      label: label.slice(0, MAX_DIAGRAM_LABEL_CHARACTERS),
      label_truncated: label.length > MAX_DIAGRAM_LABEL_CHARACTERS,
      kind: typeof data?.componentKind === 'string' ? data.componentKind.slice(0, 60) : '',
      from_id: binding('startBinding'),
      to_id: binding('endBinding'),
    };
  });
  if (Buffer.byteLength(JSON.stringify(summary)) > MAX_DIAGRAM_SUMMARY_BYTES)
    throw new Error(
      'Diagram checkpoint summary exceeds 700 KB. Your full canvas remains saved; shorten labels before checkpointing or coaching.',
    );
  return summary;
}

export function designDigest(draft: DesignDraft): string {
  const files = Object.fromEntries(
    Object.entries(draft.scene.files).map(([id, file]) => {
      const { dataURL: _data, ...metadata } = file;
      return [id, { ...metadata, sha256: sha256(imageBytes(file)) }];
    }),
  );
  return sha256(canonicalDesignJSON({ elements: draft.scene.elements, files, notes: draft.notes }));
}

export class DesignStore {
  private writes: Promise<unknown> = Promise.resolve();
  private loaded = new Set<string>();
  constructor(private readonly root: string) {}
  private path(scope: string, sessionId: string, checkpointId?: string): string {
    if (!/^[a-f0-9]{24}$/.test(scope)) throw new Error('Invalid workspace identity');
    z.string().uuid().parse(sessionId);
    if (checkpointId) z.string().uuid().parse(checkpointId);
    return join(
      this.root,
      'design',
      scope,
      sessionId,
      checkpointId ? checkpointId + '.json' : 'draft.json',
    );
  }
  private assets(scope: string): string {
    if (!/^[a-f0-9]{24}$/.test(scope)) throw new Error('Invalid workspace identity');
    return join(this.root, 'design', scope, 'assets');
  }
  private async atomic(path: string, contents: string): Promise<void> {
    const temporary = path + '.' + randomUUID() + '.tmp';
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(contents, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  }
  private async read(
    scope: string,
    sessionId: string,
    checkpointId?: string,
  ): Promise<DesignDraft> {
    const path = this.path(scope, sessionId, checkpointId);
    let contents: string;
    try {
      contents = await readFile(path, 'utf8');
    } catch (error) {
      if (!checkpointId && (error as NodeJS.ErrnoException).code === 'ENOENT')
        return emptyDesignDraft();
      throw new Error('Cannot read this saved design. Existing files have not been overwritten.');
    }
    try {
      if (Buffer.byteLength(contents) > 6_000_000) throw new Error('Stored design is too large');
      const stored = JSON.parse(contents) as StoredDraft;
      if (stored.version !== 1 || !stored.scene?.files) throw new Error('Unknown design version');
      const files: DesignScene['files'] = {};
      for (const [id, file] of Object.entries(stored.scene.files)) {
        if (!/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid image reference');
        const bytes = await readFile(join(this.assets(scope), file.sha256));
        if (sha256(bytes) !== file.sha256) throw new Error('Image integrity check failed');
        const { sha256: _digest, ...metadata } = file;
        files[id] = {
          ...metadata,
          dataURL: 'data:' + file.mimeType + ';base64,' + bytes.toString('base64'),
        };
      }
      return validateDraft({ ...stored, scene: { ...stored.scene, files } });
    } catch {
      throw new Error(
        'Saved design or image assets are damaged. Existing files have not been overwritten.',
      );
    }
  }
  async load(scope: string, sessionId: string): Promise<DesignDraft> {
    // Reads use saved data. A previous write error must not prevent a new save.
    await this.writes.catch(() => {});
    const path = this.path(scope, sessionId);
    const draft = await this.read(scope, sessionId);
    this.loaded.add(path);
    return draft;
  }
  async save(scope: string, sessionId: string, input: unknown): Promise<string> {
    const path = this.path(scope, sessionId);
    if (!this.loaded.has(path)) await this.load(scope, sessionId);
    const draft = validateDraft(input);
    const work = this.writes
      .catch(() => {})
      .then(async () => {
        await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
        await mkdir(this.assets(scope), { recursive: true, mode: 0o700 });
        const files: Record<string, StoredFile> = {};
        for (const [id, file] of Object.entries(draft.scene.files)) {
          const bytes = imageBytes(file);
          const digest = sha256(bytes);
          const assetPath = join(this.assets(scope), digest);
          try {
            await writeFile(assetPath, bytes, { mode: 0o600, flag: 'wx' });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            if (sha256(await readFile(assetPath)) !== digest)
              throw new Error('Existing image asset is damaged');
          }
          const { dataURL: _data, ...metadata } = file;
          files[id] = { ...metadata, sha256: digest };
        }
        const stored: StoredDraft = { ...draft, scene: { ...draft.scene, files } };
        const contents = JSON.stringify(stored);
        if (Buffer.byteLength(contents) > 6_000_000)
          throw new Error('Diagram metadata must be at most 6 MB');
        await this.atomic(path, contents);
        return designDigest(draft);
      });
    this.writes = work;
    return work;
  }
  async checkpoint(
    scope: string,
    sessionId: string,
    checkpointId: string,
  ): Promise<{ draft: DesignDraft; digest: string; diagram: DiagramElement[] }> {
    const work = this.writes.then(async () => {
      const draft = await this.read(scope, sessionId);
      // Validate the complete projection before creating immutable checkpoint files.
      const diagram = summarizeDiagram(draft);
      const path = this.path(scope, sessionId, checkpointId);
      const contents = await readFile(this.path(scope, sessionId), 'utf8');
      // Exclusive creation preserves immutable history even if an ID is reused.
      const file = await open(path, 'wx', 0o600);
      try {
        await file.writeFile(contents, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      return { draft, digest: designDigest(draft), diagram };
    });
    this.writes = work;
    return work;
  }
  async restore(
    scope: string,
    sessionId: string,
    checkpointId: string,
    expectedDigest: string,
  ): Promise<DesignDraft> {
    await this.writes;
    const draft = await this.read(scope, sessionId, checkpointId);
    if (designDigest(draft) !== expectedDigest)
      throw new Error('Checkpoint integrity check failed; current draft was preserved');
    await this.save(scope, sessionId, draft);
    return draft;
  }
  async readCheckpoint(
    scope: string,
    sessionId: string,
    checkpointId: string,
    expectedDigest: string,
  ): Promise<DesignDraft> {
    await this.writes;
    const draft = await this.read(scope, sessionId, checkpointId);
    if (designDigest(draft) !== expectedDigest)
      throw new Error('Checkpoint integrity check failed');
    return draft;
  }
  async flush(): Promise<void> {
    await this.writes;
  }
}
