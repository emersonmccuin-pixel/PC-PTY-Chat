import { getJson, postJson } from '@/api/http';
import type { ULID } from '@/features/projects/types';
import type {
  AgentRunEventsResponse,
  AgentRunInspection,
  AgentRunRecord,
  PendingAsk,
} from './types';

export * from './types';

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

  inspectAgentRun: (projectId: ULID, runId: string) =>
    getJson<{ ok: true; inspection: AgentRunInspection }>(
      `/api/projects/${projectId}/agent-runs/${runId}/inspect`,
    ).then((r) => r.inspection),

  // Force-kill: kills the real OS process (by persisted pid) AND finalizes the
  // row to cancelled. Works on a phantom run that /cancel can't touch.
  killAgentRun: (projectId: ULID, runId: string) =>
    postJson<{
      ok: boolean;
      status?: string;
      alreadyTerminal?: boolean;
      processKilled?: boolean;
      error?: string;
    }>(`/api/projects/${projectId}/agent-runs/${runId}/kill`, {}),

  getAgentRunEvents: (projectId: ULID, runId: string) =>
    getJson<AgentRunEventsResponse>(
      `/api/projects/${projectId}/agent-runs/${runId}/events`,
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
