export const MAX_DIAGRAM_ELEMENTS = 3000;
export const MAX_DIAGRAM_LABEL_CHARACTERS = 2000;
export const MAX_DIAGRAM_SUMMARY_BYTES = 700_000;

export const noteSections = [
  { key: 'requirements', title: 'Requirements' },
  { key: 'api', title: 'API & contracts' },
  { key: 'data', title: 'Data & ownership' },
  { key: 'capacity', title: 'Capacity assumptions' },
  { key: 'tradeoffs', title: 'Decisions & tradeoffs' },
  { key: 'failure_modes', title: 'Failure modes' },
] as const;
export type NoteKey = (typeof noteSections)[number]['key'];
export type DesignNotes = Record<NoteKey, string>;
export type DesignBrief = {
  id: string;
  title: string;
  difficulty: 'easy' | 'medium' | 'hard';
  tags: string[];
  brief_md: string;
  requirements: string[];
  constraints: string[];
  scenarios: string[];
  rubric: { key: NoteKey; title: string; prompt: string }[];
  time_budget_minutes: number;
  revision: string;
  pack_id: string;
};
export type DesignSummary = Pick<
  DesignBrief,
  'id' | 'title' | 'difficulty' | 'tags' | 'time_budget_minutes' | 'revision' | 'pack_id'
>;
export type DiagramElement = {
  id: string;
  type: string;
  label: string;
  label_truncated?: boolean;
  kind: string;
  from_id: string | null;
  to_id: string | null;
};
export type DesignCheckpoint = {
  id: string;
  session_id: string;
  label: string;
  scene_digest: string;
  notes: DesignNotes;
  diagram: DiagramElement[];
  created_at: string;
};
export type DesignReview = {
  checkpoint_id: string;
  scene_digest: string;
  rubric_version: string;
  source: 'curated';
  items: {
    key: NoteKey;
    title: string;
    status: 'not_discussed' | 'needs_explanation' | 'discussed';
    evidence: string;
    question: string;
  }[];
  summary: string;
  limitations: string;
};
export type DesignScene = {
  elements: Record<string, unknown>[];
  appState: Record<string, unknown>;
  files: Record<
    string,
    {
      id: string;
      mimeType: string;
      dataURL: string;
      created: number;
      lastRetrieved?: number;
    }
  >;
};
export type DesignDraft = {
  version: 1;
  scene: DesignScene;
  notes: DesignNotes;
  practiceMode: 'guided' | 'mock';
  elapsedSeconds: number;
};
export type DesignSession = {
  id: string;
  problem_id: string;
  brief: DesignBrief;
  status: 'in_progress' | 'completed';
  started_at: string;
  completed_at: string | null;
  chat: import('./types').ChatItem[];
  hintDepth: number;
  latestCheckpointId: string | null;
  review: DesignReview | null;
  draftDigest: string;
  updatedAt: number;
};
export function emptyDesignDraft(): DesignDraft {
  return {
    version: 1,
    scene: { elements: [], appState: { viewBackgroundColor: '#ffffff' }, files: {} },
    notes: Object.fromEntries(noteSections.map(({ key }) => [key, ''])) as DesignNotes,
    practiceMode: 'guided',
    elapsedSeconds: 0,
  };
}

export function canonicalDesignJSON(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalDesignJSON).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => JSON.stringify(key) + ':' + canonicalDesignJSON(item))
        .join(',') +
      '}'
    );
  // JSON omits undefined object values and stores undefined array items as null.
  return JSON.stringify(value) ?? 'null';
}

export function designEvidenceChanged(before: DesignDraft, after: DesignDraft): boolean {
  // Match the digest's evidence boundary. Timer, mode, and viewport still save,
  // but do not invalidate a review. Shared references avoid work on timer ticks.
  return (
    (before.notes !== after.notes &&
      canonicalDesignJSON(before.notes) !== canonicalDesignJSON(after.notes)) ||
    (before.scene.elements !== after.scene.elements &&
      canonicalDesignJSON(before.scene.elements) !== canonicalDesignJSON(after.scene.elements)) ||
    (before.scene.files !== after.scene.files &&
      canonicalDesignJSON(before.scene.files) !== canonicalDesignJSON(after.scene.files))
  );
}
