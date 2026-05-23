// Typed fetch helpers for the apps/server HTTP surface.
// Wire shapes mirror packages/domain — kept inline here (no @pc/domain dep on the
// browser bundle) so the web package stays import-cycle-free.

export type ULID = string;

export type WorkItemStatus =
  | 'pending'
  | 'in-progress'
  | 'blocked'
  | 'complete'
  | 'failed'
  | 'archived';

export interface Stage {
  id: string;
  name: string;
  order: number;
}

export interface Project {
  id: ULID;
  slug: string;
  name: string;
  stages: Stage[];
  folderPath: string;
  gitRemote: string | null;
}

export const WORK_ITEM_TYPES = ['task', 'bug', 'feature', 'spike'] as const;
export type WorkItemType = (typeof WORK_ITEM_TYPES)[number];

/** Section 16b.7 — append-only event log entry. `move` / `update` written
 *  by the work-items repo; `agent-*` written by the agent-comms HTTP
 *  routes after the primary tool effect lands. Rendered in the detail
 *  modal's Activity tab. */
export interface WorkItemHistoryEntry {
  ts: string;
  kind:
    | 'move'
    | 'update'
    | 'agent-invoke'
    | 'agent-ask-orchestrator'
    | 'agent-ask-user'
    | 'agent-approval-request'
    | 'agent-answer'
    | 'agent-completed'
    | 'agent-failed';
  from?: string;
  to?: string;
  fields?: Record<string, unknown>;
  note?: string;
  agentName?: string;
  sessionId?: string;
  runId?: string;
  pendingAskId?: string;
  invokeMode?: 'sync' | 'async';
  answeredBy?: 'orchestrator' | 'user';
  cause?: string;
}

export interface WorkItem {
  id: ULID;
  projectId: ULID;
  parentId: ULID | null;
  position: number;
  title: string;
  body: string;
  stageId: string;
  status: WorkItemStatus;
  statusReason: string | null;
  type: WorkItemType;
  fields: Record<string, unknown>;
  version: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  history: WorkItemHistoryEntry[];
}

export type FieldSchemaType = 'text' | 'number' | 'boolean' | 'enum' | 'date';

export interface FieldSchema {
  id: ULID;
  projectId: ULID;
  key: string;
  label: string;
  type: FieldSchemaType;
  options?: string[];
  default?: unknown;
  required: boolean;
  description?: string;
  order: number;
}

/** Bulk-replace payload shape (server mints ids for entries without one). */
export interface FieldSchemaInput {
  id?: ULID;
  key: string;
  label: string;
  type: FieldSchemaType;
  options?: string[];
  default?: unknown;
  required: boolean;
  description?: string;
  order: number;
}

export interface Attachment {
  id: ULID;
  workItemId: ULID;
  kind: string;
  name: string;
  content: string;
  contentType: string | null;
  runId: ULID | null;
  createdBySessionId: ULID | null;
  createdAt: number;
}

export interface WorkItemPatch {
  title?: string;
  body?: string;
  stageId?: string;
  parentId?: ULID | null;
  position?: number;
  type?: WorkItemType;
  fields?: Record<string, unknown>;
}

export interface WorkItemMoveInput {
  stageId: string;
  position?: number;
}

export class WorkItemConflictError extends Error {
  current: WorkItem;
  constructor(current: WorkItem) {
    super('work item version conflict');
    this.name = 'WorkItemConflictError';
    this.current = current;
  }
}

/** Thrown by replaceStages when removing a stage that still has work items.
 *  Caller surfaces `orphans` (id + name + count) and re-tries with
 *  `force: true` + `fallbackStageId` once the user picks a destination. */
export class StageHasItemsError extends Error {
  orphans: { id: string; name: string; count: number }[];
  constructor(orphans: { id: string; name: string; count: number }[]) {
    super('STAGE_HAS_ITEMS');
    this.name = 'StageHasItemsError';
    this.orphans = orphans;
  }
}

/** Thrown by createWorkItem / patchWorkItem when the server rejects field
 *  validation. `errors` is a per-key map keyed by FieldSchema.key. */
export class WorkItemFieldValidationError extends Error {
  errors: Record<string, string>;
  constructor(message: string, errors: Record<string, string>) {
    super(message);
    this.name = 'WorkItemFieldValidationError';
    this.errors = errors;
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as T & { ok?: boolean; error?: string };
  if (!res.ok || data.ok === false) {
    throw new Error(data.error ?? `${path} → ${res.status}`);
  }
  return data;
}

// ── Filesystem (folder picker) ─────────────────────────────────────────────

export interface BrowseEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isHidden: boolean;
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  entries: BrowseEntry[];
}

export interface FolderProbe {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  hasFiles: boolean;
  fileCount: number;
  isGitRepo: boolean;
  hasPcScaffold: boolean;
  hasMcpJson: boolean;
}

export type CreateProjectMode = 'init-empty' | 'init-in-place' | 'attach-to-git';

// ── Files (5+.2) ───────────────────────────────────────────────────────────

export interface FileTreeNode {
  name: string;
  /** Posix-style path relative to the project root. */
  path: string;
  kind: 'file' | 'dir';
  children?: FileTreeNode[];
  /** File size in bytes. Only present on files. */
  size?: number;
}

export type FilePreview =
  | { kind: 'markdown'; content: string; byteSize: number }
  | { kind: 'html'; content: string; byteSize: number }
  | { kind: 'image'; dataUri: string; byteSize: number }
  | { kind: 'text'; content: string; byteSize: number }
  | { kind: 'binary'; byteSize: number }
  | { kind: 'oversized'; byteSize: number };

// ── Agent pods (Section 17 — DB-resident agents) ──────────────────────────
// Wire shapes mirror packages/domain/src/pod.ts. valuePlaintext is INTENTIONALLY
// omitted from PodSecret — the server never echoes it back.

/** Stock pod names. Mirror of `STOCK_POD_NAMES` in
 *  `packages/domain/src/stock-pod-names.ts` — kept here inline so the web
 *  bundle stays free of an `@pc/domain` import (see the file header). The
 *  server-side drift assertion in `apps/server/src/services/stock-pod-seed.ts`
 *  catches "seeded set ≠ domain set" mismatches at boot; if you add a stock
 *  pod here, add it there too. */
export const STOCK_POD_NAMES: ReadonlySet<string> = new Set([
  'orchestrator',
  'researcher',
  'writer',
  'code-writer',
  'reviewer',
  'planner',
  'extractor',
  'agent-designer',
]);

export type PodScope = 'global' | 'project';
export type PodKnowledgeKind = 'knowledge' | 'example';
export type PodAuditActor = 'orchestrator' | 'user';
export type PodAuditField =
  | 'prompt'
  | 'description'
  | 'model'
  | 'effort'
  | 'max_turns'
  | 'tools'
  | 'output_destination'
  | 'name'
  | 'knowledge'
  | 'secret'
  | 'mcp_server'
  | 'created'
  | 'deleted';

export interface PodMcpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface Pod {
  id: ULID;
  name: string;
  scope: PodScope;
  projectId: ULID | null;
  prompt: string;
  tools: string[];
  model: string | null;
  effort: string | null;
  maxTurns: number | null;
  outputDestination: string | null;
  description: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface PodKnowledge {
  id: ULID;
  agentId: ULID;
  scope: PodScope;
  projectId: ULID | null;
  name: string;
  kind: PodKnowledgeKind;
  content: string;
  createdAt: number;
  updatedAt: number;
}

/** Secret as the wire sees it — value is NEVER readback. */
export interface PodSecret {
  id: ULID;
  agentId: ULID;
  envVarName: string;
  createdAt: number;
}

export interface PodMcpServer {
  id: ULID;
  agentId: ULID;
  scope: PodScope;
  projectId: ULID | null;
  name: string;
  config: PodMcpServerConfig;
  createdAt: number;
}

export interface PodAuditEntry {
  id: ULID;
  agentId: ULID;
  changeSetId: ULID | null;
  actor: PodAuditActor;
  field: PodAuditField;
  fieldRef: string | null;
  priorValue: string | null;
  newValue: string | null;
  reason: string | null;
  createdAt: number;
}

export interface PodBundle {
  agent: Pod;
  knowledge: PodKnowledge[];
  secrets: PodSecret[];
  mcpServers: PodMcpServer[];
}

export interface CreatePodInput {
  name: string;
  /** Defaults to 'global' server-side when omitted. UI surfaces always pass
   *  'project' + projectId; orchestrator pc_create_agent defaults to 'project'
   *  too. Explicit 'global' is reserved for danger-zone promotion paths. */
  scope?: 'project' | 'global';
  /** Required when scope='project'. */
  projectId?: ULID;
  description?: string;
  prompt?: string;
  model?: string | null;
  effort?: string | null;
  maxTurns?: number | null;
  tools?: string[];
  outputDestination?: string | null;
}

export interface PatchPodInput {
  name?: string;
  description?: string;
  prompt?: string;
  model?: string | null;
  effort?: string | null;
  maxTurns?: number | null;
  tools?: string[];
  outputDestination?: string | null;
}

export interface ListAuditOptions {
  limit?: number;
  beforeCreatedAt?: number;
  actor?: PodAuditActor;
  field?: PodAuditField;
}

// ── Global settings (Q10 envelope) ─────────────────────────────────────────

export interface ActivityPanelSettings {
  open: boolean;
  showAllProjects: boolean;
}

export interface GlobalSettings {
  dataDir: string;
  telemetryOptIn: boolean;
  projectsFolder: string;
  activityPanel: ActivityPanelSettings;
  bugLogTargetProjectId: ULID | null;
  fontScale: number;
}

export const FONT_SCALE_MIN = 0.85;
export const FONT_SCALE_MAX = 1.5;
export const FONT_SCALE_STEP = 0.05;

// ── Orchestrator session ───────────────────────────────────────────────────

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

export const api = {
  listProjects: () =>
    getJson<{ projects: Project[] }>('/api/projects').then((r) => r.projects),

  createProject: (input: {
    name: string;
    folder_path: string;
    mode: CreateProjectMode;
    git_remote?: string | null;
  }) =>
    postJson<{ ok: true; project: Project }>('/api/projects', input).then(
      (r) => r.project,
    ),

  listDrives: async (): Promise<string[]> => {
    const res = await fetch('/api/fs/drives');
    const data = (await res.json()) as { ok?: boolean; drives?: string[]; error?: string };
    if (!res.ok || data.ok === false) {
      throw new Error(data.error ?? `drives → ${res.status}`);
    }
    return data.drives ?? [];
  },

  browseFolder: async (path?: string, gateRoot?: string): Promise<BrowseResult> => {
    const qs = new URLSearchParams();
    if (path) qs.set('path', path);
    if (gateRoot) qs.set('gateRoot', gateRoot);
    const tail = qs.toString();
    const res = await fetch(`/api/fs/browse${tail ? `?${tail}` : ''}`);
    const data = (await res.json()) as
      | { ok: true; path: string; parent: string | null; entries: BrowseEntry[] }
      | { ok: false; error: string; kind?: string };
    if (!res.ok || data.ok === false) {
      throw new Error(data.ok === false ? data.error : `browse → ${res.status}`);
    }
    return { path: data.path, parent: data.parent, entries: data.entries };
  },

  probeFolder: async (path: string): Promise<FolderProbe> => {
    const r = await postJson<{ ok: true; probe: FolderProbe }>('/api/fs/probe', { path });
    return r.probe;
  },

  // Per-project endpoints (Q7+ consumers).
  project: (projectId: ULID) => getJson<Project>(`/api/projects/${projectId}`),
  workItems: (projectId: ULID) =>
    getJson<{ workItems: WorkItem[] }>(`/api/projects/${projectId}/work-items`).then(
      (r) => r.workItems,
    ),
  getWorkItem: (projectId: ULID, wiId: ULID) =>
    getJson<{ ok: true; workItem: WorkItem }>(
      `/api/projects/${projectId}/work-items/${wiId}`,
    ).then((r) => r.workItem),
  /** Create. Throws WorkItemFieldValidationError on 400 field-validation so
   *  callers can render per-field messages instead of the opaque "field
   *  validation failed: <keys>" join. */
  createWorkItem: async (
    projectId: ULID,
    title: string,
    stageId: string,
    opts: {
      body?: string;
      parentId?: ULID | null;
      type?: WorkItemType;
      fields?: Record<string, unknown>;
    } = {},
  ): Promise<{ ok: true; workItem: WorkItem }> => {
    const res = await fetch(`/api/projects/${projectId}/work-items/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, stageId, ...opts }),
    });
    const data = (await res.json()) as
      | { ok: true; workItem: WorkItem }
      | { ok: false; error: string; errors?: Record<string, string> };
    if (res.status === 400 && data.ok === false && data.errors) {
      throw new WorkItemFieldValidationError(data.error, data.errors);
    }
    if (!res.ok || data.ok === false) {
      throw new Error(data.ok === false ? data.error : `create → ${res.status}`);
    }
    return data;
  },
  /** Version-checked PATCH. Throws WorkItemConflictError on 409 (carrying the
   *  current row), WorkItemFieldValidationError on 400 field-validation. */
  patchWorkItem: async (
    projectId: ULID,
    wiId: ULID,
    version: number,
    patch: WorkItemPatch,
  ): Promise<WorkItem> => {
    const res = await fetch(`/api/projects/${projectId}/work-items/${wiId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version, ...patch }),
    });
    const data = (await res.json()) as
      | { ok: true; workItem: WorkItem }
      | { ok: false; error: string; current?: WorkItem; errors?: Record<string, string> };
    if (res.status === 409 && data.ok === false && data.current) {
      throw new WorkItemConflictError(data.current);
    }
    if (res.status === 400 && data.ok === false && data.errors) {
      throw new WorkItemFieldValidationError(data.error, data.errors);
    }
    if (!res.ok || data.ok === false) {
      throw new Error(data.ok === false ? data.error : `patch → ${res.status}`);
    }
    return data.workItem;
  },
  softDeleteWorkItem: async (projectId: ULID, wiId: ULID): Promise<void> => {
    const res = await fetch(`/api/projects/${projectId}/work-items/${wiId}`, {
      method: 'DELETE',
    });
    const data = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || data.ok === false) {
      throw new Error(data.error ?? `delete → ${res.status}`);
    }
  },

  restoreWorkItem: (projectId: ULID, wiId: ULID) =>
    postJson<{ ok: true; workItem: WorkItem }>(
      `/api/projects/${projectId}/work-items/${wiId}/restore`,
      {},
    ).then((r) => r.workItem),

  listArchivedWorkItems: (projectId: ULID) =>
    getJson<{ items: WorkItem[]; nextCursor: ULID | null }>(
      `/api/projects/${projectId}/work-items?includeArchived=1&limit=500`,
    ).then((r) => r.items),

  replaceStages: async (
    projectId: ULID,
    stages: Stage[],
    opts: { force?: boolean; fallbackStageId?: string } = {},
  ): Promise<Project> => {
    const res = await fetch(`/api/projects/${projectId}/stages`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stages, ...opts }),
    });
    const data = (await res.json()) as
      | { ok: true; project: Project }
      | { ok: false; error: string; orphans?: { id: string; name: string; count: number }[] };
    if (
      res.status === 409 &&
      data.ok === false &&
      data.error === 'STAGE_HAS_ITEMS' &&
      Array.isArray(data.orphans)
    ) {
      throw new StageHasItemsError(data.orphans);
    }
    if (!res.ok || data.ok === false) {
      throw new Error(data.ok === false ? data.error : `replace stages → ${res.status}`);
    }
    return data.project;
  },

  listFieldSchemas: (projectId: ULID) =>
    getJson<{ ok: true; items: FieldSchema[] }>(
      `/api/projects/${projectId}/field-schemas`,
    ).then((r) => r.items),

  replaceFieldSchemas: (projectId: ULID, items: FieldSchemaInput[]) =>
    postJsonMethod<{ ok: true; items: FieldSchema[] }>(
      `/api/projects/${projectId}/field-schemas`,
      { items },
      'PUT',
    ).then((r) => r.items),

  listAttachments: (projectId: ULID, wiId: ULID) =>
    getJson<{ ok: true; items: Attachment[] }>(
      `/api/projects/${projectId}/work-items/${wiId}/attachments`,
    ).then((r) => r.items),

  getAttachment: (projectId: ULID, wiId: ULID, aId: ULID) =>
    getJson<{ ok: true; attachment: Attachment }>(
      `/api/projects/${projectId}/work-items/${wiId}/attachments/${aId}`,
    ).then((r) => r.attachment),

  deleteAttachment: async (projectId: ULID, wiId: ULID, aId: ULID): Promise<void> => {
    const res = await fetch(
      `/api/projects/${projectId}/work-items/${wiId}/attachments/${aId}`,
      { method: 'DELETE' },
    );
    const data = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || data.ok === false) {
      throw new Error(data.error ?? `delete attachment → ${res.status}`);
    }
  },

  /** Version-checked move. Same 409 semantics as patchWorkItem. */
  moveWorkItem: async (
    projectId: ULID,
    wiId: ULID,
    version: number,
    input: WorkItemMoveInput,
  ): Promise<WorkItem> => {
    const res = await fetch(`/api/projects/${projectId}/work-items/${wiId}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version, ...input }),
    });
    const data = (await res.json()) as
      | { ok: true; workItem: WorkItem }
      | { ok: false; error: string; current?: WorkItem };
    if (res.status === 409 && data.ok === false && data.current) {
      throw new WorkItemConflictError(data.current);
    }
    if (!res.ok || data.ok === false) {
      throw new Error(data.ok === false ? data.error : `move → ${res.status}`);
    }
    return data.workItem;
  },

  getSettings: () =>
    getJson<{ ok: true; settings: GlobalSettings }>('/api/settings').then((r) => r.settings),

  getMcpStatus: (projectId?: string) =>
    getJson<{ alive: boolean; toolCount: number; tools: string[] }>(
      projectId
        ? `/api/mcp-status?projectId=${encodeURIComponent(projectId)}`
        : '/api/mcp-status',
    ),

  patchSettings: (patch: Partial<GlobalSettings>) =>
    postJsonMethod<{ ok: true; settings: GlobalSettings; restartRequired: boolean }>(
      '/api/settings',
      patch,
      'PATCH',
    ),

  // ── Project mutate / delete (Q11) ────────────────────────────────────────
  updateProject: (projectId: ULID, patch: { name?: string; git_remote?: string | null }) =>
    postJsonMethod<{ ok: true; project: Project }>(`/api/projects/${projectId}`, patch, 'PATCH')
      .then((r) => r.project),

  softDeleteProject: async (projectId: ULID): Promise<void> => {
    const res = await fetch(`/api/projects/${projectId}`, { method: 'DELETE' });
    const data = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || data.ok === false) {
      throw new Error(data.error ?? `delete → ${res.status}`);
    }
  },

  deleteProjectFiles: async (projectId: ULID): Promise<string[]> => {
    const res = await fetch(`/api/projects/${projectId}/files`, { method: 'DELETE' });
    const data = (await res.json()) as { ok?: boolean; error?: string; removed?: string[] };
    if (!res.ok || data.ok === false) {
      throw new Error(data.error ?? `delete files → ${res.status}`);
    }
    return data.removed ?? [];
  },

  revealProject: async (projectId: ULID): Promise<void> => {
    const res = await fetch(`/api/projects/${projectId}/reveal`, { method: 'POST' });
    const data = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || data.ok === false) {
      throw new Error(data.error ?? `reveal → ${res.status}`);
    }
  },

  // ── Projects: reorder (5+.4 / D87) ───────────────────────────────────────
  /** Persist a drag-reordered project list. `orderedIds` is the full live
   *  list in its new display order; the server rewrites every row's
   *  `position` to its index. Returns the canonical list back so the caller
   *  can reconcile against any in-flight optimistic state. */
  reorderProjects: (orderedIds: ULID[]) =>
    postJsonMethod<{ ok: true; projects: Project[] }>(
      '/api/projects/reorder',
      { orderedIds },
      'PATCH',
    ).then((r) => r.projects),

  // ── Files (5+.2) ─────────────────────────────────────────────────────────
  /** Recursive tree of the project's folderPath, with HARD_SKIP_DIRS and
   *  .gitignore applied server-side. Paths are posix-style + relative to the
   *  root. */
  getFilesTree: (projectId: ULID) =>
    getJson<{ ok: true; tree: FileTreeNode[] }>(
      `/api/projects/${projectId}/files/tree`,
    ).then((r) => r.tree),

  /** Read-only preview for a single file. `path` is the relative posix-style
   *  path returned by `getFilesTree`. Renderer dispatches on `preview.kind`. */
  previewFile: async (projectId: ULID, path: string): Promise<FilePreview> => {
    const res = await fetch(
      `/api/projects/${projectId}/files/preview?path=${encodeURIComponent(path)}`,
    );
    const data = (await res.json()) as
      | { ok: true; preview: FilePreview }
      | { ok: false; error: string };
    if (!res.ok || data.ok === false) {
      throw new Error(data.ok === false ? data.error : `preview → ${res.status}`);
    }
    return data.preview;
  },

  // ── Agent-designer transient session (17b.12) ─────────────────────────────
  /** Spawn the AgentDesignerChat's transient PtySession. Backed by the
   *  agent-designer pod (DB-resident; materialised at spawn). */
  startAgentDesigner: (projectId: ULID) =>
    postJson<{ ok: true; state: string }>(
      `/api/projects/${projectId}/agent-designer/start`,
      {},
    ).then((r) => r.state),

  sendAgentDesigner: (projectId: ULID, text: string) =>
    postJson<{ ok: true }>(`/api/projects/${projectId}/agent-designer/send`, {
      text,
    }),

  interruptAgentDesigner: (projectId: ULID) =>
    postJson<{ ok: true }>(
      `/api/projects/${projectId}/agent-designer/interrupt`,
      {},
    ),

  stopAgentDesigner: async (projectId: ULID): Promise<void> => {
    const res = await fetch(`/api/projects/${projectId}/agent-designer`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error(`stop agent-designer → ${res.status}`);
  },

  // ── Setup wizard (5.6 / D82) ─────────────────────────────────────────────

  startSetupWizard: (projectId: ULID) =>
    postJson<{ ok: true; state: string }>(
      `/api/projects/${projectId}/setup-wizard/start`,
      {},
    ).then((r) => r.state),

  sendSetupWizard: (projectId: ULID, text: string) =>
    postJson<{ ok: true }>(`/api/projects/${projectId}/setup-wizard/send`, { text }),

  interruptSetupWizard: (projectId: ULID) =>
    postJson<{ ok: true }>(`/api/projects/${projectId}/setup-wizard/interrupt`, {}),

  stopSetupWizard: async (projectId: ULID): Promise<void> => {
    const res = await fetch(`/api/projects/${projectId}/setup-wizard`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error(`stop setup-wizard → ${res.status}`);
  },

  getClaudeMdStatus: async (
    projectId: ULID,
  ): Promise<{ exists: boolean; empty: boolean }> => {
    const res = await fetch(`/api/projects/${projectId}/claude-md-status`);
    const data = (await res.json()) as {
      ok?: boolean;
      error?: string;
      exists?: boolean;
      empty?: boolean;
    };
    if (!res.ok || data.ok === false) {
      throw new Error(data.error ?? `claude-md-status → ${res.status}`);
    }
    return { exists: data.exists === true, empty: data.empty === true };
  },

  // ── Workflow-creator transient session (Section 4b phase 4b.3) ─────────
  /** Spawn the per-project "+ New workflow" modal's transient PtySession.
   *  Session is layered with `workflow-creator-prompt.md` and emits its
   *  events on the `workflow-creator-*` WS envelope kinds. Returns the
   *  initial state + transient sessionId — the visualizer keys on
   *  sessionId to pick the right `workflow-creator-draft` broadcasts. */
  startWorkflowCreator: (projectId: ULID) =>
    postJson<{ ok: true; state: string; sessionId: string | null }>(
      `/api/projects/${projectId}/workflow-creator/start`,
      {},
    ).then((r) => ({ state: r.state, sessionId: r.sessionId })),

  /** Send a user prompt into the workflow-creator session. */
  sendWorkflowCreator: (projectId: ULID, text: string) =>
    postJson<{ ok: true }>(`/api/projects/${projectId}/workflow-creator/send`, { text }),

  /** Press Escape on the workflow-creator session. */
  interruptWorkflowCreator: (projectId: ULID) =>
    postJson<{ ok: true }>(`/api/projects/${projectId}/workflow-creator/interrupt`, {}),

  /** Kill the workflow-creator session + clear its draft state. Idempotent. */
  stopWorkflowCreator: async (projectId: ULID): Promise<void> => {
    const res = await fetch(`/api/projects/${projectId}/workflow-creator`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error(`stop workflow-creator → ${res.status}`);
  },

  // ── Workflows (4e) ────────────────────────────────────────────────────
  /** Full Workflow def for the drawer's Definition tab + raw YAML text for
   *  4f.2's edit-modal raw-YAML tab. 404 on unknown id. 4h.11a — also returns
   *  the typed-edge map the graph viewer needs to render structured wires. */
  getWorkflow: (projectId: ULID, wfId: string) =>
    getJson<{
      ok: true;
      workflow: Workflow;
      edges?: WorkflowEdges;
      fileName: string;
      yamlText?: string;
    }>(`/api/projects/${projectId}/workflows/${encodeURIComponent(wfId)}`).then((r) => ({
      workflow: r.workflow,
      edges: r.edges ?? {},
      fileName: r.fileName,
      yamlText: r.yamlText ?? '',
    })),

  // ── Workflow lifecycle (4f.2) ─────────────────────────────────────────
  /** Edit an existing workflow in place. Used by both the conversational
   *  edit path (when the model commits via a tool that calls PUT) and the
   *  raw-YAML PM escape hatch. Rejects an id rename with 400 — rename is
   *  duplicate + delete. Throws WorkflowValidationError on 400 shape errors.
   *  Accepts either a typed `def` or raw `yamlText`; the latter is the PM
   *  raw-YAML tab's path and preserves comments + key order on round-trip. */
  editWorkflow: async (
    projectId: ULID,
    wfId: string,
    payload: { def: unknown } | { yamlText: string },
  ): Promise<void> => {
    const res = await fetch(
      `/api/projects/${projectId}/workflows/${encodeURIComponent(wfId)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
    const data = (await res.json()) as {
      ok?: boolean;
      error?: string;
      errors?: { path: string; message: string }[];
    };
    if (res.status === 400 && data.errors) {
      throw new WorkflowValidationError(data.error ?? 'invalid workflow', data.errors);
    }
    if (!res.ok || data.ok === false) {
      throw new Error(data.error ?? `edit workflow → ${res.status}`);
    }
  },

  /** Delete a workflow file. 409 → throws WorkflowInFlightRunsError with the
   *  run-id list; UI surfaces the cancel-runs-and-delete escape. */
  deleteWorkflow: async (projectId: ULID, wfId: string): Promise<void> => {
    const res = await fetch(
      `/api/projects/${projectId}/workflows/${encodeURIComponent(wfId)}`,
      { method: 'DELETE' },
    );
    const data = (await res.json()) as {
      ok?: boolean;
      error?: string;
      inFlightRunIds?: string[];
    };
    if (res.status === 409 && Array.isArray(data.inFlightRunIds)) {
      throw new WorkflowInFlightRunsError(data.inFlightRunIds);
    }
    if (!res.ok || data.ok === false) {
      throw new Error(data.error ?? `delete workflow → ${res.status}`);
    }
  },

  /** Cancel every in-flight run for this workflow, then delete the file. */
  cancelRunsAndDeleteWorkflow: async (
    projectId: ULID,
    wfId: string,
    reason?: string,
  ): Promise<string[]> => {
    const res = await fetch(
      `/api/projects/${projectId}/workflows/${encodeURIComponent(wfId)}/cancel-runs-and-delete`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reason ? { reason } : {}),
      },
    );
    const data = (await res.json()) as {
      ok?: boolean;
      error?: string;
      cancelledRunIds?: string[];
    };
    if (!res.ok || data.ok === false) {
      throw new Error(data.error ?? `cancel-and-delete workflow → ${res.status}`);
    }
    return data.cancelledRunIds ?? [];
  },

  /** Duplicate a workflow. Server clones the YAML with `disabled: true` so the
   *  user doesn't accidentally fire two near-identical workflows. Default newId
   *  is `<src>-copy[-N]` (server-side); pass an explicit newId to override.
   *  409 on newId collision is surfaced as a regular Error so the duplicate
   *  modal can show "name already taken." */
  duplicateWorkflow: (projectId: ULID, wfId: string, newId?: string) =>
    postJson<{ ok: true; workflow: { id: string; fileName: string; path: string } }>(
      `/api/projects/${projectId}/workflows/${encodeURIComponent(wfId)}/duplicate`,
      newId ? { newId } : {},
    ).then((r) => r.workflow),

  /** 4f.3 / D64. User-initiated manual fire. Body is the resolved card +
   *  inputs from the RunNowModal. Throws WorkflowFireError carrying the HTTP
   *  status so the modal can distinguish Work Contract mismatches (400) from
   *  disabled / locked (409) from unknown (404). The error message is
   *  plain-English from the server — render verbatim. */
  fireWorkflow: async (
    projectId: ULID,
    wfId: string,
    body: { workItemId?: string; inputs?: Record<string, unknown> },
  ): Promise<string> => {
    const res = await fetch(
      `/api/projects/${projectId}/workflows/${encodeURIComponent(wfId)}/fire`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    const data = (await res.json()) as { ok?: boolean; runId?: string; error?: string };
    if (res.ok && data.ok === true && typeof data.runId === 'string') {
      return data.runId;
    }
    throw new WorkflowFireError(data.error ?? `fire workflow → ${res.status}`, res.status);
  },

  /** All runs for this project (across workflows). The drawer filters
   *  client-side by workflowId. */
  listWorkflowRuns: (projectId: ULID) =>
    getJson<{ runs: WorkflowRun[] }>(
      `/api/projects/${projectId}/workflow-runs`,
    ).then((r) => r.runs),

  /** Single run with full `nodeOutputs` map. 404 on unknown / cross-project. */
  getWorkflowRun: (projectId: ULID, runId: string) =>
    getJson<{ run: WorkflowRun }>(
      `/api/projects/${projectId}/workflow-runs/${runId}`,
    ).then((r) => r.run),

  /** Re-fire a failed run from a specific failed node. Server creates a NEW
   *  run row (history-preserving) and returns its id. 400 if target run is
   *  not failed/cancelled, target node not failed, or shape errors; 404 for
   *  unknown / cross-project ids. */
  retryWorkflowRunFrom: (projectId: ULID, runId: string, nodeId: string) =>
    postJson<{ ok: true; runId: string }>(
      `/api/projects/${projectId}/workflow-runs/${runId}/retry-from`,
      { nodeId },
    ).then((r) => r.runId),

  /** Cancel a single in-flight workflow run (kills in-flight subagents +
   *  flips status to `cancelled`). 404 unknown / cross-project; 400 if the
   *  run is already terminal. Used by the activity panel's Cancel button. */
  cancelWorkflowRun: (projectId: ULID, runId: string, reason?: string) =>
    postJson<{ ok: true }>(
      `/api/projects/${projectId}/workflow-runs/${runId}/cancel`,
      reason ? { reason } : {},
    ),

  // ── Agent runs (Section 16b.8) ────────────────────────────────────────
  /** Active agent runs for a project. Server filters terminal-state rows
   *  out; the activity panel applies subsequent `agent-run-changed` WS
   *  envelopes as deltas. */
  listAgentRuns: (projectId: ULID) =>
    getJson<{ ok: true; runs: AgentRunRecord[] }>(
      `/api/projects/${projectId}/agent-runs`,
    ).then((r) => r.runs),

  /** Cancel an in-flight agent run. Kills the active session + flips
   *  status to `cancelled`. The terminal `agent-run-changed` envelope is
   *  what removes the card from the Running agents region. */
  cancelAgentRun: (projectId: ULID, runId: string) =>
    postJson<{ ok: boolean; status: string | null }>(
      `/api/projects/${projectId}/agent-runs/${runId}/cancel`,
      {},
    ),

  /** 17b.11 — list waiting pending-asks for a project. Surfaces pending
   *  pause states for dispatched-agent flows that re-open onto a run
   *  that's already paused (e.g. after browser refresh while a
   *  conversation is in-flight). */
  listAgentPendingAsks: (projectId: ULID) =>
    getJson<{ ok: true; pendingAsks: PendingAsk[] }>(
      `/api/projects/${projectId}/agent-pending-asks`,
    ).then((r) => r.pendingAsks),

  /** 17b.11 — submit an answer to a paused agent. `answeredBy: 'user'` for
   *  modal-driven answers; `'orchestrator'` for the orchestrator-proxy
   *  path (unused by the modal but kept symmetric with the MCP tool). */
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

  /** Section 6.6 — list run-ids the user has dismissed from the activity
   *  panel's failed-recently region. Server-scoped to this project via the
   *  workflow_runs join. */
  listFailedRunDismissals: (projectId: ULID) =>
    getJson<{ runIds: string[] }>(
      `/api/projects/${projectId}/failed-run-dismissals`,
    ).then((r) => r.runIds),

  /** Dismiss a failed run from the activity panel's at-a-glance list. The
   *  underlying run record stays intact — only the dismissal is recorded. */
  dismissFailedRun: (projectId: ULID, runId: string) =>
    postJson<{ ok: true; dismissedAt: number }>(
      `/api/projects/${projectId}/workflow-runs/${runId}/dismiss`,
      {},
    ),

  // ── Orchestrator sessions ──────────────────────────────────────────────
  getActiveSession: (projectId: ULID) =>
    getJson<{ ok: true; session: OrchestratorSession | null }>(
      `/api/projects/${projectId}/session`,
    ).then((r) => r.session),

  startNewSession: (projectId: ULID) =>
    postJson<{ ok: true; session: OrchestratorSession }>(
      `/api/projects/${projectId}/sessions/new`,
      {},
    ).then((r) => r.session),

  resumeSession: (projectId: ULID, targetSessionId: ULID) =>
    postJson<{ ok: true; session: OrchestratorSession }>(
      `/api/projects/${projectId}/sessions/${targetSessionId}/resume`,
      {},
    ).then((r) => r.session),

  listSessions: (projectId: ULID) =>
    getJson<{ ok: true; sessions: OrchestratorSession[] }>(
      `/api/projects/${projectId}/sessions`,
    ).then((r) => r.sessions),

  getSessionEvents: (projectId: ULID, sessionId: ULID) =>
    getJson<{ ok: true; events: unknown[] }>(
      `/api/projects/${projectId}/sessions/${sessionId}/events`,
    ).then((r) => r.events),

  // ── Abilities / custom commands ────────────────────────────────────────
  listCustomCommands: (projectId: ULID) =>
    getJson<{ ok: true; commands: CustomCommand[] }>(
      `/api/projects/${projectId}/commands`,
    ).then((r) => r.commands),

  // ── /memory drawer ─────────────────────────────────────────────────────
  getMemoryFile: (projectId: ULID, scope: MemoryScope) =>
    getJson<{ ok: true; file: MemoryFile }>(
      `/api/projects/${projectId}/memory/${scope}`,
    ).then((r) => r.file),

  putMemoryFile: (projectId: ULID, scope: MemoryScope, content: string) =>
    postJsonMethod<{ ok: true; file: MemoryFile }>(
      `/api/projects/${projectId}/memory/${scope}`,
      { content },
      'PUT',
    ).then((r) => r.file),

  // ── Agent pods (Section 17d) ──────────────────────────────────────────
  /** List live pods. Without projectId: globals only. With projectId: union
   *  of globals + that project's project-scope rows. */
  listPods: (projectId?: ULID) => {
    const path = projectId
      ? `/api/agents/pods?projectId=${encodeURIComponent(projectId)}`
      : '/api/agents/pods';
    return getJson<{ pods: Pod[] }>(path).then((r) => r.pods);
  },

  /** Full bundle: agent + knowledge + secrets-metadata-only + mcp servers. */
  getPod: (podId: ULID) =>
    getJson<{ ok: true } & PodBundle>(`/api/agents/pods/${podId}`).then(
      ({ agent, knowledge, secrets, mcpServers }) => ({
        agent,
        knowledge,
        secrets,
        mcpServers,
      }),
    ),

  createPod: (input: CreatePodInput) =>
    postJson<{ ok: true; pod: Pod }>('/api/agents/pods', input).then((r) => r.pod),

  /** Flip a project-scoped pod to global. Throws on 409 (global name collision). */
  promotePodToGlobal: (podId: ULID) =>
    postJson<{ ok: true; pod: Pod }>(
      `/api/agents/pods/${podId}/promote-to-global`,
      {},
    ).then((r) => r.pod),

  /** Clone a pod into a target project as a project-scope row. Copies
   *  scalar fields + knowledge + mcp servers; NOT secrets. Throws 409 on
   *  name collision in the target project. */
  clonePodToProject: (podId: ULID, projectId: ULID, name?: string) =>
    postJson<{ ok: true; pod: Pod; copied: { knowledge: number; mcpServers: number } }>(
      `/api/agents/pods/${podId}/clone-to-project`,
      name ? { projectId, name } : { projectId },
    ).then((r) => ({ pod: r.pod, copied: r.copied })),

  /** Reset a stock pod's scalar fields to its seeded canonical content.
   *  Returns the post-reset row + names of fields that diverged. */
  resetStockPodToDefault: (podId: ULID) =>
    postJson<{ ok: true; pod: Pod; resetFields: string[] }>(
      `/api/agents/pods/${podId}/reset-to-default`,
      {},
    ).then((r) => ({ pod: r.pod, resetFields: r.resetFields })),

  patchPod: (podId: ULID, patch: PatchPodInput) =>
    postJsonMethod<{ ok: true; pod: Pod }>(
      `/api/agents/pods/${podId}`,
      patch,
      'PATCH',
    ).then((r) => r.pod),

  deletePod: async (podId: ULID): Promise<void> => {
    const res = await fetch(`/api/agents/pods/${podId}`, { method: 'DELETE' });
    const data = (await res.json()) as { ok?: boolean; error?: string; kind?: string };
    if (!res.ok || data.ok === false) {
      const msg = data.error ?? `delete pod → ${res.status}`;
      const err = new Error(msg) as Error & { kind?: string; status?: number };
      if (data.kind) err.kind = data.kind;
      err.status = res.status;
      throw err;
    }
  },

  createKnowledge: (
    podId: ULID,
    input: { name: string; content?: string; kind?: PodKnowledgeKind },
  ) =>
    postJson<{ ok: true; knowledge: PodKnowledge }>(
      `/api/agents/pods/${podId}/knowledge`,
      input,
    ).then((r) => r.knowledge),

  patchKnowledge: (
    podId: ULID,
    knowledgeId: ULID,
    patch: { name?: string; content?: string; kind?: PodKnowledgeKind },
  ) =>
    postJsonMethod<{ ok: true; knowledge: PodKnowledge }>(
      `/api/agents/pods/${podId}/knowledge/${knowledgeId}`,
      patch,
      'PATCH',
    ).then((r) => r.knowledge),

  deleteKnowledge: async (podId: ULID, knowledgeId: ULID): Promise<void> => {
    const res = await fetch(`/api/agents/pods/${podId}/knowledge/${knowledgeId}`, {
      method: 'DELETE',
    });
    const data = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || data.ok === false) {
      throw new Error(data.error ?? `delete knowledge → ${res.status}`);
    }
  },

  /** Add a secret. The value goes one-way: server stores it, the GET path
   *  strips it from every readback. To "edit" a secret, delete + recreate. */
  createSecret: (podId: ULID, input: { envVarName: string; valuePlaintext: string }) =>
    postJson<{ ok: true; secret: PodSecret }>(
      `/api/agents/pods/${podId}/secrets`,
      input,
    ).then((r) => r.secret),

  deleteSecret: async (podId: ULID, secretId: ULID): Promise<void> => {
    const res = await fetch(`/api/agents/pods/${podId}/secrets/${secretId}`, {
      method: 'DELETE',
    });
    const data = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || data.ok === false) {
      throw new Error(data.error ?? `delete secret → ${res.status}`);
    }
  },

  createPodMcpServer: (
    podId: ULID,
    input: { name: string; config: PodMcpServerConfig },
  ) =>
    postJson<{ ok: true; mcpServer: PodMcpServer }>(
      `/api/agents/pods/${podId}/mcp-servers`,
      input,
    ).then((r) => r.mcpServer),

  deletePodMcpServer: async (podId: ULID, mcpId: ULID): Promise<void> => {
    const res = await fetch(`/api/agents/pods/${podId}/mcp-servers/${mcpId}`, {
      method: 'DELETE',
    });
    const data = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || data.ok === false) {
      throw new Error(data.error ?? `delete mcp server → ${res.status}`);
    }
  },

  listPodAudit: (podId: ULID, opts: ListAuditOptions = {}) => {
    const qs = new URLSearchParams();
    if (opts.limit !== undefined) qs.set('limit', String(opts.limit));
    if (opts.beforeCreatedAt !== undefined) {
      qs.set('beforeCreatedAt', String(opts.beforeCreatedAt));
    }
    if (opts.actor) qs.set('actor', opts.actor);
    if (opts.field) qs.set('field', opts.field);
    const suffix = qs.toString();
    return getJson<{ ok: true; rows: PodAuditEntry[] }>(
      `/api/agents/pods/${podId}/audit${suffix ? `?${suffix}` : ''}`,
    ).then((r) => r.rows);
  },
};

export type MemoryScope = 'user' | 'project' | 'workspace';

export interface MemoryFile {
  scope: MemoryScope;
  path: string;
  content: string;
  exists: boolean;
}

export interface CustomCommand {
  name: string;
  body: string;
  scope: 'project' | 'user';
}

/** Friendly label for a pod's *stored* model. Falls back to `'opus'` for
 *  `null` or the legacy `'inherit'` alias (retired 2026-05-23; drift-reseed
 *  migrates live rows to `'opus'` on the next boot, but old rows can briefly
 *  show through until then). Concrete values pass through. */
export function resolveModelLabel(model: string | null | undefined): string {
  if (!model || model === 'inherit') return 'opus';
  return model;
}

async function postJsonMethod<T>(
  path: string,
  body: unknown,
  method: 'POST' | 'PATCH' | 'PUT',
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as T & { ok?: boolean; error?: string };
  if (!res.ok || data.ok === false) {
    throw new Error(data.error ?? `${path} → ${res.status}`);
  }
  return data;
}

// ── Workflows wire shapes ──────────────────────────────────────────────────
// Mirror of packages/domain/src/workflow.ts (no @pc/domain dep on the browser
// bundle — see 3d session-log finding #2 for the "web stays off @pc/domain"
// policy). The shapes the server hands us via `workflow-creator-draft` and the
// future GET-workflow endpoints arrive already validated, with each node
// tagged via the `kind` discriminator the validator adds post-parse.

// 4h.11a — typed-edge mirror. Same shapes as packages/domain/src/workflow-
// catalog.ts (CatalogType) + workflow-edges.ts (EdgeRef / NodeEdges). Authors
// never invent CatalogType values; the union is closed-world.

export type CatalogType =
  | 'ulid'
  | 'string'
  | 'text'
  | 'int'
  | 'bool'
  | 'object'
  | 'array';

/** Where a typed-edge value originates. Compact YAML form is `@nodeId.output`
 *  / `@trigger.X` / `@env.NAME`; the structured forms below are what the
 *  server hands us after parse. */
export type EdgeRef =
  | { kind: 'node'; nodeId: string; output: string }
  | { kind: 'trigger'; output: string }
  | { kind: 'env'; name: string };

export interface NodeEdges {
  inputs?: Record<string, EdgeRef>;
  wire?: Record<string, EdgeRef>;
  output_schema?: Record<string, CatalogType>;
}

/** Per-workflow typed-edge map. Keyed by node id; missing keys mean the node
 *  has no typed wires (only literal body fields). */
export type WorkflowEdges = Record<string, NodeEdges>;

export type WorkflowTriggerRule =
  | 'all_success'
  | 'one_success'
  | 'all_done'
  | 'none_failed_min_one_success';

export type WorkflowRetryCause = 'failed' | 'timeout';

export interface WorkflowRetryPolicy {
  max_attempts: number;
  on?: WorkflowRetryCause[];
  delay_ms?: number;
}

export interface WorkflowDoneWhen {
  'files-non-empty'?: string[];
  'output-fields-non-empty'?: string[];
}

interface WfBaseNode {
  id: string;
  depends_on?: string[];
  when?: string;
  trigger_rule?: WorkflowTriggerRule;
  done_when?: WorkflowDoneWhen;
  timeout?: number;
  retry?: WorkflowRetryPolicy;
}

export interface WfSubagentNode extends WfBaseNode {
  kind: 'subagent';
  subagent: string;
  prompt: string;
}

export interface WfBashNode extends WfBaseNode {
  kind: 'bash';
  bash: string;
}

export interface WfHttpNode extends WfBaseNode {
  kind: 'http';
  http: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
    url: string;
    headers?: Record<string, string>;
    body?: string;
    timeout?: number;
  };
}

export interface WfScriptNode extends WfBaseNode {
  kind: 'script';
  script: string;
  runtime: 'node' | 'python';
}

export interface WfApprovalNode extends WfBaseNode {
  kind: 'approval';
  approval: {
    message: string;
    on_reject?: { prompt: string };
  };
}

export interface WfCancelNode extends WfBaseNode {
  kind: 'cancel';
  cancel: string;
}

export interface WfNestedWorkflowNode extends WfBaseNode {
  kind: 'workflow';
  workflow: string;
  inputs?: Record<string, string>;
}

export interface WfLoopNode extends WfBaseNode {
  kind: 'loop';
  loop: {
    body: WfDagNode[];
    until: string;
    max_iterations: number;
  };
}

export interface WfOrchestratorReviewNode extends WfBaseNode {
  kind: 'orchestrator-review';
  'orchestrator-review': {
    prompt: string;
    artifact?: string;
    on_revise?: { prompt: string };
  };
}

export interface WfAttachToWorkItemNode extends WfBaseNode {
  kind: 'attach-to-work-item';
  'attach-to-work-item': {
    workItemId: string;
    name: string;
    content: string;
    kind?: string;
    contentType?: string;
  };
}

export interface WfCreateWorkItemNode extends WfBaseNode {
  kind: 'create-work-item';
  'create-work-item': {
    title: string;
    body?: string;
    stage?: string;
    parentId?: string;
  };
}

export interface WfUpdateWorkItemNode extends WfBaseNode {
  kind: 'update-work-item';
  'update-work-item': {
    workItemId: string;
    title?: string;
    body?: string;
    stage?: string;
    fields?: Record<string, unknown>;
  };
}

export interface WfWriteToWorktreeNode extends WfBaseNode {
  kind: 'write-to-worktree';
  'write-to-worktree': {
    path: string;
    content: string;
    mode?: 'overwrite' | 'append';
  };
}

export type WfDagNode =
  | WfSubagentNode
  | WfBashNode
  | WfHttpNode
  | WfScriptNode
  | WfApprovalNode
  | WfCancelNode
  | WfNestedWorkflowNode
  | WfLoopNode
  | WfAttachToWorkItemNode
  | WfCreateWorkItemNode
  | WfUpdateWorkItemNode
  | WfWriteToWorktreeNode
  | WfOrchestratorReviewNode;

export interface WorkflowTriggers {
  on_enter?: { stage_id: string };
  callable?: boolean;
}

export type AttachedToWorkItem = 'required' | 'optional' | 'forbidden';

export interface Workflow {
  id: string;
  description?: string;
  triggers?: WorkflowTriggers;
  inputs?: Record<string, string>;
  outputs?: Record<string, string>;
  worktree?: 'auto' | 'none';
  scratch_cleanup?: 'auto' | 'keep';
  /** 4f / D62. Workflow is paused — no external fire-path runs it. */
  disabled?: boolean;
  /** 4f / D67. Work Contract: how the workflow relates to a card. */
  attached_to_work_item?: AttachedToWorkItem;
  nodes: WfDagNode[];
}

/** Thrown by deleteWorkflow on 409 — the workflow has runs still in flight.
 *  Carries the run-id list so the UI can present the cancel-runs-and-delete
 *  escape with a count. */
export class WorkflowInFlightRunsError extends Error {
  inFlightRunIds: string[];
  constructor(inFlightRunIds: string[]) {
    super('workflow has in-flight runs');
    this.name = 'WorkflowInFlightRunsError';
    this.inFlightRunIds = inFlightRunIds;
  }
}

/** Thrown by editWorkflow / createWorkflow on 400 validation failure. The
 *  `errors` array maps directly to the server validator's `{ path, message }`
 *  shape so the modal can render inline highlights for the raw-YAML PM
 *  escape hatch + the conversational orchestrator translation for SDRs. */
export class WorkflowValidationError extends Error {
  errors: { path: string; message: string }[];
  constructor(message: string, errors: { path: string; message: string }[]) {
    super(message);
    this.name = 'WorkflowValidationError';
    this.errors = errors;
  }
}

/** Thrown by fireWorkflow on non-2xx. Carries the HTTP status so the
 *  RunNowModal can distinguish 400 (Work Contract / unknown work item) from
 *  409 (disabled / card-locked) from 404 (unknown id). The server message is
 *  plain-English from D74's translation surface — render verbatim. */
export class WorkflowFireError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'WorkflowFireError';
    this.status = status;
  }
}

// ── Workflow-run wire shapes (4e.4) ───────────────────────────────────────
// Mirror of packages/domain/src/workflow-run.ts. Web stays off `@pc/domain`
// per the 3d session-log finding #2.

export type WorkflowRunStatus =
  | 'pending'
  | 'in-progress'
  | 'paused'
  | 'complete'
  | 'failed'
  | 'cancelled';

/** Trigger values that exist today. 4f / 4g will add `manual` / `cron` /
 *  `webhook`; the UI renders unknown values string-graceful so the API can
 *  ship those without a web-side enum bump. */
export type WorkflowRunTrigger = 'on_enter' | 'callable' | 'nested' | string;

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
  /** Set by the runtime for `subagent` kind nodes when the spawn handle
   *  reports jsonlPath (4d D48 / 4e D55). Powers the run-detail "View
   *  transcript" link. Undefined for non-subagent kinds and pre-4e rows. */
  transcriptPath?: string;
}

/** Section 16b.8 — public snapshot of an agent run. Mirrors `AgentRunRecord`
 *  in apps/server/src/services/agent-run-manager.ts. Internal timer / session
 *  fields are stripped server-side before the shape leaves the manager. */
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

// 17b.11 — mirrors packages/domain/src/agent-comms.ts PendingAsk shape.
// Kept inline so the browser bundle stays @pc/domain-free.
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

export interface WorkflowRun {
  id: string;
  workflowId: string;
  trigger?: WorkflowRunTrigger;
  workflowYamlSnapshot?: string;
  status: WorkflowRunStatus;
  startedAt: string;
  completedAt?: string;
  workItemId?: string;
  stageId?: string;
  parentRunId?: string;
  parentNodeId?: string;
  worktreePath: string | null;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  nodeOutputs: Record<string, NodeOutput>;
  lastReason?: string;
  metadata?: Record<string, unknown>;
}
