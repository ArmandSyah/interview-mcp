import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { designEvidenceChanged, emptyDesignDraft } from '../src/shared/design';
import { designDigest } from '../src/main/design-storage';

it('timer, mode, and viewport changes save without invalidating review evidence', () => {
  const before = emptyDesignDraft();
  const after = structuredClone(before);
  after.elapsedSeconds = 10;
  after.practiceMode = 'mock';
  after.scene.appState = { scrollX: 20, scrollY: 50, zoom: { value: 0.7 } };
  expect(designEvidenceChanged(before, after)).toBe(false);
  expect(designDigest(before)).toBe(designDigest(after));
});

it('notes, canvas edits, and image changes invalidate review evidence', () => {
  const before = emptyDesignDraft();
  for (const field of ['notes', 'elements', 'files']) {
    const after = structuredClone(before);
    if (field === 'notes') after.notes.requirements = 'A changed requirement';
    if (field === 'elements')
      after.scene.elements = [{ id: 'component', type: 'rectangle', x: 20 }];
    if (field === 'files')
      after.scene.files.image1 = {
        id: 'image1',
        mimeType: 'image/png',
        dataURL: 'data:image/png;base64,aW1hZ2U=',
        created: 1,
      };
    expect(designEvidenceChanged(before, after)).toBe(true);
  }
});

it('object key order does not invalidate a review and old digests remain stable', () => {
  const before = emptyDesignDraft();
  before.scene.elements = [{ id: 'component', type: 'rectangle', x: 20 }];
  const after = structuredClone(before);
  after.scene.elements = [{ x: 20, type: 'rectangle', id: 'component' }];
  after.notes = Object.fromEntries(Object.entries(after.notes).reverse()) as typeof after.notes;
  expect(designEvidenceChanged(before, after)).toBe(false);
  expect(designDigest(before)).toBe(designDigest(after));
  // Existing canonical serialization is unchanged by moving it to shared code.
  const legacy =
    '{"elements":[],"files":{},"notes":{"api":"","capacity":"","data":"","failure_modes":"","requirements":"","tradeoffs":""}}';
  expect(designDigest(emptyDesignDraft())).toBe(createHash('sha256').update(legacy).digest('hex'));
});

it('omitted optional canvas properties are not new review evidence', () => {
  const before = emptyDesignDraft();
  before.scene.elements = [{ id: 'component', type: 'rectangle', x: 20, optional: undefined }];
  const after = JSON.parse(JSON.stringify(before));
  expect(designEvidenceChanged(before, after)).toBe(false);
  expect(designDigest(before)).toBe(designDigest(after));
});
