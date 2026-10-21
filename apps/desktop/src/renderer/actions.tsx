import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

type Actions = {
  /** True from action start through completion or failure, including the initial draft flush. */
  busy: boolean;
  /**
   * Do the operation if no action is active. Return false without side effects for a concurrent request.
   * Return true after completion. Propagate errors and release the lock after failure.
   */
  run: (operation: () => Promise<unknown>) => Promise<boolean>;
};
const Context = createContext<Actions | null>(null);

/** Share one action lock across the workspaces and their dialogs. Autosave does not use this lock. */
export function ActionProvider({ children }: { children: ReactNode }) {
  const active = useRef(false);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (operation: () => Promise<unknown>): Promise<boolean> => {
    // The ref stops a second event before React can render disabled controls.
    if (active.current) return false;
    active.current = true;
    setBusy(true);
    try {
      await operation();
      return true;
    } finally {
      active.current = false;
      setBusy(false);
    }
  }, []);
  return <Context.Provider value={{ busy, run }}>{children}</Context.Provider>;
}

export function useActions(): Actions {
  const value = useContext(Context);
  if (!value) throw new Error('UI actions require ActionProvider');
  return value;
}
