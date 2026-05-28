import { getJson, postJson } from '@/api/http';
import type {
  SessionReplayItem,
  SessionTransitionKind,
} from '@/features/runtime/client';
import type { ULID } from '@/features/projects/client';

export interface FocusAgentSession {
  id: ULID;
  provider: 'claude';
  providerSessionId: string | null;
  model: string | null;
  title: string | null;
  status: 'active' | 'ended';
  endedReason: string | null;
  startedAt: number;
  endedAt: number | null;
  deletedAt: number | null;
  jsonlPath: string | null;
  jsonlLineCursor: number;
}

export interface FocusAgentRuntimeSnapshot {
  sessionId: ULID | null;
  provider: 'claude';
  providerSessionId: string | null;
  ptyState: string | null;
  spawnAttemptId: string | null;
  spawnAttempt: number;
  lastReadyAt: number | null;
  nextRetryAt: number | null;
  runtimeFailureReason: string | null;
}

export interface FocusAgentSessionTransitionResponse {
  transition: SessionTransitionKind;
  session: FocusAgentSession;
  replay: SessionReplayItem[];
  highWaterSeq?: number;
}

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
