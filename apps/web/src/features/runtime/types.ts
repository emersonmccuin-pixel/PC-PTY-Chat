import type { ULID } from '@/features/projects/types';

export interface OrchestratorSession {
  id: ULID;
  projectId: ULID;
  provider: 'claude';
  providerSessionId: string | null;
  model: string | null;
  title: string | null;
  status: 'active' | 'ended';
  endedReason: string | null;
  startedAt: number;
  endedAt: number | null;
  deletedAt: number | null;
}

export type SessionReplayItem =
  | {
      id?: string;
      sessionId?: ULID;
      seq?: number;
      type: 'jsonl';
      kind?: string | null;
      event: unknown;
      source?: { kind: string; cursor: number | null };
    }
  | {
      id?: string;
      sessionId?: ULID;
      seq?: number;
      type: 'event';
      kind?: string | null;
      event: unknown;
      source?: { kind: string; cursor: number | null };
    };

export type SessionTransitionKind = 'new-session' | 'resume-session';

export interface TerminalTranscriptResponse {
  ok: true;
  sessionId: string;
  bytes: string;
  truncated: boolean;
  mtimeMs: number | null;
}

export interface SessionTransitionResponse {
  transition: SessionTransitionKind;
  session: OrchestratorSession;
  replay: SessionReplayItem[];
  highWaterSeq?: number;
}

export type OrchestratorSendQueueStatus =
  | 'queued_busy'
  | 'queued_spawning'
  | 'queued_backlog'
  | 'delivering'
  | 'delivered_to_pty'
  | 'observed_in_jsonl'
  | 'failed'
  | 'cancelled';

export interface OrchestratorSendQueueItem {
  id: ULID;
  clientMessageId: string;
  text: string;
  status: OrchestratorSendQueueStatus;
  createdAt: number;
  updatedAt: number;
  deliveryAttempts: number;
  failureReason: string | null;
}

export type OrchestratorRuntimeHealth =
  | 'not_spawned'
  | 'spawning'
  | 'ready'
  | 'busy'
  | 'exited'
  | 'respawning'
  | 'failed_resume'
  | 'provider_missing';

export type OrchestratorRuntimeWaitPoint =
  | 'session'
  | 'queue'
  | 'spawn'
  | 'jsonl'
  | 'provider_resume'
  | 'ready_state'
  | 'none';

export interface OrchestratorRuntimeSnapshot {
  type: 'runtime-state';
  sessionId: ULID | null;
  provider: 'claude';
  providerSessionId: string | null;
  health: OrchestratorRuntimeHealth;
  waitPoint: OrchestratorRuntimeWaitPoint;
  ptyState: string | null;
  exitCode: number | null;
  exitSignal: string | null;
  spawnAttemptId: string | null;
  spawnAttempt: number;
  lastReadyAt: number | null;
  nextRetryAt: number | null;
  lastExitAt: number | null;
  lastJsonlAt: number | null;
  lastActivityAt: number | null;
  failureReason: string | null;
  rawJsonlPath: string | null;
  rawJsonlExists: boolean;
  rawJsonlCursor: number | null;
  replayPath: string | null;
  replayExists: boolean;
  replayLineCount: number;
  replayHighWaterSeq: number;
  queueDepth: number;
  queue: OrchestratorSendQueueItem[];
}
