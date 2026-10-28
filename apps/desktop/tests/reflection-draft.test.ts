import { expect, it } from 'vitest';
import { editReflectionDraft } from '../src/renderer/reflection-draft';
import type { ReflectionDraft } from '../src/shared/practice';

const draft: ReflectionDraft = {
  reflection_id: '11111111-1111-4111-8111-111111111111',
  expected_version: 3,
  answer: 'Original answer.',
  takeaway: 'Original reflection.',
  next_action: 'Original next step.',
  self_rating: 'needs_work',
};

it.each([
  { answer: 'New answer.' },
  { takeaway: 'New reflection.' },
  { next_action: 'New next step.' },
  { self_rating: 'recalled' as const },
  { answer: '' },
])('assigns a new reflection ID for a content edit: %j', (changes) => {
  const previous = structuredClone(draft);
  const next = { ...previous, ...changes };
  const result = editReflectionDraft(previous, next);
  expect(result.reflection_id).not.toBe(previous.reflection_id);
  expect(result.reflection_id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect({ ...result, reflection_id: previous.reflection_id }).toEqual(next);
  expect(previous).toEqual(draft);
  expect(next.reflection_id).toBe(draft.reflection_id);
});

it('preserves the reflection ID for unchanged content and schedule changes', () => {
  for (const next of [{ ...draft }, { ...draft, expected_version: draft.expected_version + 1 }]) {
    expect(editReflectionDraft(draft, next)).toEqual(next);
  }
});

it('does not reuse an earlier ID when a later edit restores previous text', () => {
  const changed = editReflectionDraft(draft, { ...draft, answer: 'New answer.' });
  const restored = editReflectionDraft(changed, { ...changed, answer: draft.answer });
  expect(restored.reflection_id).not.toBe(draft.reflection_id);
  expect(restored.reflection_id).not.toBe(changed.reflection_id);
  expect(restored.answer).toBe(draft.answer);
  expect(restored.expected_version).toBe(draft.expected_version);
});
