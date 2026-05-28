import { getJson, postJson } from '@/api/http';
import type {
  SessionReplayItem,
} from '@/features/runtime/types';
import type { ULID } from '@/features/projects/types';
import type {
  FocusAgentRuntimeSnapshot,
  FocusAgentSession,
  FocusAgentSessionTransitionResponse,
} from './types';

export * from './types';

export const focusAgentApi = {
  getFocusAgentSession: () =>
    getJson<{ ok: true; session: FocusAgentSession | null }>(
      '/api/focus-agent/session',
    ).then((r) => r.session),

  getFocusAgentRuntime: () =>
    getJson<{ ok: true; runtime: FocusAgentRuntimeSnapshot }>(
      '/api/focus-agent/runtime',
    ).then((r) => r.runtime),

  listFocusAgentSessions: () =>
    getJson<{ ok: true; sessions: FocusAgentSession[] }>(
      '/api/focus-agent/sessions',
    ).then((r) => r.sessions),

  getFocusAgentSessionEvents: (sessionId: ULID) =>
    getJson<{ ok: true; sessionId?: ULID; highWaterSeq?: number; events: SessionReplayItem[] }>(
      `/api/focus-agent/sessions/${encodeURIComponent(sessionId)}/events`,
    ).then((r) => r.events),

  startNewFocusAgentSession: () =>
    postJson<{ ok: true } & FocusAgentSessionTransitionResponse>(
      '/api/focus-agent/sessions/new',
      {},
    ),

  resumeFocusAgentSession: (sessionId: ULID) =>
    postJson<{ ok: true } & FocusAgentSessionTransitionResponse>(
      `/api/focus-agent/sessions/${encodeURIComponent(sessionId)}/resume`,
      {},
    ),
};
