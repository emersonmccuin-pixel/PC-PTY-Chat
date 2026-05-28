import { getJson, postJson } from '@/api/http';

export interface DevStatus {
  activeAgents: number;
  canRestart: boolean;
}

export const devControlsApi = {
  getDevStatus: () => getJson<DevStatus>('/api/dev/status'),
  restartBackend: (force?: boolean) =>
    postJson<{ ok: true }>('/api/dev/restart', { force: force ?? false }),
};
