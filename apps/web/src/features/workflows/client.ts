import { getJson, postJson, postJsonMethod } from '@/api/http';
import type { ULID } from '@/features/projects/client';

export type CatalogType =
  | 'ulid'
  | 'string'
  | 'text'
  | 'int'
  | 'bool'
  | 'object'
  | 'array';

export type EdgeRef =
  | { kind: 'node'; nodeId: string; output: string }
  | { kind: 'trigger'; output: string }
  | { kind: 'env'; name: string };

export interface NodeEdges {
  inputs?: Record<string, EdgeRef>;
  wire?: Record<string, EdgeRef>;
  output_schema?: Record<string, CatalogType>;
}

export type NodeOutputStatus =
  | 'pending'
  | 'running'
  | 'complete'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export interface NodeOutput {
  status: NodeOutputStatus;
  output?: unknown;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  attempt?: number;
  transcriptPath?: string;
}

export interface V2WorkflowDefSummary {
  id: string;
  name: string;
  description?: string;
  triggers: Array<{ kind: string; stage?: string }>;
  nodes: Array<{ id: string; kind: string }>;
  disabled?: boolean;
}

export type V2RunStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface V2RunSummary {
  id: string;
  workflowId: string;
  workflowName: string;
  projectId: string;
  workItemId: string | null;
  trigger: string;
  stageId: string | null;
  status: V2RunStatus;
  worktreePath: string | null;
  lastReason: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

export interface V2RunDetail extends V2RunSummary {
  dagState: {
    nodes: Record<
      string,
      {
        state: string;
        workItemId?: string;
        iteration?: number;
        error?: string;
        startedAt?: number;
        endedAt?: number;
      }
    >;
    rejectIterations?: Record<string, number>;
    rejectFeedback?: Record<string, string>;
  };
  workflowYamlSnapshot: string;
  triggerContext: Record<string, unknown>;
  metadata: Record<string, unknown>;
  triggeredBySessionId: string | null;
  lastActivityAt: number | null;
}

export interface V2RunEvent {
  id: string;
  runId: string;
  type: string;
  nodeId: string | null;
  data: Record<string, unknown> | null;
  occurredAt: number;
}

export type V2WorkflowDef = V2WorkflowDefSummary & { [key: string]: unknown };

export type WorkflowScope = 'global' | 'project';
export type WorkflowOrigin = 'stock' | 'user-created';
export type WorkflowRowStatus = 'active' | 'invalid';

export interface WorkflowRow {
  id: ULID;
  scope: WorkflowScope;
  projectId: ULID | null;
  slug: string;
  name: string;
  displayName: string | null;
  description: string | null;
  yaml: string;
  yamlHash: string;
  parsedDefinition: V2WorkflowDef | null;
  status: WorkflowRowStatus;
  parseError: string | null;
  disabled: boolean;
  origin: WorkflowOrigin;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export const workflowsApi = {
  listV2WorkflowDefinitions: (projectId: ULID) =>
    getJson<{
      ok: true;
      valid: Array<{ id: string; name: string; workflow: V2WorkflowDefSummary }>;
      invalid: Array<{ fileName: string; errors: string[] }>;
    }>(`/api/projects/${projectId}/workflow-v2/definitions`),

  listV2WorkflowRuns: (projectId: ULID) =>
    getJson<{ ok: true; runs: V2RunSummary[] }>(
      `/api/projects/${projectId}/workflow-v2/runs`,
    ),

  getV2Run: (projectId: ULID, runId: string) =>
    getJson<{ ok: true; run: V2RunDetail; events: V2RunEvent[] }>(
      `/api/projects/${projectId}/workflow-v2/runs/${encodeURIComponent(runId)}`,
    ),

  getV2WorkflowDef: (projectId: ULID, wfId: string) =>
    getJson<{ ok: true; workflow: V2WorkflowDef; yamlText: string }>(
      `/api/projects/${projectId}/workflow-v2/definitions/${encodeURIComponent(wfId)}`,
    ),

  listWorkflowRows: (projectId: ULID) =>
    getJson<{ ok: true; workflows: WorkflowRow[] }>(
      `/api/workflows?projectId=${encodeURIComponent(projectId)}`,
    ).then((r) => r.workflows),

  getWorkflowRow: (id: ULID) =>
    getJson<{ ok: true; workflow: WorkflowRow }>(
      `/api/workflows/${encodeURIComponent(id)}`,
    ).then((r) => r.workflow),

  createWorkflowRow: (input: {
    def: unknown;
    projectId?: ULID | null;
    scope?: WorkflowScope;
    displayName?: string | null;
    actor?: 'user' | 'orchestrator';
    reason?: string;
  }) =>
    postJson<{ ok: true; workflow: WorkflowRow }>('/api/workflows', input).then(
      (r) => r.workflow,
    ),

  updateWorkflowRow: (
    id: ULID,
    patch: {
      def?: unknown;
      yaml?: string;
      displayName?: string | null;
      disabled?: boolean;
      name?: string;
      actor?: 'user' | 'orchestrator';
      reason?: string;
    },
  ) =>
    postJsonMethod<{ ok: true; workflow: WorkflowRow }>(
      `/api/workflows/${encodeURIComponent(id)}`,
      patch,
      'PUT',
    ).then((r) => r.workflow),

  deleteWorkflowRow: async (id: ULID, opts?: { cancel?: boolean }): Promise<void> => {
    const qs = opts?.cancel ? '?cancel=1' : '';
    const res = await fetch(`/api/workflows/${encodeURIComponent(id)}${qs}`, {
      method: 'DELETE',
    });
    const data = (await res.json()) as {
      ok?: boolean;
      error?: string;
      kind?: string;
      inFlight?: number;
    };
    if (!res.ok || data.ok === false) {
      const msg = data.error ?? `delete workflow → ${res.status}`;
      const err = new Error(msg) as Error & {
        kind?: string;
        status?: number;
        inFlight?: number;
      };
      if (data.kind) err.kind = data.kind;
      if (data.inFlight !== undefined) err.inFlight = data.inFlight;
      err.status = res.status;
      throw err;
    }
  },

  promoteWorkflowToGlobal: (id: ULID) =>
    postJson<{ ok: true; workflow: WorkflowRow }>(
      `/api/workflows/${encodeURIComponent(id)}/promote-to-global`,
      {},
    ).then((r) => r.workflow),

  duplicateWorkflowRow: (
    id: ULID,
    input?: {
      newName?: string;
      newSlug?: string;
      targetScope?: WorkflowScope;
      targetProjectId?: ULID | null;
    },
  ) =>
    postJson<{ ok: true; workflow: WorkflowRow }>(
      `/api/workflows/${encodeURIComponent(id)}/duplicate`,
      input ?? {},
    ).then((r) => r.workflow),

  fireWorkflowRow: (
    id: ULID,
    input?: {
      trigger?: { kind: 'manual' | 'stage-on-entry' | 'schedule' | 'event'; [k: string]: unknown };
      projectId?: ULID;
    },
  ) =>
    postJson<{ ok: true; runId: string; workItemId?: string }>(
      `/api/workflows/${encodeURIComponent(id)}/fire`,
      input ?? {},
    ),
};
