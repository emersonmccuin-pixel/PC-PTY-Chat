import { getJson, postJson } from '@/api/http';
import type { ULID } from '@/features/projects/client';

export type AgentRunStatus =
  | 'spawning'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AgentRunFailureCause =
  | 'timeout'
  | 'idle-timeout'
  | 'spawn-failed'
  | 'spawn-exit'
  | 'cancelled'
  | 'unknown-agent';

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

export const agentRunsApi = {
  listAgentRuns: (projectId: ULID) =>
    getJson<{ ok: true; runs: AgentRunRecord[] }>(
      `/api/projects/${projectId}/agent-runs`,
    ).then((r) => r.runs),

  cancelAgentRun: (projectId: ULID, runId: string) =>
    postJson<{ ok: boolean; status: string | null }>(
      `/api/projects/${projectId}/agent-runs/${runId}/cancel`,
      {},
    ),

  listAgentPendingAsks: (projectId: ULID) =>
    getJson<{ ok: true; pendingAsks: PendingAsk[] }>(
      `/api/projects/${projectId}/agent-pending-asks`,
    ).then((r) => r.pendingAsks),

  answerAgentPendingAsk: (
    projectId: ULID,
    askId: string,
    answer: string,
    answeredBy: 'user' | 'orchestrator' = 'user',
  ) =>
    postJson<{ ok: boolean; cause?: string }>(
      `/api/projects/${projectId}/agent-pending-asks/${askId}/answer`,
      { answer, answeredBy },
    ),

  listFailedRunDismissals: (projectId: ULID) =>
    getJson<{ runIds: string[] }>(
      `/api/projects/${projectId}/failed-run-dismissals`,
    ).then((r) => r.runIds),

  dismissFailedRun: (projectId: ULID, runId: string) =>
    postJson<{ ok: true; dismissedAt: number }>(
      `/api/projects/${projectId}/workflow-runs/${runId}/dismiss`,
      {},
    ),
};
