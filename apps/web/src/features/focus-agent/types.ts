import type { ULID } from '@/features/projects/types';
import type {
  SessionReplayItem,
  SessionTransitionKind,
} from '@/features/runtime/types';

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
