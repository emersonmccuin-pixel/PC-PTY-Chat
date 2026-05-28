import { getJson, postJson } from '@/api/http';
import type { DevStatus } from './types';

export * from './types';

export const devControlsApi = {
  getDevStatus: () => getJson<DevStatus>('/api/dev/status'),
  restartBackend: (force?: boolean) =>
    postJson<{ ok: true }>('/api/dev/restart', { force: force ?? false }),
};
