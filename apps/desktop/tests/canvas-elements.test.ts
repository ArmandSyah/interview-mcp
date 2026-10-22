import { expect, it } from 'vitest';
import { canvasElements } from '../src/renderer/canvas-elements';
import { designEvidenceChanged, emptyDesignDraft } from '../src/shared/design';
import { designDigest } from '../src/main/design-storage';

it('preserves saved null bindings and the existing evidence digest after a canvas load', () => {
  const before = emptyDesignDraft();
  before.scene.elements = [
    { id: 'label', type: 'text', text: 'Database', boundElements: null, link: null },
  ];
  const loaded = [{ ...before.scene.elements[0], boundElements: [] }];
  const after = structuredClone(before);
  after.scene.elements = canvasElements(loaded, before.scene.elements);
  expect(after.scene.elements).toEqual(before.scene.elements);
  expect(loaded[0].boundElements).toEqual([]);
  expect(designEvidenceChanged(before, after)).toBe(false);
  expect(designDigest(after)).toBe(designDigest(before));
});

it('preserves new bindings, removed bindings, and edits to other element fields', () => {
  const binding = { id: 'arrow', type: 'arrow' };
  for (const [previous, next] of [
    [
      { id: 'shape', boundElements: null },
      { id: 'shape', boundElements: [binding] },
    ],
    [
      { id: 'shape', boundElements: [binding] },
      { id: 'shape', boundElements: [] },
    ],
    [
      { id: 'shape', boundElements: [binding] },
      { id: 'shape', boundElements: null },
    ],
    [
      { id: 'shape', boundElements: null, x: 10 },
      { id: 'shape', boundElements: [], x: 20 },
    ],
  ]) {
    const before = emptyDesignDraft();
    before.scene.elements = [{ ...previous, link: null }];
    const after = structuredClone(before);
    after.scene.elements = canvasElements([next], before.scene.elements);
    expect(designEvidenceChanged(before, after), JSON.stringify({ previous, next })).toBe(true);
    expect(designDigest(after), JSON.stringify({ previous, next })).not.toBe(designDigest(before));
    expect(after.scene.elements[0].boundElements).toEqual('x' in next ? null : next.boundElements);
    if ('x' in next) expect(after.scene.elements[0].x).toBe(20);
  }
});

it('matches saved elements by ID and preserves added, removed, and reordered elements', () => {
  const previous = [
    { id: 'first', boundElements: null },
    { id: 'second', boundElements: [] },
    { id: 'removed', boundElements: null },
  ];
  const elements = [
    { id: 'second', boundElements: [] },
    { id: 'first', boundElements: [] },
    { id: 'added', boundElements: [] },
  ];
  expect(canvasElements(elements, previous)).toEqual([
    { id: 'second', boundElements: [], link: null },
    { id: 'first', boundElements: null, link: null },
    { id: 'added', boundElements: [], link: null },
  ]);
  expect(previous).toHaveLength(3);
  expect(elements[1].boundElements).toEqual([]);
});

it('does not restore external links or invent bindings for an unknown element', () => {
  expect(canvasElements([{ id: 'new', link: 'https://example.invalid' }], [])).toEqual([
    { id: 'new', link: null },
  ]);
});
