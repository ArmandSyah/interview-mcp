import { useEffect, useRef, useState } from 'react';
import type { SandboxStatus } from '../shared/sandbox';
import { useActions } from './actions';

export function SandboxSettings({
  enabled,
  onEnabled,
  beforeAction,
}: {
  enabled: boolean;
  onEnabled: () => void;
  beforeAction: () => Promise<void>;
}) {
  const actions = useActions();
  const [status, setStatus] = useState<SandboxStatus | null>(null);
  const busy = actions.busy;
  const [error, setError] = useState('');
  const revision = useRef(0);
  useEffect(() => {
    let live = true;
    const initialRevision = revision.current;
    void window.interview
      .sandboxInfo()
      .then((value) => {
        if (live && revision.current === initialRevision) setStatus(value);
      })
      .catch((error) => {
        if (live && revision.current === initialRevision)
          setError(error instanceof Error ? error.message : 'Cannot load sandbox settings');
      });
    const unsubscribe = window.interview.onEvent((event) => {
      if (live && event.type === 'sandbox') {
        revision.current += 1;
        setStatus(event.status);
      }
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  async function action(operation: () => Promise<SandboxStatus | null>) {
    try {
      await actions.run(async () => {
        revision.current += 1;
        setError('');
        await beforeAction();
        const result = await operation();
        if (result) setStatus(result);
      });
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Sandbox action failed');
    }
  }
  return (
    <div className="sandbox-settings">
      <p className="form-note" role="status">
        {status?.message ?? 'Loading sandbox settings…'}
      </p>
      <p className="form-note warning">
        Optional execution uses a privileged Docker container on your own trusted computer. Setup
        downloads the pinned image and Python runtime once. Solutions have networking disabled.
        Docker is not needed for design practice, editing, or hints.
      </p>
      {enabled && (
        <p className="form-note">
          Opted in: starts on Run/Submit, stops after five idle minutes and on exit. Runtime data is
          kept.
        </p>
      )}
      <div className="distribution-actions">
        <button
          type="button"
          className="secondary small"
          disabled={busy}
          onClick={() => void action(() => window.interview.inspectSandbox())}
        >
          Check local sandbox
        </button>
        <button
          type="button"
          className="secondary small"
          disabled={busy}
          onClick={() =>
            void action(async () => {
              const result = await window.interview.enableSandbox();
              if (result) onEnabled();
              return result;
            })
          }
        >
          {enabled ? 'Start / repair sandbox' : 'Enable local execution'}
        </button>
        <button
          type="button"
          className="secondary small"
          disabled={busy || !status?.managed || status.phase === 'stopped'}
          onClick={() => void action(() => window.interview.stopSandbox())}
        >
          Stop app-owned sandbox
        </button>
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
