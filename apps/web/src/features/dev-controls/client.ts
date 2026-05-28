import { getJson, postJson } from '@/api/http';

export interface DevStatus {
  activeAgents: number;
  canRestart: boolean;
  /** TEMP reload-test marker emitted by the BE; absent until the server is
   *  restarted onto the new source. Remove after testing. */
  marker?: string;
}

export const devControlsApi = {
  getDevStatus: () => getJson<DevStatus>('/api/dev/status'),
  restartBackend: (force?: boolean) =>
    postJson<{ ok: true }>('/api/dev/restart', { force: force ?? false }),
};
