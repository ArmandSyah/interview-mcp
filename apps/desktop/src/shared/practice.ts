export const DATABASE_SCHEMA_VERSION = 4;
export type PracticeKind = 'coding' | 'design';
export type SelfRating = 'needs_work' | 'with_effort' | 'recalled';
export type PracticeSource = {
  id: string;
  kind: PracticeKind;
  problem_id: string;
  problem_revision: string;
  title: string;
  status: string;
  started_at: string;
  queued_id: string | null;
};
export type PracticeQueueItem = {
  id: string;
  source_kind: PracticeKind;
  source_id: string;
  problem_id: string;
  problem_revision: string;
  title: string;
  recall_prompts: string[];
  due_at: string;
  paused: boolean;
  interval_days: number;
  version: number;
  last_reviewed_at: string | null;
  review_count: number;
};
export type PracticeReflection = {
  id: string;
  item_id: string;
  answer: string;
  takeaway: string;
  next_action: string;
  self_rating: SelfRating;
  interval_days: number;
  next_due_at: string;
  created_at: string;
};
export type ReflectionInput = {
  item_id: string;
  reflection_id: string;
  expected_version: number;
  answer: string;
  self_rating: SelfRating;
  takeaway: string;
  next_action: string;
};
export type ReflectionDraft = Omit<ReflectionInput, 'item_id'>;
export type PracticeQueueState = {
  supported: boolean;
  items: PracticeQueueItem[];
  sources: PracticeSource[];
};
