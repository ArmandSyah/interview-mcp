import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  DesignStore,
  designDigest,
  summarizeDiagram,
  validateDraft,
} from '../src/main/design-storage';
import { emptyDesignDraft, MAX_DIAGRAM_ELEMENTS } from '../src/shared/design';

const scope = 'a'.repeat(24);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'interview-design-store-'));
  return { root, store: new DesignStore(root), id: randomUUID() };
}
it('optional IPC fields keep the same digest across save, reopen, and checkpoint', async () => {
  const { store, id } = await fixture();
  const draft = emptyDesignDraft();
  draft.scene.elements = [
    {
      id: 'component',
      type: 'rectangle',
      x: 20,
      y: 20,
      width: 100,
      height: 50,
      optional: undefined,
      customData: { optional: undefined, values: [undefined, 'kept'] },
    },
  ];
  const digest = await store.save(scope, id, draft);
  const reopened = await store.load(scope, id);
  expect(reopened.scene.elements[0]).not.toHaveProperty('optional');
  expect(reopened.scene.elements[0].customData).toEqual({ values: [null, 'kept'] });
  expect(designDigest(reopened)).toBe(digest);
  expect((await store.checkpoint(scope, id, randomUUID())).digest).toBe(digest);
});
it('round-trips notes, canvas and local content-addressed raster assets', async () => {
  const { root, store, id } = await fixture();
  const draft = emptyDesignDraft();
  draft.notes.requirements = 'My candidate-owned requirements';
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6lpwAAAAASUVORK5CYII=',
    'base64',
  );
  draft.scene.files.image1 = {
    id: 'image1',
    mimeType: 'image/png',
    dataURL: 'data:image/png;base64,' + bytes.toString('base64'),
    created: 1,
  };
  draft.scene.elements = [
    {
      id: 'image-element',
      type: 'image',
      fileId: 'image1',
      x: 0,
      y: 0,
      width: 20,
      height: 20,
      link: 'https://untrusted.invalid/',
    },
  ];
  const digest = await store.save(scope, id, draft);
  const restored = await new DesignStore(root).load(scope, id);
  expect(restored.notes).toEqual(draft.notes);
  expect(restored.scene.files).toEqual(draft.scene.files);
  expect(restored.scene.elements[0].link).toBeNull();
  expect(digest).toBe(designDigest(restored));
  expect(await readdir(join(root, 'design', scope, 'assets'))).toEqual([
    createHash('sha256').update(bytes).digest('hex'),
  ]);
  expect(await readFile(join(root, 'design', scope, id, 'draft.json'), 'utf8')).not.toContain(
    'base64',
  );
});
it('serializes saves, makes checkpoints immutable, and checks integrity on restore', async () => {
  const { store, id } = await fixture();
  const draft = emptyDesignDraft();
  const checkpoint = randomUUID();
  await store.save(scope, id, draft);
  const captured = await store.checkpoint(scope, id, checkpoint);
  await expect(store.checkpoint(scope, id, checkpoint)).rejects.toThrow();
  draft.notes.data = 'Changed ownership';
  // A failed exclusive checkpoint does not prevent a subsequent successful save.
  await store.save(scope, id, draft);
  await expect(store.restore(scope, id, checkpoint, 'f'.repeat(64))).rejects.toThrow('integrity');
  expect((await store.load(scope, id)).notes.data).toBe('Changed ownership');
  expect((await store.restore(scope, id, checkpoint, captured.digest)).notes.data).toBe('');
});
it('does not overwrite damaged drafts or checkpoints', async () => {
  const { root, store, id } = await fixture();
  await store.save(scope, id, emptyDesignDraft());
  const path = join(root, 'design', scope, id, 'draft.json');
  await writeFile(path, '{broken');
  const fresh = new DesignStore(root);
  await expect(fresh.save(scope, id, emptyDesignDraft())).rejects.toThrow('not been overwritten');
  expect(await readFile(path, 'utf8')).toBe('{broken');
});
it('a failed write does not block a different design draft while flush still reports the failure', async () => {
  const { store, id } = await fixture();
  const draft = emptyDesignDraft();
  draft.notes.requirements = 'Keep the previous draft.';
  await store.save(scope, id, draft);
  const checkpoint = randomUUID();
  await store.checkpoint(scope, id, checkpoint);
  await expect(store.checkpoint(scope, id, checkpoint)).rejects.toThrow();
  await expect(store.flush()).rejects.toThrow();
  await expect(store.load(scope, id)).resolves.toEqual(draft);
  await expect(store.flush()).rejects.toThrow();
  const next = randomUUID();
  await expect(store.save(scope, next, emptyDesignDraft())).resolves.toBe(
    designDigest(emptyDesignDraft()),
  );
  await expect(store.flush()).resolves.toBeUndefined();
  expect(await store.load(scope, id)).toEqual(draft);
  expect(await store.load(scope, next)).toEqual(emptyDesignDraft());
});
it('rejects path traversal, embeds, remote images, missing images and duplicate IDs', async () => {
  const { store, id } = await fixture();
  await expect(store.load(scope, '../../unsafe')).rejects.toThrow();
  await expect(store.load('../unsafe', id)).rejects.toThrow();
  for (const type of ['embeddable', 'iframe']) {
    const draft = emptyDesignDraft();
    draft.scene.elements = [{ id: 'test', type, x: 0, y: 0, width: 20, height: 20 }];
    expect(() => validateDraft(draft)).toThrow('unsupported');
  }
  const missing = emptyDesignDraft();
  missing.scene.elements = [
    { id: 'image', type: 'image', fileId: 'absent', x: 0, y: 0, width: 20, height: 20 },
  ];
  expect(() => validateDraft(missing)).toThrow('missing');
  const remote = emptyDesignDraft();
  remote.scene.files.test = {
    id: 'test',
    mimeType: 'image/png',
    dataURL: 'https://untrusted.invalid/image.png',
    created: 1,
  };
  expect(() => validateDraft(remote)).toThrow('local raster');
});
it('diagram summaries preserve labels and edge bindings without copying image bytes', () => {
  const draft = emptyDesignDraft();
  draft.scene.elements = [
    { id: 'db', type: 'ellipse', customData: { componentKind: 'database' } },
    { id: 'label', type: 'text', containerId: 'db', text: 'My store' },
    {
      id: 'edge',
      type: 'arrow',
      startBinding: { elementId: 'db' },
      endBinding: { elementId: 'service' },
    },
    { id: 'deleted', type: 'rectangle', isDeleted: true },
  ];
  const summary = summarizeDiagram(draft);
  expect(summary).toHaveLength(3);
  expect(summary[0]).toMatchObject({ label: 'My store', kind: 'database' });
  expect(summary[2]).toMatchObject({ from_id: 'db', to_id: 'service' });
});

it('summarizes every supported element, including late components/arrows, and marks shortened labels', () => {
  const draft = emptyDesignDraft();
  draft.scene.elements = Array.from({ length: MAX_DIAGRAM_ELEMENTS - 2 }, (_, index) => ({
    id: `node-${index}`,
    type: 'rectangle',
  }));
  draft.scene.elements.push(
    { id: 'late-label', type: 'text', containerId: 'node-2997', text: 'z'.repeat(2500) },
    {
      id: 'late-edge',
      type: 'arrow',
      startBinding: { elementId: 'node-0' },
      endBinding: { elementId: 'node-2997' },
    },
  );
  const summary = summarizeDiagram(draft);
  expect(summary).toHaveLength(MAX_DIAGRAM_ELEMENTS);
  expect(summary.at(-1)).toMatchObject({
    id: 'late-edge',
    from_id: 'node-0',
    to_id: 'node-2997',
  });
  expect(summary[2997].label).toHaveLength(2000);
  expect(summary[2997].label_truncated).toBe(true);
  expect(summary[0].label_truncated).toBe(false);
  expect(draft.scene.elements.at(-2)?.text).toHaveLength(2500);
});

it('an oversized checkpoint summary never creates a partial checkpoint or overwrites the full saved canvas', async () => {
  const { root, store, id } = await fixture();
  const draft = emptyDesignDraft();
  draft.scene.elements = Array.from({ length: 400 }, (_, index) => ({
    id: `text-${index}`,
    type: 'text',
    x: 0,
    y: 0,
    width: 20,
    height: 20,
    text: 'x'.repeat(2000),
  }));
  await store.save(scope, id, draft);
  const checkpointId = randomUUID();
  await expect(store.checkpoint(scope, id, checkpointId)).rejects.toThrow(
    'full canvas remains saved',
  );
  expect(await readdir(join(root, 'design', scope, id))).toEqual(['draft.json']);
  const reopened = new DesignStore(root);
  expect((await reopened.load(scope, id)).scene.elements).toHaveLength(400);
});
