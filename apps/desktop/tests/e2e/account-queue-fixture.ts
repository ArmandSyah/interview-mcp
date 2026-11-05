import { randomUUID } from 'node:crypto';
import type {
  PracticeQueueItem,
  PracticeReflection,
  PracticeSource,
  SelfRating,
} from '../../src/shared/practice';

type Account = 'alice' | 'bob';
type Records = {
  sources: Map<string, PracticeSource>;
  items: Map<string, PracticeQueueItem>;
  history: Map<string, PracticeReflection[]>;
};

/** Protocol fixture only. The real backend has separate scheduling and ownership tests. */
export function accountQueueFixture() {
  const names = [
    'get_practice_queue',
    'get_practice_review',
    'list_practice_sources',
    'add_practice_review',
    'record_practice_reflection',
    'list_practice_reflections',
    'reschedule_practice_review',
    'pause_practice_review',
  ];
  const accounts = new Map<Account, Records>();
  const records = (account: Account) => {
    let value = accounts.get(account);
    if (!value) {
      value = { sources: new Map(), items: new Map(), history: new Map() };
      accounts.set(account, value);
    }
    return value;
  };
  const due = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
  const version = (item: PracticeQueueItem, expected: unknown) => {
    if (expected !== item.version) throw new Error('Practice queue item changed.');
  };
  return {
    names,
    register(account: Account, source: PracticeSource) {
      const current = records(account).sources.get(source.id);
      records(account).sources.set(source.id, { ...source, queued_id: current?.queued_id ?? null });
    },
    call(account: Account, name: string, args: Record<string, unknown>): unknown {
      const current = records(account);
      if (name === 'list_practice_sources') return [...current.sources.values()];
      if (name === 'get_practice_queue') return [...current.items.values()];
      if (name === 'add_practice_review') {
        const source = current.sources.get(String(args.source_id));
        if (!source || source.kind !== args.kind) throw new Error('Practice source not found.');
        if (source.queued_id) return current.items.get(source.queued_id);
        const item: PracticeQueueItem = {
          id: randomUUID(),
          source_kind: source.kind,
          source_id: source.id,
          problem_id: source.problem_id,
          problem_revision: source.problem_revision,
          title: source.title,
          recall_prompts: ['Explain the saved approach in your own words.'],
          due_at: due(Number(args.days_ahead)),
          paused: false,
          interval_days: 1,
          version: 0,
          last_reviewed_at: null,
          review_count: 0,
        };
        source.queued_id = item.id;
        current.items.set(item.id, item);
        current.history.set(item.id, []);
        return item;
      }
      const item = current.items.get(String(args.item_id));
      if (!item) throw new Error('Practice queue item not found.');
      if (name === 'get_practice_review') return item;
      const history = current.history.get(item.id)!;
      if (name === 'list_practice_reflections') return [...history].reverse();
      if (name === 'pause_practice_review' || name === 'reschedule_practice_review') {
        version(item, args.expected_version);
        if (name === 'pause_practice_review') item.paused = Boolean(args.paused);
        else item.due_at = due(Number(args.days_ahead));
        item.version++;
        return item;
      }
      if (name !== 'record_practice_reflection')
        throw new Error('Fixture operation not available.');
      const evidence = {
        answer: String(args.answer).trim(),
        takeaway: String(args.takeaway).trim(),
        next_action: String(args.next_action).trim(),
        self_rating: args.self_rating as SelfRating,
      };
      const existing = [...current.history.values()]
        .flat()
        .find((value) => value.id === args.reflection_id);
      if (existing) {
        if (
          existing.item_id !== item.id ||
          Object.entries(evidence).some(
            ([key, value]) => existing[key as keyof typeof evidence] !== value,
          )
        )
          throw new Error('A reflection is immutable.');
        return existing;
      }
      version(item, args.expected_version);
      if (item.paused || !evidence.answer)
        throw new Error('A recall answer and active reminder are necessary.');
      const interval =
        evidence.self_rating === 'needs_work'
          ? 1
          : evidence.self_rating === 'with_effort'
            ? Math.min(3, item.interval_days)
            : ([1, 3, 7, 14, 30].find((days) => days > item.interval_days) ?? 30);
      const timestamp = new Date().toISOString();
      const reflection: PracticeReflection = {
        id: String(args.reflection_id),
        item_id: item.id,
        ...evidence,
        interval_days: interval,
        next_due_at: due(interval),
        created_at: timestamp,
      };
      history.push(reflection);
      Object.assign(item, {
        interval_days: interval,
        due_at: reflection.next_due_at,
        last_reviewed_at: timestamp,
        review_count: history.length,
        version: item.version + 1,
      });
      return reflection;
    },
  };
}
