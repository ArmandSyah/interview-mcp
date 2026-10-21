import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { DraftWriter } from './draft-writer';
import { useActions } from './actions';
import { Modal } from './Modal';
import type { Snapshot } from '../shared/types';
import type {
  PracticeQueueItem,
  PracticeQueueState,
  PracticeReflection,
  ReflectionDraft,
  SelfRating,
} from '../shared/practice';

type Props = {
  snapshot: Snapshot;
  beforeAction: () => Promise<void>;
  registerFlush: (callback: () => Promise<void>) => () => void;
  onClose: () => void;
  returnFocus: HTMLElement | null;
};
const ratings: Record<SelfRating, string> = {
  needs_work: 'I need another pass',
  with_effort: 'I recalled it with effort',
  recalled: 'I recalled it clearly',
};
const clean = (error: unknown) =>
  (error instanceof Error ? error.message : 'Operation failed').replace(
    /^Error invoking remote method '[^']+': Error: /,
    '',
  );

export function PracticeQueueDialog({
  snapshot,
  beforeAction,
  registerFlush,
  onClose,
  returnFocus,
}: Props) {
  const actions = useActions();
  const [state, setState] = useState<PracticeQueueState | null>(null);
  const [filter, setFilter] = useState<'due' | 'upcoming' | 'paused'>('due');
  const [kind, setKind] = useState<'all' | 'coding' | 'design'>('all');
  const [source, setSource] = useState('');
  const [delay, setDelay] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<ReflectionDraft | null>(null);
  const [history, setHistory] = useState<PracticeReflection[]>([]);
  const [loading, setLoading] = useState(false);
  const busy = loading || actions.busy;
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [now, setNow] = useState(Date.now);
  const drafts = useRef(
    new DraftWriter<ReflectionDraft>((id, draft) =>
      window.interview.saveReflectionDraft(id, draft),
    ),
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const item = state?.items.find((value) => value.id === selected);
  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    const changed = drafts.current.dirty;
    if (changed) setSaved('Saving draft…');
    try {
      await drafts.current.flush();
      if (changed && !drafts.current.dirty) setSaved('Draft saved locally');
    } catch (error) {
      setSaved('Draft not saved');
      setError(clean(error));
      throw error;
    }
  }, []);
  useEffect(() => registerFlush(flush), [flush, registerFlush]);
  useEffect(() => {
    // Advance date filters without polling a remote engine or running a model.
    const clock = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(clock);
  }, []);
  useEffect(() => {
    let live = true;
    setLoading(true);
    void window.interview
      .practiceQueue()
      .then((value) => {
        if (live) {
          setState(value);
          setNow(Date.now());
        }
      })
      .catch((error) => {
        if (live) setError(clean(error));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  function change(next: ReflectionDraft) {
    if (!item) return;
    setDraft(next);
    drafts.current.set(item.id, next);
    setSaved('Unsaved draft');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void flush().catch(() => {});
    }, 400);
  }
  async function action(operation: () => Promise<void>) {
    if (loading) return;
    try {
      await actions.run(async () => {
        setError('');
        await beforeAction();
        await operation();
      });
    } catch (error) {
      setError(clean(error));
    }
  }
  async function reload() {
    const next = await window.interview.practiceQueue();
    setState(next);
    setNow(Date.now());
    return next;
  }
  async function review(value: PracticeQueueItem) {
    const [savedDraft, reflections] = await Promise.all([
      window.interview.loadReflectionDraft(value.id),
      window.interview.practiceReflections(value.id),
    ]);
    setSelected(value.id);
    setDraft(savedDraft);
    setHistory(reflections);
    setSaved(
      savedDraft.answer ? 'Draft saved locally' : 'Recall without opening your original work first',
    );
  }
  function updateItem(next: PracticeQueueItem) {
    setNow(Date.now());
    setState((value) =>
      value
        ? { ...value, items: value.items.map((old) => (old.id === next.id ? next : old)) }
        : value,
    );
    if (item?.id === next.id && draft) change({ ...draft, expected_version: next.version });
  }
  const canOpen =
    item?.source_kind === 'coding'
      ? snapshot.sessions.some((value) => value.attemptId === item.source_id)
      : snapshot.designSessions.some((value) => value.id === item?.source_id);
  const dueCount =
    state?.items.filter((value) => !value.paused && Date.parse(value.due_at) <= now).length ?? 0;
  const visible =
    state?.items.filter(
      (value) =>
        (kind === 'all' || value.source_kind === kind) &&
        (filter === 'paused'
          ? value.paused
          : !value.paused &&
            (filter === 'due' ? Date.parse(value.due_at) <= now : Date.parse(value.due_at) > now)),
    ) ?? [];
  return (
    <Modal
      className="settings-modal practice-queue-modal"
      aria-labelledby="practice-queue-title"
      onDismiss={() => void action(async () => onClose())}
      canDismiss={!busy}
      returnFocus={returnFocus}
    >
      <header>
        <div>
          <span className="eyebrow">RECALL, REASON, REFLECT</span>
          <h2 id="practice-queue-title">Practice queue</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Close practice queue"
          disabled={busy}
          onClick={() => void action(async () => onClose())}
        >
          <X size={19} />
        </button>
      </header>
      <div className="practice-queue-content">
        <p className="form-note">
          Your own reminders and self-ratings—not mastery scores or hiring grades. Plain-English
          recall is enough; AI is not required. Nothing is added automatically.
        </p>
        {!state && !error && <p role="status">Loading your queue…</p>}
        {state && !state.supported && (
          <p className="form-note">
            This connected engine does not support the practice queue yet. Use the current bundled
            local engine.
          </p>
        )}
        {state?.supported && (
          <>
            <fieldset>
              <legend>Add a saved attempt</legend>
              <label>
                Practice to revisit
                <select
                  value={source}
                  disabled={busy}
                  onChange={(event) => setSource(event.target.value)}
                >
                  <option value="">Choose one of your attempts</option>
                  {state.sources.map((value) => (
                    <option
                      key={`${value.kind}:${value.id}`}
                      value={`${value.kind}:${value.id}`}
                      disabled={!!value.queued_id}
                    >
                      {value.kind} · {value.title} ·{' '}
                      {new Date(value.started_at).toLocaleDateString()} · {value.status}
                      {value.queued_id ? ' · already queued' : ''}
                    </option>
                  ))}
                </select>
              </label>
              {!state.sources.length && (
                <p className="form-note">
                  Start a coding or design attempt first. Draft attempts can be queued too.
                </p>
              )}
              <label>
                Reminder delay (days)
                <input
                  type="number"
                  min={0}
                  max={365}
                  step={1}
                  value={delay}
                  disabled={busy}
                  onChange={(event) => setDelay(Number(event.target.value))}
                />
              </label>
              <p className="form-note">
                0 means due now. This delay also applies to the Move reminder buttons below.
              </p>
              <button
                type="button"
                className="secondary small"
                disabled={busy || !source || !Number.isInteger(delay) || delay < 0 || delay > 365}
                onClick={() =>
                  void action(async () => {
                    const value = state.sources.find(
                      (value) => `${value.kind}:${value.id}` === source,
                    );
                    if (!value) throw new Error('Choose a saved attempt');
                    await window.interview.addPracticeReview(value.kind, value.id, delay);
                    setSource('');
                    await reload();
                    setFilter(delay === 0 ? 'due' : 'upcoming');
                  })
                }
              >
                Add to queue
              </button>
            </fieldset>
            <div className="practice-queue-filters">
              <div role="group" aria-label="Queue date filter">
                {(['due', 'upcoming', 'paused'] as const).map((value) => (
                  <button
                    type="button"
                    key={value}
                    className={filter === value ? 'primary small' : 'secondary small'}
                    disabled={busy}
                    onClick={() => setFilter(value)}
                  >
                    {value === 'due'
                      ? `Due now (${dueCount})`
                      : value === 'upcoming'
                        ? 'Upcoming'
                        : 'Paused'}
                  </button>
                ))}
              </div>
              <label>
                Practice type
                <select
                  value={kind}
                  disabled={busy}
                  onChange={(event) => setKind(event.target.value as typeof kind)}
                >
                  <option value="all">Coding & design</option>
                  <option value="coding">Coding</option>
                  <option value="design">System design</option>
                </select>
              </label>
              <button
                type="button"
                className="secondary small"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await reload();
                  })
                }
              >
                Refresh queue
              </button>
            </div>
            <div className="practice-queue-list">
              {!visible.length && (
                <p className="form-note">
                  No{' '}
                  {filter === 'due'
                    ? 'due reviews'
                    : filter === 'paused'
                      ? 'paused reviews'
                      : 'upcoming reviews'}{' '}
                  in this filter. This is not a statement about mastery.
                </p>
              )}
              {visible.map((value) => (
                <article key={value.id} className="practice-queue-card">
                  <h3>{value.title}</h3>
                  <p className="tiny muted">
                    {value.source_kind} ·{' '}
                    {value.paused ? 'paused' : `due ${new Date(value.due_at).toLocaleString()}`} ·{' '}
                    {value.review_count} reflections · pinned revision{' '}
                    {value.problem_revision.slice(0, 10)}
                  </p>
                  <div className="distribution-actions">
                    <button
                      type="button"
                      className="secondary small"
                      disabled={busy}
                      onClick={() => void action(() => review(value))}
                    >
                      Recall & reflect
                    </button>
                    <button
                      type="button"
                      className="secondary small"
                      disabled={busy}
                      onClick={() =>
                        void action(async () =>
                          updateItem(
                            await window.interview.pausePracticeReview(
                              value.id,
                              !value.paused,
                              value.version,
                            ),
                          ),
                        )
                      }
                    >
                      {value.paused ? 'Resume reminder' : 'Pause reminder'}
                    </button>
                    <button
                      type="button"
                      className="secondary small"
                      disabled={busy || !Number.isInteger(delay) || delay < 0 || delay > 365}
                      onClick={() =>
                        void action(async () =>
                          updateItem(
                            await window.interview.reschedulePracticeReview(
                              value.id,
                              delay,
                              value.version,
                            ),
                          ),
                        )
                      }
                    >
                      Move reminder
                    </button>
                  </div>
                </article>
              ))}
            </div>
            {item && draft && (
              <fieldset className="practice-reflection-form">
                <legend>Recall: {item.title}</legend>
                <ol>
                  {item.recall_prompts.map((text) => (
                    <li key={text}>{text}</li>
                  ))}
                </ol>
                <label>
                  Your recall answer
                  <textarea
                    rows={5}
                    maxLength={8000}
                    value={draft.answer}
                    disabled={busy || item.paused}
                    onChange={(event) => change({ ...draft, answer: event.target.value })}
                  />
                </label>
                <label>
                  What needed help or surprised you?
                  <textarea
                    rows={2}
                    maxLength={2000}
                    value={draft.takeaway}
                    disabled={busy || item.paused}
                    onChange={(event) => change({ ...draft, takeaway: event.target.value })}
                  />
                </label>
                <label>
                  Next independent step
                  <textarea
                    rows={2}
                    maxLength={2000}
                    value={draft.next_action}
                    disabled={busy || item.paused}
                    onChange={(event) => change({ ...draft, next_action: event.target.value })}
                  />
                </label>
                <label>
                  Your self-rating
                  <select
                    value={draft.self_rating}
                    disabled={busy || item.paused}
                    onChange={(event) =>
                      change({ ...draft, self_rating: event.target.value as SelfRating })
                    }
                  >
                    {Object.entries(ratings).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="form-note">
                  Clear recall advances through 1, 3, 7, 14, and 30-day intervals. Another pass
                  resets to 1 day; effortful recall caps at 3. You can move or pause reminders
                  afterward. These are not validated performance predictions.
                </p>
                <p className="tiny muted" role="status">
                  {saved}
                </p>
                {draft.expected_version !== item.version && (
                  <div className="inline-error">
                    This reminder changed. Your draft was kept.
                    <button
                      type="button"
                      className="secondary small"
                      disabled={busy}
                      onClick={() => change({ ...draft, expected_version: item.version })}
                    >
                      Use refreshed schedule
                    </button>
                  </div>
                )}
                <div className="distribution-actions">
                  <button
                    type="button"
                    className="primary small"
                    disabled={
                      busy ||
                      item.paused ||
                      !draft.answer.trim() ||
                      draft.expected_version !== item.version
                    }
                    onClick={() =>
                      void action(async () => {
                        const result = await window.interview.recordPracticeReflection({
                          item_id: item.id,
                          ...draft,
                        });
                        const next = (await reload()).items.find((value) => value.id === item.id);
                        if (!next) throw new Error('Refresh the queue to see this item');
                        await review(next);
                        setSaved(
                          `Reflection saved. Next reminder: ${new Date(result.next_due_at).toLocaleString()}`,
                        );
                      })
                    }
                  >
                    Save reflection & next review
                  </button>
                  <button
                    type="button"
                    className="secondary small"
                    disabled={busy || !canOpen}
                    onClick={() =>
                      void action(async () => {
                        if (item.source_kind === 'coding') {
                          await window.interview.activateProblem(item.problem_id);
                          await window.interview.setMode('coding');
                        } else {
                          await window.interview.activateDesign(item.source_id);
                          await window.interview.setMode('design');
                        }
                        onClose();
                      })
                    }
                  >
                    Open saved practice
                  </button>
                </div>
                {!canOpen && (
                  <p className="form-note">
                    The original draft is not saved in this desktop workspace. You can still recall
                    this pinned attempt without substituting the current question revision.
                  </p>
                )}
                {item.paused && (
                  <p className="form-note">
                    Resume the reminder before recording recall. Existing reflections are kept.
                  </p>
                )}
                <details className="practice-reflection-history">
                  <summary>Recent reflection history ({history.length})</summary>
                  {history.map((value) => (
                    <article key={value.id}>
                      <h4>
                        {new Date(value.created_at).toLocaleString()} · {ratings[value.self_rating]}
                      </h4>
                      <p>{value.answer}</p>
                      {value.takeaway && <p>Reflection: {value.takeaway}</p>}
                      {value.next_action && <p>Next step: {value.next_action}</p>}
                    </article>
                  ))}
                </details>
              </fieldset>
            )}
          </>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
