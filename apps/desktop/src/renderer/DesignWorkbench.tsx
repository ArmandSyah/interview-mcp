import './canvas-setup';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Excalidraw,
  MainMenu,
  convertToExcalidrawElements,
  exportToBlob,
} from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type {
  ExcalidrawImperativeAPI,
  AppState,
  BinaryFiles,
  ExcalidrawInitialDataState,
} from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { Settings2, Sparkles, Send, Square, X } from 'lucide-react';
import { Markdown } from './Markdown';
import { SettingsDialog } from './Settings';
import { DraftWriter } from './draft-writer';
import { useActions } from './actions';
import { ChatMessage } from './App';
import {
  MAX_DIAGRAM_LABEL_CHARACTERS,
  designEvidenceChanged,
  noteSections,
  type DesignCheckpoint,
  type DesignDraft,
  type DesignScene,
} from '../shared/design';
import type { Snapshot } from '../shared/types';

const palette = [
  'Client',
  'Service',
  'Database',
  'Cache',
  'Queue',
  'Worker',
  'Object storage',
] as const;
type Props = {
  snapshot: Snapshot;
  registerFlush: (flush: () => Promise<void>) => () => void;
  switchMode: () => void;
  openQueue: () => void;
  clearError: () => void;
};
function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : 'Operation failed').replace(
    /^Error invoking remote method '[^']+': Error: /,
    '',
  );
}
function sceneData(
  elements: readonly ExcalidrawElement[],
  state: AppState,
  files: BinaryFiles,
): DesignScene {
  return {
    elements: elements.map((element) => ({
      ...element,
      link: null,
    })) as unknown as DesignScene['elements'],
    appState: {
      viewBackgroundColor: state.viewBackgroundColor,
      scrollX: state.scrollX,
      scrollY: state.scrollY,
      zoom: { value: state.zoom.value },
    },
    files: structuredClone(files) as unknown as DesignScene['files'],
  };
}

export function DesignWorkbench({
  snapshot,
  registerFlush,
  switchMode,
  openQueue,
  clearError,
}: Props) {
  const actions = useActions();
  const busy = actions.busy || snapshot.busy;
  const session = snapshot.designSessions.find(
    (item) => item.id === snapshot.activeDesignSessionId,
  );
  const [draft, setDraft] = useState<DesignDraft | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('Saved locally');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tab, setTab] = useState<'notes' | 'review' | 'coach'>('notes');
  const [message, setMessage] = useState('');
  const [history, setHistory] = useState<DesignCheckpoint[] | null>(null);
  const [running, setRunning] = useState(false);
  const [dirty, setDirty] = useState(false);
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const latest = useRef<DesignDraft | null>(null);
  const activeId = useRef<string | null>(null);
  const drafts = useRef(
    new DraftWriter<DesignDraft>((id, draft) => window.interview.saveDesignDraft(id, draft)),
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    try {
      await drafts.current.flush();
      if (!drafts.current.dirty) {
        setSaved('Saved locally');
        setDirty(false);
      }
    } catch (error) {
      setSaved('Save failed');
      setError(errorText(error));
      throw error;
    }
  }, []);
  useEffect(() => registerFlush(flush), [flush, registerFlush]);
  useEffect(() => {
    let live = true;
    activeId.current = session?.id ?? null;
    latest.current = null;
    api.current = null;
    setDraft(null);
    setRunning(false);
    setHistory(null);
    setDirty(false);
    if (session)
      void window.interview
        .loadDesignDraft(session.id)
        .then((value) => {
          if (!live) return;
          latest.current = value;
          setDraft(value);
          setSaved('Saved locally');
          setError('');
        })
        .catch((error) => {
          if (live) setError(errorText(error));
        });
    return () => {
      live = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [session?.id]);
  const change = useCallback(
    (value: DesignDraft) => {
      const id = activeId.current;
      if (!id) return;
      if (latest.current && designEvidenceChanged(latest.current, value)) setDirty(true);
      latest.current = value;
      setDraft(value);
      drafts.current.set(id, value);
      setSaved('Saving…');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        void flush().catch(() => {});
      }, 600);
    },
    [flush],
  );
  useEffect(() => {
    if (!running) return;
    const tick = setInterval(() => {
      if (latest.current)
        change({ ...latest.current, elapsedSeconds: latest.current.elapsedSeconds + 1 });
    }, 1000);
    return () => clearInterval(tick);
  }, [running, change]);
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [session?.chat.at(-1)?.text]);

  async function action(operation: () => Promise<unknown>) {
    if (snapshot.busy) return;
    try {
      await actions.run(async () => {
        setError('');
        clearError();
        await flush();
        await operation();
      });
    } catch (error) {
      setError(errorText(error));
    }
  }
  function addComponent(kind: (typeof palette)[number]) {
    if (!api.current || !draft) return;
    const state = api.current.getAppState();
    const count = api.current
      .getSceneElements()
      .filter((element) => element.type !== 'text').length;
    const columns = Math.max(1, Math.floor(state.width / state.zoom.value / 200));
    const x = -state.scrollX + 70 + (count % columns) * 190;
    const y = -state.scrollY + 100 + Math.floor(count / columns) * 110;
    const elements = convertToExcalidrawElements([
      {
        type: kind === 'Database' || kind === 'Cache' ? 'ellipse' : 'rectangle',
        x,
        y,
        width: 160,
        height: 70,
        backgroundColor: '#e8e0ff',
        strokeColor: '#6741a5',
        customData: { componentKind: kind.toLowerCase().replaceAll(' ', '_') },
        label: { text: kind, fontSize: 18, fontFamily: 5 },
      },
    ]);
    api.current.updateScene({ elements: [...api.current.getSceneElements(), ...elements] });
  }
  async function exportDesign(format: 'excalidraw' | 'workspace' | 'png') {
    if (format !== 'png') {
      await window.interview.exportDesign(format);
      return;
    }
    if (!api.current) throw new Error('Canvas is not ready');
    const blob = await exportToBlob({
      elements: api.current.getSceneElements(),
      appState: { ...api.current.getAppState(), exportBackground: true },
      files: api.current.getFiles(),
      mimeType: 'image/png',
    });
    await window.interview.exportDesign('png', new Uint8Array(await blob.arrayBuffer()));
  }
  const stale = !!session?.review && (dirty || session.review.scene_digest !== session.draftDigest);
  const locked = session?.status === 'completed';
  const ready = !!session && !!draft;
  const shortenedLabels = draft?.scene.elements.some(
    (element) =>
      !element.isDeleted &&
      typeof element.text === 'string' &&
      element.text.length > MAX_DIAGRAM_LABEL_CHARACTERS,
  );
  const remaining = Math.max(
    0,
    (session?.brief.time_budget_minutes ?? 40) * 60 - (draft?.elapsedSeconds ?? 0),
  );
  const duration = `${Math.floor(remaining / 60)
    .toString()
    .padStart(2, '0')}:${(remaining % 60).toString().padStart(2, '0')}`;

  return (
    <div className="app-shell design-shell">
      <header className="topbar">
        <div className="brand">
          INTERVIEW<span className="brand-light"> WORKBENCH</span>
          <span className="local-badge">LOCAL FIRST</span>
        </div>
        <div className="mode-switch">
          <button className="secondary small" disabled={busy} onClick={openQueue}>
            Practice queue
          </button>
          <button className="secondary small" disabled={busy} onClick={switchMode}>
            Coding
          </button>
          <button className="primary small" aria-pressed="true">
            System design
          </button>
        </div>
        <button
          className="icon-button"
          aria-label="Open settings"
          disabled={busy}
          onClick={() => setSettingsOpen(true)}
        >
          <Settings2 size={18} />
        </button>
      </header>
      <div className="design-layout">
        <aside className="design-brief">
          <div className="section-heading">
            SYSTEM-DESIGN BRIEFS <span className="count">{snapshot.designProblems.length}</span>
          </div>
          <div className="design-catalog">
            {snapshot.designProblems.map((problem) => (
              <button
                key={problem.id}
                className={`problem-card ${session?.problem_id === problem.id ? 'active' : ''}`}
                disabled={busy}
                onClick={() => void action(() => window.interview.startDesign(problem.id))}
              >
                <span className="problem-title">{problem.title}</span>
                <span className={`difficulty ${problem.difficulty}`}>
                  {problem.difficulty} · {problem.time_budget_minutes} min
                </span>
              </button>
            ))}
          </div>
          {!session && (
            <p className="empty-small">
              Choose an original brief. Draw and reason offline—no Docker or model required.
            </p>
          )}
          {session && (
            <div className="design-requirements">
              <h2>{session.brief.title}</h2>
              <Markdown text={session.brief.brief_md} />
              <h3>Requirements</h3>
              <ul>
                {session.brief.requirements.map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
              <h3>Constraints</h3>
              <ul>
                {session.brief.constraints.map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
              <details>
                <summary>Changed requirements & failure scenarios</summary>
                <ul>
                  {session.brief.scenarios.map((text) => (
                    <li key={text}>{text}</li>
                  ))}
                </ul>
              </details>
              <p className="tiny muted">
                Brief revision {session.brief.revision.slice(0, 10)} · pinned to this attempt
              </p>
              <button
                className="secondary small"
                disabled={busy}
                onClick={() =>
                  void action(() => window.interview.startDesign(session.problem_id, true))
                }
              >
                New attempt
              </button>
            </div>
          )}
          {!!snapshot.designSessions.length && (
            <details className="design-attempts">
              <summary>Saved attempts ({snapshot.designSessions.length})</summary>
              {[...snapshot.designSessions].reverse().map((item) => (
                <button
                  className="secondary small"
                  key={item.id}
                  disabled={busy}
                  onClick={() => void action(() => window.interview.activateDesign(item.id))}
                >
                  {item.brief.title} · {item.status === 'completed' ? 'finished' : 'draft'} ·{' '}
                  {new Date(item.started_at).toLocaleDateString()}
                </button>
              ))}
            </details>
          )}
        </aside>
        <main className="design-canvas-column">
          <div className="design-toolbar">
            <span>Offline canvas</span>
            {ready && (
              <>
                <select
                  aria-label="Practice mode"
                  value={draft.practiceMode}
                  disabled={busy || locked}
                  onChange={(event) =>
                    change({
                      ...draft,
                      practiceMode: event.target.value as DesignDraft['practiceMode'],
                    })
                  }
                >
                  <option value="guided">Guided</option>
                  <option value="mock">Mock</option>
                </select>
                <button
                  className="secondary small"
                  disabled={locked}
                  aria-label={running ? 'Pause timer' : 'Start timer'}
                  onClick={() => setRunning(!running)}
                >
                  {duration} · {running ? 'Pause' : 'Start'}
                </button>
                <button
                  className="secondary small"
                  disabled={busy || locked}
                  onClick={() => void action(() => window.interview.checkpointDesign())}
                >
                  Checkpoint
                </button>
                <button
                  className="secondary small"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => setHistory(await window.interview.designCheckpoints()))
                  }
                >
                  History
                </button>
                <select
                  aria-label="Export design"
                  value=""
                  disabled={busy}
                  onChange={(event) => {
                    const format = event.target.value as 'excalidraw' | 'workspace' | 'png';
                    if (format) void action(() => exportDesign(format));
                  }}
                >
                  <option value="">Export…</option>
                  <option value="excalidraw">Excalidraw file</option>
                  <option value="workspace">Canvas & notes</option>
                  <option value="png">PNG image</option>
                </select>
              </>
            )}
          </div>
          {ready && (
            <div className="design-palette" aria-label="Architecture components">
              {palette.map((kind) => (
                <button
                  className="secondary small"
                  key={kind}
                  disabled={locked}
                  onClick={() => addComponent(kind)}
                >
                  + {kind}
                </button>
              ))}
            </div>
          )}
          <div className="design-canvas" data-testid="design-canvas">
            {ready ? (
              <Excalidraw
                key={session.id}
                excalidrawAPI={(value) => {
                  api.current = value;
                }}
                initialData={draft.scene as unknown as ExcalidrawInitialDataState}
                onChange={(elements, state, files) => {
                  if (locked || !latest.current) return;
                  const scene = sceneData(elements, state, files);
                  if (JSON.stringify(scene) !== JSON.stringify(latest.current.scene))
                    change({ ...latest.current, scene });
                }}
                viewModeEnabled={locked}
                theme="light"
                handleKeyboardGlobally={false}
                validateEmbeddable={false}
                onLinkOpen={(_element, event) => event.preventDefault()}
                UIOptions={{
                  canvasActions: {
                    loadScene: false,
                    saveToActiveFile: false,
                    saveAsImage: false,
                    export: false,
                    toggleTheme: false,
                  },
                }}
              >
                <MainMenu>
                  <MainMenu.DefaultItems.ClearCanvas />
                </MainMenu>
              </Excalidraw>
            ) : (
              <div className="design-empty">
                <Sparkles size={28} />
                <h1>Make your reasoning visible.</h1>
                <p>Choose a brief, sketch your architecture, and explain the tradeoffs.</p>
                {session && !error && <p>Loading saved canvas…</p>}
              </div>
            )}
          </div>
        </main>
        <aside className="design-notes-panel">
          <div className="design-panel-tabs">
            {(['notes', 'review', 'coach'] as const).map((value) => (
              <button
                className={tab === value ? 'active' : ''}
                key={value}
                onClick={() => setTab(value)}
              >
                {value}
              </button>
            ))}
          </div>
          {tab === 'notes' && (
            <div className="design-notes">
              {ready ? (
                noteSections.map(({ key, title }) => (
                  <label key={key}>
                    {title}
                    <textarea
                      aria-label={title}
                      value={draft.notes[key]}
                      maxLength={5000}
                      disabled={locked}
                      placeholder={session.brief.rubric.find((item) => item.key === key)?.prompt}
                      onChange={(event) =>
                        change({ ...draft, notes: { ...draft.notes, [key]: event.target.value } })
                      }
                    />
                  </label>
                ))
              ) : (
                <p className="empty-small">
                  Your requirements, decisions and failure-mode notes live here.
                </p>
              )}
            </div>
          )}
          {tab === 'review' && (
            <div className="design-review">
              <h2>Discussion coverage</h2>
              <p className="muted">
                A reflection checklist, not a correctness score or hiring grade.
              </p>
              {session?.review ? (
                <>
                  {stale && (
                    <p className="design-warning">
                      Older checkpoint—review again after your edits.
                    </p>
                  )}
                  <p>{session.review.summary}</p>
                  {session.review.items.map((item) => (
                    <section key={item.key}>
                      <h3>
                        {item.title}{' '}
                        <span className={`review-status ${item.status}`}>
                          {item.status.replaceAll('_', ' ')}
                        </span>
                      </h3>
                      <p>{item.question}</p>
                      {item.evidence && <blockquote>{item.evidence}</blockquote>}
                    </section>
                  ))}
                  <p className="tiny muted">{session.review.limitations}</p>
                </>
              ) : (
                <p>Save a review checkpoint when you want to reflect on your explanations.</p>
              )}
              <button
                className="primary small"
                disabled={!ready || busy || locked}
                onClick={() => void action(() => window.interview.reviewDesign())}
              >
                Review checkpoint
              </button>
              <button
                className="secondary small"
                disabled={!session?.review || stale || busy || locked}
                onClick={() =>
                  void action(async () => {
                    setRunning(false);
                    await window.interview.finishDesign();
                  })
                }
              >
                {locked ? 'Session finished' : 'Finish practice'}
              </button>
            </div>
          )}
          {tab === 'coach' && (
            <>
              <div className="coach-mode">
                {snapshot.settings.provider === 'disabled'
                  ? 'AI OFF · CURATED HINTS AVAILABLE'
                  : 'OPTIONAL AI · READ-ONLY CHECKPOINT CONTEXT'}
              </div>
              {shortenedLabels && (
                <p className="design-warning">
                  Long labels are shortened and marked in checkpoint/coach summaries. Full text
                  stays in your canvas and exports; the coach cannot read text inside images.
                </p>
              )}
              <div className="chat-history">
                {!session?.chat.length && (
                  <div className="coach-welcome">
                    <h3>A coach, not an architect for you.</h3>
                    <p>
                      Ask a focused question. The coach reads an immutable checkpoint and cannot
                      change your canvas or finish your session.
                    </p>
                  </div>
                )}
                {session?.chat.map((item) => (
                  <ChatMessage item={item} key={item.id} />
                ))}
                <div ref={chatEnd} />
              </div>
              <div className="chat-composer">
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (message.trim())
                      void action(async () => {
                        const text = message;
                        setMessage('');
                        try {
                          await window.interview.chat(text);
                        } catch (error) {
                          setMessage((current) => current || text);
                          throw error;
                        }
                      });
                  }}
                >
                  <textarea
                    aria-label="Message the design coach"
                    value={message}
                    maxLength={8000}
                    disabled={!ready || locked || snapshot.settings.provider === 'disabled'}
                    placeholder="Ask one focused question…"
                    onChange={(event) => setMessage(event.target.value)}
                  />
                  <div className="composer-footer">
                    <span>Checkpoint attached on send</span>
                    {snapshot.busy ? (
                      <button
                        type="button"
                        className="send-button stop"
                        aria-label="Stop coach"
                        onClick={() => void window.interview.cancelChat()}
                      >
                        <Square size={13} />
                      </button>
                    ) : (
                      <button
                        className="send-button"
                        aria-label="Send design message"
                        disabled={
                          busy ||
                          !message.trim() ||
                          !ready ||
                          locked ||
                          snapshot.settings.provider === 'disabled'
                        }
                      >
                        <Send size={14} />
                      </button>
                    )}
                  </div>
                </form>
              </div>
            </>
          )}
          <div className="design-panel-actions">
            <button
              className="secondary small"
              disabled={!ready || busy || locked || draft?.practiceMode === 'mock'}
              onClick={() =>
                void action(async () => {
                  setTab('coach');
                  await window.interview.designHint();
                })
              }
            >
              One curated hint
            </button>
            <button
              className="primary small"
              disabled={!ready || busy || locked}
              onClick={() =>
                void action(async () => {
                  await window.interview.reviewDesign();
                  setTab('review');
                })
              }
            >
              Review
            </button>
          </div>
        </aside>
      </div>
      {(error || snapshot.error) && (
        <div className="error-bar" role="alert">
          <span>{error || snapshot.error}</span>
          <button
            className="secondary small"
            disabled={busy}
            onClick={() => void action(() => window.interview.reconnect())}
          >
            Reconnect
          </button>
        </div>
      )}
      <footer className="statusbar">
        <span>
          {snapshot.connection === 'connected'
            ? `MCP connected · ${snapshot.designProblems.length} design briefs`
            : 'MCP disconnected'}
        </span>
        <span>
          {session ? (locked ? 'Finished · read only' : saved) : 'Ready'} · Images stored locally ·
          No hosting bill
        </span>
      </footer>
      {settingsOpen && (
        <SettingsDialog
          settings={snapshot.settings}
          beforeAction={flush}
          onClose={() => setSettingsOpen(false)}
          onSave={async (settings) => {
            await flush();
            await window.interview.updateSettings(settings);
          }}
        />
      )}
      {history && (
        <div className="modal-backdrop">
          <section
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Design checkpoint history"
          >
            <header>
              <h2>Immutable checkpoints</h2>
              <button
                className="icon-button"
                aria-label="Close history"
                disabled={busy}
                onClick={() => setHistory(null)}
              >
                <X size={18} />
              </button>
            </header>
            {!history.length && <p>No checkpoints yet.</p>}
            {history.map((item) => (
              <div className="design-history-item" key={item.id}>
                <span>
                  {item.label} · {new Date(item.created_at).toLocaleString()}
                </span>
                <button
                  className="secondary small"
                  disabled={busy || locked}
                  onClick={() =>
                    void action(async () => {
                      const value = await window.interview.restoreDesignCheckpoint(item.id);
                      latest.current = value;
                      setDraft(value);
                      api.current?.updateScene({
                        elements: value.scene.elements as unknown as readonly ExcalidrawElement[],
                        appState: { ...api.current.getAppState(), ...value.scene.appState },
                      });
                      if (Object.keys(value.scene.files).length)
                        api.current?.addFiles(
                          Object.values(value.scene.files) as unknown as Parameters<
                            ExcalidrawImperativeAPI['addFiles']
                          >[0],
                        );
                      setHistory(null);
                    })
                  }
                >
                  Restore
                </button>
              </div>
            ))}
          </section>
        </div>
      )}
    </div>
  );
}
