import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

type Actions = {
  /** True while an action or window close is in progress, including draft writes. */
  busy: boolean;
  /** True after beginClose, until cancelClose or window destruction. */
  closing: boolean;
  /** Stop new actions and wait for the active action, whether it succeeds or fails. */
  beginClose: () => Promise<void>;
  /** Permit actions again after a close failure. The active action keeps its lock. */
  cancelClose: () => void;
  /** Prevent draft changes during the last save and the main-process close check. */
  freezeDrafts: () => void;
  draftsFrozen: () => boolean;
  /**
   * Do the operation if no action is active. Return false without side effects for a concurrent request.
   * Return true after completion. Propagate errors and release the lock after failure.
   */
  run: (operation: () => Promise<unknown>) => Promise<boolean>;
};
const Context = createContext<Actions | null>(null);

/** Share one action lock across the workspaces and their dialogs. Autosave does not use this lock. */
export function ActionProvider({ children }: { children: ReactNode }) {
  const active = useRef<Promise<void> | null>(null);
  const closingRef = useRef(false);
  const frozenRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const beginClose = useCallback(() => {
    closingRef.current = true;
    setClosing(true);
    return active.current ?? Promise.resolve();
  }, []);
  const cancelClose = useCallback(() => {
    closingRef.current = false;
    frozenRef.current = false;
    setClosing(false);
  }, []);
  const freezeDrafts = useCallback(() => {
    frozenRef.current = true;
  }, []);
  const draftsFrozen = useCallback(() => frozenRef.current, []);
  const run = useCallback(async (operation: () => Promise<unknown>): Promise<boolean> => {
    // The ref stops a second event before React can render disabled controls.
    if (active.current || closingRef.current) return false;
    let settled!: () => void;
    active.current = new Promise<void>((resolve) => {
      settled = resolve;
    });
    setBusy(true);
    try {
      await operation();
      return true;
    } finally {
      active.current = null;
      setBusy(false);
      settled();
    }
  }, []);
  return (
    <Context.Provider
      value={{
        busy: busy || closing,
        closing,
        run,
        beginClose,
        cancelClose,
        freezeDrafts,
        draftsFrozen,
      }}
    >
      {children}
    </Context.Provider>
  );
}

export function useActions(): Actions {
  const value = useContext(Context);
  if (!value) throw new Error('UI actions require ActionProvider');
  return value;
}
