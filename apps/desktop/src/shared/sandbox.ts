export const MANAGED_PISTON_URL = 'http://127.0.0.1:2000';
export type SandboxStatus = {
  phase:
    | 'unchecked'
    | 'checking'
    | 'docker-missing'
    | 'docker-stopped'
    | 'unsupported'
    | 'starting'
    | 'installing'
    | 'ready'
    | 'stopped'
    | 'error';
  managed: boolean;
  message: string;
};
