import type { ReflectionDraft } from '../shared/practice';

/** Each reflection ID identifies one version of the content. */
export function editReflectionDraft(
  previous: ReflectionDraft,
  next: ReflectionDraft,
): ReflectionDraft {
  const changed = (['answer', 'takeaway', 'next_action', 'self_rating'] as const).some(
    (field) => previous[field] !== next[field],
  );
  return changed ? { ...next, reflection_id: crypto.randomUUID() } : next;
}
