import type { ULID } from '@/features/projects/types';

export type AgentRunStatus =
  | 'queued'
  | 'spawning'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AgentRunFailureCause =
  | 'spawn-stuck'
  | 'timeout'
  | 'idle-timeout'
  | 'wall-clock-timeout'
  | 'ready-timeout'
  | 'spawn-failed'
  | 'spawn-error'
  | 'send-failed'
  | 'spawn-exit'
  | 'unexpected-exit'
  | 'cancel-while-queued'
  | 'cancelled'
  | 'unknown-agent'
  | 'mcp-handshake-never'
  | 'kill-during-spawn'
  | 'server-restart'
  | 'host-unavailable'
  | 'host-lost'
  | 'host-crashed'
  | 'host-protocol-error';

export type PendingAskKind = 'ask-orchestrator' | 'ask-user' | 'approval';
export type PendingAskStatus = 'waiting' | 'answered' | 'cancelled';

export interface PendingAskOption {
  value: string;
  label: string;
}

export interface PendingAsk {
  id: ULID;
  sessionId: string;
  agentName: string;
  projectId: ULID;
  runId: ULID | null;
  parentWorkItemId: ULID | null;
  kind: PendingAskKind;
  question: string;
  context: string | null;
  options: PendingAskOption[] | null;
  status: PendingAskStatus;
  answer: string | null;
  answeredBy: 'orchestrator' | 'user' | null;
  createdAt: number;
  answeredAt: number | null;
  cancelledAt: number | null;
}

export interface AgentRunRecord {
  runId: ULID;
  sessionId: string;
  agentName: string;
  projectId: ULID;
  parentWorkItemId: ULID | null;
  wait: boolean;
  worktreeDir: string;
  startedAt: number;
  status: AgentRunStatus;
  result: string;
  failureReason: string | null;
  failureCause: AgentRunFailureCause | null;
  endedAt: number | null;
}

export type AgentRunTranscriptStatus = 'ready' | 'empty' | 'missing';

export interface AgentRunEventsResponse {
  ok: true;
  runId: ULID;
  status: AgentRunStatus;
  jsonlPath: string;
  transcriptStatus: AgentRunTranscriptStatus;
  events: unknown[];
}
