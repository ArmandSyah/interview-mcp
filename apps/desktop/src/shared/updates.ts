export type UpdateStatus = {
  state: 'unconfigured' | 'idle' | 'available' | 'ready';
  version: string | null;
  notes: string;
  message: string;
};
export type ReleaseChannel = 'stable' | 'beta';
