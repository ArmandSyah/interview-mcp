import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowRight,
  BookOpen,
  Check,
  ChevronRight,
  Circle,
  Code2,
  Command,
  FileCode2,
  FolderOpen,
  Lightbulb,
  LoaderCircle,
  MessageSquare,
  Play,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  Trophy,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { CodeEditor } from './Editor';
import { Markdown } from './Markdown';
import { SettingsDialog } from './Settings';
import type { Approval, ChatItem, PracticeSession, Snapshot } from '../shared/types';

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : 'Operation failed').replace(
    /^Error invoking remote method '[^']+': Error: /,
    '',
  );
}
function updateChat(items: ChatItem[], item: ChatItem): ChatItem[] {
  const index = items.findIndex((existing) => existing.id === item.id);
  return index < 0
    ? [...items, item].slice(-200)
    : items.map((existing, i) => (i === index ? item : existing));
}

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [query, setQuery] = useState('');
  const [difficulty, setDifficulty] = useState('all');
  const [tab, setTab] = useState<'solution' | 'problem'>('solution');
  const [bottomTab, setBottomTab] = useState<'tests' | 'progress'>('tests');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [sidebar, setSidebar] = useState<'problems' | 'files'>('problems');
  const [chatWidth, setChatWidth] = useState(360);
  const [bottomHeight, setBottomHeight] = useState(220);
  const pending = useRef<{ id: string; code: string } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveQueue = useRef(Promise.resolve());
  const chatEnd = useRef<HTMLDivElement>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  const flush = useCallback(async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const value = pending.current;
    if (value) {
      pending.current = null;
      setSaveState('saving');
      saveQueue.current = saveQueue.current
        .catch(() => {})
        .then(() => window.interview.saveCode(value.id, value.code));
    }
    try {
      await saveQueue.current;
      if (!pending.current) setSaveState('saved');
    } catch (error) {
      if (value && !pending.current) pending.current = value;
      setSaveState('error');
      setError(cleanError(error));
      throw error;
    }
  }, []);

  useEffect(() => {
    let live = true;
    const unsubscribe = window.interview.onEvent((event) => {
      if (event.type === 'snapshot') {
        setSnapshot(() => {
          const next = event.snapshot;
          if (pending.current)
            next.sessions = next.sessions.map((session) =>
              session.problem.id === pending.current?.id
                ? { ...session, code: pending.current.code, resultStale: !!session.result }
                : session,
            );
          return next;
        });
      }
      if (event.type === 'chat')
        setSnapshot((current) =>
          current
            ? {
                ...current,
                welcomeChat: event.problemId
                  ? current.welcomeChat
                  : updateChat(current.welcomeChat, event.item),
                sessions: current.sessions.map((session) =>
                  session.problem.id === event.problemId
                    ? { ...session, chat: updateChat(session.chat, event.item) }
                    : session,
                ),
              }
            : current,
        );
      if (event.type === 'approval') setApproval(event.approval);
      if (event.type === 'agent-done') setApproval(null);
      if (event.type === 'flush-before-close') {
        void flush()
          .then(() => window.interview.closeReady(true))
          .catch(() => window.interview.closeReady(false));
      }
    });
    void window.interview.snapshot().then((value) => {
      if (live) setSnapshot((current) => current ?? value);
    });
    return () => {
      live = false;
      unsubscribe();
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [flush]);

  const active = snapshot?.sessions.find(
    (session) => session.problem.id === snapshot.activeProblemId,
  );
  const chat = active?.chat ?? snapshot?.welcomeChat ?? [];
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chat.at(-1)?.text, chat.length]);

  async function action(operation: () => Promise<unknown>) {
    setError('');
    try {
      await flush();
      await operation();
    } catch (error) {
      setError(cleanError(error));
    }
  }
  const run = () =>
    void action(async () => {
      setBottomTab('tests');
      await window.interview.runTests(false);
    });
  function edit(code: string) {
    const id = snapshotRef.current?.activeProblemId;
    if (!id) return;
    pending.current = { id, code };
    setSaveState('saving');
    setSnapshot((current) =>
      current
        ? {
            ...current,
            sessions: current.sessions.map((session) =>
              session.problem.id === id
                ? { ...session, code, resultStale: !!session.result }
                : session,
            ),
          }
        : current,
    );
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void flush().catch(() => {});
    }, 400);
  }
  async function send(event?: React.FormEvent, suggestion?: string) {
    event?.preventDefault();
    const text = suggestion ?? message;
    if (!text.trim() || snapshot?.busy) return;
    setMessage('');
    await action(() => window.interview.chat(text));
  }
  function resize(event: React.PointerEvent, target: 'chat' | 'bottom') {
    event.currentTarget.setPointerCapture(event.pointerId);
    const initial = target === 'chat' ? chatWidth : bottomHeight;
    const x = event.clientX;
    const y = event.clientY;
    const move = (next: PointerEvent) =>
      target === 'chat'
        ? setChatWidth(Math.max(280, Math.min(540, initial + x - next.clientX)))
        : setBottomHeight(Math.max(130, Math.min(450, initial + y - next.clientY)));
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
  }

  if (!snapshot)
    return (
      <div className="boot">
        <Code2 size={34} />
        <h1>Interview Workbench</h1>
        <p>Opening your workspace…</p>
        <LoaderCircle className="spin" size={20} />
      </div>
    );
  const connected = snapshot.connection === 'connected';
  const filtered = snapshot.problems.filter(
    (problem) =>
      (difficulty === 'all' || problem.difficulty === difficulty) &&
      `${problem.title} ${problem.tags.join(' ')} ${problem.id}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const completed = snapshot.sessions.filter((session) => session.submitted).length;
  const currentError = error || snapshot.error;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <Code2 size={18} />
          </div>
          <span>
            INTERVIEW<span className="brand-light"> WORKBENCH</span>
          </span>
          <span className="local-badge">LOCAL FIRST</span>
        </div>
        <div className="topbar-center">
          <Command size={13} />
          <span>Your practice workspace</span>
        </div>
        <button
          className="icon-button"
          aria-label="Open settings"
          onClick={() => setSettingsOpen(true)}
          disabled={snapshot.busy}
        >
          <Settings2 size={18} />
        </button>
      </header>
      <div className="workbench">
        <nav className="activity-bar" aria-label="Workspace views">
          <button
            className={sidebar === 'problems' ? 'selected' : ''}
            aria-label="Problem explorer"
            onClick={() => setSidebar('problems')}
          >
            <BookOpen size={23} />
          </button>
          <button
            className={sidebar === 'files' ? 'selected' : ''}
            aria-label="Files explorer"
            onClick={() => setSidebar('files')}
          >
            <FolderOpen size={23} />
          </button>
          <button aria-label="Show progress" onClick={() => setBottomTab('progress')}>
            <Trophy size={22} />
          </button>
          <div className="activity-spacer" />
          <button
            aria-label="Settings"
            onClick={() => setSettingsOpen(true)}
            disabled={snapshot.busy}
          >
            <Settings2 size={22} />
          </button>
        </nav>
        <aside className="sidebar">
          <div className="section-heading">
            <span>{sidebar === 'problems' ? 'PROBLEM EXPLORER' : 'YOUR WORKSPACE'}</span>
            <span className="count">
              {sidebar === 'problems' ? snapshot.problems.length : snapshot.sessions.length}
            </span>
          </div>
          {sidebar === 'problems' ? (
            <>
              <label className="search-field">
                <Search size={14} />
                <input
                  aria-label="Search problems"
                  placeholder="Search problems or patterns"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <kbd>⌕</kbd>
              </label>
              <div className="difficulty-filters">
                {['all', 'easy', 'medium', 'hard'].map((value) => (
                  <button
                    key={value}
                    className={difficulty === value ? 'active' : ''}
                    onClick={() => setDifficulty(value)}
                  >
                    {value}
                  </button>
                ))}
              </div>
              <div className="problem-list">
                {filtered.map((problem, index) => {
                  const session = snapshot.sessions.find((item) => item.problem.id === problem.id);
                  return (
                    <button
                      key={problem.id}
                      className={`problem-card ${active?.problem.id === problem.id ? 'active' : ''}`}
                      disabled={snapshot.busy}
                      onClick={() =>
                        void action(async () => {
                          setTab('solution');
                          await window.interview.startProblem(problem.id);
                        })
                      }
                    >
                      <div className="problem-card-top">
                        <span className="problem-number">{String(index + 1).padStart(2, '0')}</span>
                        <span className={`difficulty ${problem.difficulty}`}>
                          {problem.difficulty}
                        </span>
                        {session?.submitted ? (
                          <Check size={13} className="success" />
                        ) : session ? (
                          <Circle size={9} className="in-progress" />
                        ) : null}
                      </div>
                      <span className="problem-title">{problem.title}</span>
                      <span className="problem-pattern">
                        {problem.pattern_tags[0] || problem.tags.slice(0, 2).join(' · ')}
                      </span>
                    </button>
                  );
                })}
                {!filtered.length && (
                  <p className="empty-small">
                    {connected
                      ? 'No matching problems.'
                      : 'Connect to your interview MCP to load problems.'}
                  </p>
                )}
              </div>
            </>
          ) : (
            <div className="file-tree">
              {snapshot.sessions.map((session) => (
                <div key={session.problem.id}>
                  <button
                    className={`folder-row ${session.problem.id === active?.problem.id ? 'active' : ''}`}
                    disabled={snapshot.busy}
                    onClick={() =>
                      void action(() => window.interview.activateProblem(session.problem.id))
                    }
                  >
                    <ChevronRight size={13} />
                    <FolderOpen size={15} />
                    <span>{session.problem.title}</span>
                  </button>
                  {session.problem.id === active?.problem.id && (
                    <>
                      <button
                        className={`file-row ${tab === 'solution' ? 'active' : ''}`}
                        onClick={() => setTab('solution')}
                      >
                        <FileCode2 size={15} />
                        <span>solution.py</span>
                      </button>
                      <button
                        className={`file-row ${tab === 'problem' ? 'active' : ''}`}
                        onClick={() => setTab('problem')}
                      >
                        <BookOpen size={15} />
                        <span>problem.md</span>
                      </button>
                    </>
                  )}
                </div>
              ))}
              {!snapshot.sessions.length && (
                <p className="empty-small">Open a problem to create a practice workspace.</p>
              )}
            </div>
          )}
          <div className="sidebar-bottom">
            <div>
              <Trophy size={15} />
              <span>{completed} completed</span>
              <span className="muted">/ {snapshot.sessions.length} started</span>
            </div>
            <div className="progress-track">
              <div
                style={{
                  width: `${snapshot.sessions.length ? (completed / snapshot.sessions.length) * 100 : 0}%`,
                }}
              />
            </div>
            <span className="tiny">PROGRESS SAVED ON THIS DEVICE</span>
          </div>
        </aside>
        <main className="editor-column">
          <div className="file-tabs">
            {active ? (
              <>
                <button
                  className={tab === 'solution' ? 'active' : ''}
                  onClick={() => setTab('solution')}
                >
                  <FileCode2 size={14} className="python-icon" /> solution.py{' '}
                  {saveState !== 'saved' && <Circle size={7} fill="currentColor" />}
                </button>
                <button
                  className={tab === 'problem' ? 'active' : ''}
                  onClick={() => setTab('problem')}
                >
                  <BookOpen size={13} /> problem.md
                </button>
              </>
            ) : (
              <span className="untitled">Welcome to your workbench</span>
            )}
            <div className="tab-spacer" />
            {active && (
              <button
                className="export-button"
                title="Export solution"
                aria-label="Export solution"
                onClick={() => void action(() => window.interview.exportSolution())}
              >
                <ArrowDownToLine size={15} />
              </button>
            )}
          </div>
          {active ? (
            <>
              <div className="editor-toolbar">
                <div className="breadcrumb">
                  <span>practice</span>
                  <ChevronRight size={12} />
                  <span title={active.problem.id}>{active.problem.title}</span>
                  <ChevronRight size={12} />
                  <span>{tab === 'solution' ? 'solution.py' : 'problem.md'}</span>
                </div>
                <div className="toolbar-actions">
                  <button
                    className="secondary small"
                    onClick={() => void action(() => window.interview.hint())}
                    disabled={snapshot.busy || !connected}
                  >
                    <Lightbulb size={13} /> Hint
                  </button>
                  <button
                    className="secondary small"
                    onClick={run}
                    disabled={snapshot.busy || !connected}
                  >
                    <Play size={13} /> Run tests
                  </button>
                  <button
                    className="primary small"
                    onClick={() =>
                      void action(async () => {
                        setBottomTab('tests');
                        await window.interview.runTests(true);
                      })
                    }
                    disabled={snapshot.busy || !connected}
                  >
                    <Check size={13} /> Submit
                  </button>
                </div>
              </div>
              <div className="editor-area">
                {tab === 'solution' ? (
                  <CodeEditor
                    id={active.problem.id}
                    code={active.code}
                    onChange={edit}
                    onRun={run}
                    onSave={() => void flush().catch(() => {})}
                  />
                ) : (
                  <article className="problem-description">
                    <div className="description-meta">
                      <span className={`difficulty ${active.problem.difficulty}`}>
                        {active.problem.difficulty}
                      </span>
                      {active.problem.tags.map((tag) => (
                        <span className="tag" key={tag}>
                          {tag}
                        </span>
                      ))}
                    </div>
                    <Markdown text={active.description} />
                  </article>
                )}
              </div>
            </>
          ) : (
            <div className="welcome">
              <div className="welcome-symbol">
                <Code2 size={38} strokeWidth={1.5} />
              </div>
              <span className="eyebrow">THINK. BUILD. UNDERSTAND.</span>
              <h1>
                Your next interview
                <br />
                starts here.
              </h1>
              <p>
                A focused coding workspace with a coach that helps you reason through the
                problem—not solve it for you.
              </p>
              <div className="welcome-steps">
                <div>
                  <span>01</span>
                  <BookOpen size={16} />
                  <p>Choose a problem from the explorer</p>
                </div>
                <div>
                  <span>02</span>
                  <FileCode2 size={16} />
                  <p>Write your solution in the editor</p>
                </div>
                <div>
                  <span>03</span>
                  <Sparkles size={16} />
                  <p>Get a nudge, test, and refine</p>
                </div>
              </div>
              {!connected && (
                <button className="primary" onClick={() => setSettingsOpen(true)}>
                  Connect your MCP <ArrowRight size={15} />
                </button>
              )}
              <div className="welcome-foot">
                <ShieldCheck size={13} /> Local files. Your models. No hosting subscription.
              </div>
            </div>
          )}
          <div
            className="resize-horizontal"
            role="separator"
            aria-label="Resize results panel"
            onPointerDown={(event) => resize(event, 'bottom')}
          />
          <section className="results-panel" style={{ height: bottomHeight }}>
            <div className="results-tabs">
              <button
                className={bottomTab === 'tests' ? 'active' : ''}
                onClick={() => setBottomTab('tests')}
              >
                <Terminal size={13} /> TEST RESULTS
                {active?.result && (
                  <span
                    className={active.result.all_passed ? 'result-pill success' : 'result-pill'}
                  >
                    {active.result.tests_passed}/{active.result.tests_total}
                  </span>
                )}
              </button>
              <button
                className={bottomTab === 'progress' ? 'active' : ''}
                onClick={() => setBottomTab('progress')}
              >
                <Trophy size={13} /> PROGRESS
              </button>
              <span className="results-shortcut">⌘ / Ctrl + Enter to test</span>
            </div>
            <div className="results-body">
              {bottomTab === 'progress' ? (
                <Markdown text={snapshot.progress || 'Your attempts will appear here.'} />
              ) : (
                <TestResults session={active} busy={snapshot.busy} />
              )}
            </div>
          </section>
        </main>
        <div
          className="resize-vertical"
          role="separator"
          aria-label="Resize coach panel"
          onPointerDown={(event) => resize(event, 'chat')}
        />
        <aside className="coach-panel" style={{ width: chatWidth }}>
          <header className="coach-heading">
            <div>
              <Sparkles size={17} />
              <h2>Interview coach</h2>
            </div>
            <button
              className="icon-button"
              aria-label="Clear conversation"
              disabled={snapshot.busy}
              onClick={() => void action(() => window.interview.clearChat())}
            >
              <Trash2 size={14} />
            </button>
          </header>
          <div className="coach-mode">
            <span
              className={`status-dot ${snapshot.settings.provider === 'disabled' ? '' : 'online'}`}
            />
            <span>
              {snapshot.settings.provider === 'disabled'
                ? 'CURATED HINTS · NO MODEL CONNECTED'
                : snapshot.settings.provider === 'ollama'
                  ? 'LOCAL OLLAMA · YOUR MACHINE'
                  : 'CLAUDE · YOUR API KEY'}
            </span>
          </div>
          <div className="chat-history">
            {!chat.length && (
              <div className="coach-welcome">
                <div className="coach-avatar">
                  <Sparkles size={22} />
                </div>
                <h3>
                  A thinking partner,
                  <br />
                  not an answer machine.
                </h3>
                <p>
                  Talk through your approach, ask a focused question, or explore a failing test.
                  Your current draft gives the coach context.
                </p>
                {snapshot.settings.provider === 'disabled' ? (
                  <>
                    <button className="suggestion" onClick={() => setSettingsOpen(true)}>
                      Connect a local or API model <ArrowRight size={13} />
                    </button>
                    <p className="tiny muted">The Hint button works without an AI model.</p>
                  </>
                ) : (
                  [
                    'Help me reason about an approach',
                    'Give me one small hint',
                    'Review my current draft',
                  ].map((suggestion) => (
                    <button
                      className="suggestion"
                      key={suggestion}
                      onClick={() => void send(undefined, suggestion)}
                      disabled={snapshot.busy}
                    >
                      {suggestion}
                      <ArrowRight size={13} />
                    </button>
                  ))
                )}
              </div>
            )}
            {chat.map((item) => (
              <ChatMessage key={item.id} item={item} />
            ))}
            {snapshot.busy && (
              <div className="thinking">
                <LoaderCircle size={13} className="spin" />
                <span>Working with your MCP…</span>
              </div>
            )}
            <div ref={chatEnd} />
          </div>
          <div className="chat-composer">
            <div className="context-chip">
              <FileCode2 size={12} />
              <span>
                {active ? 'solution.py attached to this turn' : 'Problem catalog available'}
              </span>
              <ShieldCheck size={11} />
            </div>
            <form onSubmit={(event) => void send(event)}>
              <textarea
                aria-label="Message the coach"
                placeholder={
                  snapshot.settings.provider === 'disabled'
                    ? 'Connect a model in settings to chat…'
                    : 'What are you thinking?'
                }
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                maxLength={8000}
                disabled={snapshot.settings.provider === 'disabled'}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="composer-footer">
                <span>Small hints. Your implementation.</span>
                {snapshot.busy ? (
                  <button
                    type="button"
                    className="send-button stop"
                    aria-label="Stop coach"
                    onClick={() => void window.interview.cancelChat()}
                  >
                    <Square size={13} fill="currentColor" />
                  </button>
                ) : (
                  <button
                    className="send-button"
                    aria-label="Send message"
                    disabled={
                      !message.trim() || snapshot.settings.provider === 'disabled' || !connected
                    }
                  >
                    <Send size={14} />
                  </button>
                )}
              </div>
            </form>
          </div>
        </aside>
      </div>
      {currentError && (
        <div className="error-bar" role="alert">
          <span>{currentError}</span>
          <button
            className="secondary small"
            onClick={() => void action(() => window.interview.reconnect())}
            disabled={snapshot.busy}
          >
            Reconnect
          </button>
          <button
            className="icon-button"
            aria-label="Dismiss error"
            onClick={() => {
              setError('');
              setSnapshot((current) => (current ? { ...current, error: null } : current));
            }}
          >
            <X size={14} />
          </button>
        </div>
      )}
      <footer className="statusbar">
        <div>
          {connected ? <Wifi size={12} /> : <WifiOff size={12} />}
          <span>
            {snapshot.connection === 'connecting'
              ? 'Connecting MCP…'
              : connected
                ? `MCP connected · ${snapshot.problems.length} problems`
                : 'MCP disconnected'}
          </span>
        </div>
        <div>
          <span>
            {active
              ? saveState === 'saving'
                ? 'Saving draft…'
                : saveState === 'error'
                  ? 'Save failed'
                  : 'Draft saved'
              : 'Ready'}
          </span>
          <span>Python 3.12</span>
          <span>UTF-8</span>
          <span>
            <ShieldCheck size={11} /> Local workspace
          </span>
        </div>
      </footer>
      {settingsOpen && (
        <SettingsDialog
          settings={snapshot.settings}
          onClose={() => setSettingsOpen(false)}
          onSave={async (settings) => {
            await flush();
            await window.interview.updateSettings(settings);
          }}
        />
      )}
      {approval && (
        <div className="modal-backdrop">
          <section
            className="approval-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="approval-title"
          >
            <ShieldCheck size={28} />
            <h2 id="approval-title">Approve submission?</h2>
            <p>{approval.description}</p>
            <div>
              <button
                className="secondary"
                onClick={() => {
                  void window.interview.approve(approval.id, false);
                  setApproval(null);
                }}
              >
                Keep practicing
              </button>
              <button
                className="primary"
                onClick={() => {
                  void window.interview.approve(approval.id, true);
                  setApproval(null);
                }}
              >
                Submit this draft
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function ChatMessage({ item }: { item: ChatItem }) {
  if (item.role === 'tool')
    return (
      <details className={`tool-activity ${item.status}`} open={item.status === 'running'}>
        <summary>
          {item.status === 'running' ? (
            <LoaderCircle size={12} className="spin" />
          ) : item.status === 'error' ? (
            <X size={12} />
          ) : (
            <Check size={12} />
          )}
          <span>{item.tool}</span>
          <ChevronRight size={11} />
        </summary>
        <pre>{item.text}</pre>
      </details>
    );
  if (item.role === 'system') return <div className="system-message">{item.text}</div>;
  return (
    <div className={`chat-message ${item.role}`}>
      <div className="message-label">
        {item.role === 'assistant' ? (
          <>
            <Sparkles size={12} /> COACH
          </>
        ) : (
          'YOU'
        )}
      </div>
      <Markdown text={item.text} />
    </div>
  );
}

function TestResults({ session, busy }: { session?: PracticeSession; busy: boolean }) {
  const result = session?.result;
  if (!result)
    return (
      <div className="tests-empty">
        <Terminal size={23} strokeWidth={1.4} />
        <p>{busy ? 'Working…' : 'Run your solution to see what holds up.'}</p>
        <span>Test cases, output, and errors appear here.</span>
      </div>
    );
  return (
    <>
      <div className="test-summary">
        <span className={result.all_passed ? 'success' : 'failed'}>
          {result.all_passed ? <Check size={14} /> : <X size={14} />}
          {result.tests_passed} of {result.tests_total} tests passed
        </span>
        {session?.submitted && <span className="completed-badge">Attempt completed</span>}
        {session?.resultStale && (
          <span className="stale-badge">Results are for an older draft</span>
        )}
      </div>
      <div className="test-cases">
        {result.tests.map((test) => (
          <details
            key={test.index}
            className={`test-case ${test.passed ? 'passed' : 'failed'}`}
            open={!test.passed}
          >
            <summary>
              {test.passed ? <Check size={12} /> : <X size={12} />}
              <span>Case {test.index + 1}</span>
              <span>{test.passed ? 'Passed' : test.error ? 'Error' : 'Wrong answer'}</span>
              <span className="test-time">{test.wall_time_ms} ms</span>
            </summary>
            <div className="test-detail">
              <div>
                <span>Input</span>
                <code>{JSON.stringify(test.input)}</code>
              </div>
              <div>
                <span>Expected</span>
                <code>{JSON.stringify(test.expected)}</code>
              </div>
              <div>
                <span>Actual</span>
                <code>{JSON.stringify(test.actual)}</code>
              </div>
              {test.error && <pre className="test-error">{test.error}</pre>}
              {test.user_stdout && <pre>{test.user_stdout}</pre>}
              {test.user_stderr && <pre className="test-error">{test.user_stderr}</pre>}
            </div>
          </details>
        ))}
      </div>
    </>
  );
}
