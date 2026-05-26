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
  /** Section 27 — typed terminal/intake flags. */
  isDone?: boolean;
  isCancelled?: boolean;
  isNew?: boolean;
}

export interface ProjectSettings {
  cancelledVisibility: 'use-global' | 'force-visible' | 'force-hidden';
}

export interface Project {
  id: ULID;
  slug: string;
  name: string;
  stages: Stage[];
  folderPath: string;
  gitRemote: string | null;
  settings: ProjectSettings;
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
  // Section 26 — work-item-as-contract. Server emits these for every row;
  // web only consumes `isAgentTask` today (26.7 visibility toggle). Other
  // fields land here when their UI consumer arrives.
  isAgentTask: boolean;
  /** Section 35 — display-alias short code (e.g. `pc-2`, `pc-2.1`). NULL on
   *  agent contracts (they don't burn the user-visible number space). */
  callsign: string | null;
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

export type PodScope = 'global' | 'project';
/** Section 36 — provenance lives on the row now (`agents.origin` column),
 *  so consumers read `pod.origin === 'stock'` instead of a hand-maintained
 *  name list. */
export type PodOrigin = 'stock' | 'user-created';
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
  | 'dispatch_guidance'
  | 'knowledge'
  | 'secret'
  | 'mcp_server'
  | 'scope'
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
  /** Section 36 — `'stock'` for PC-seeded pods, `'user-created'` for
   *  everything else. Drives the protected / editable distinction in the UI. */
  origin: PodOrigin;
  /** Section 36 — orchestrator-facing dispatch hint, also surfaced in the
   *  Specialists tab + Pod detail modal. Null for most user-created pods. */
  dispatchGuidance: string | null;
  /** Section 36+ — drift detection vs the canonical seed content. `null` for
   *  non-stock pods (or stock pods without canonical content registered);
   *  `[]` for pristine stock pods; populated with `SEED_OWNED_FIELDS` names
   *  for customised stock pods (drives the "Customized" pill + Reset-all UI). */
  driftedFields: string[] | null;
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
  /** Section 27 — when true, kanban + table views hide cancelled-stage
   *  columns by default. Per-project `cancelledVisibility` overrides. */
  hideCancelledStage: boolean;
  /** Section 10 Phase 2 — ISO timestamp the first-run onboarding wizard was
   *  completed/skipped. `null` = never → the wizard gate shows on boot. */
  onboardingCompletedAt: string | null;
}

export const FONT_SCALE_MIN = 0.85;
export const FONT_SCALE_MAX = 1.5;
export const FONT_SCALE_STEP = 0.05;

// ── Preflight / onboarding (Section 10) ──────────────────────────────────────
// Mirror of apps/server/src/services/preflight.ts PreflightReport.

export interface ClaudePreflight {
  status: 'ok' | 'not-found' | 'version-too-old' | 'unverified';
  path: string | null;
  source: string;
  version: string | null;
  minVersion: string;
}

export interface DependencyProbe {
  name: string;
  present: boolean;
  version: string | null;
  severity: 'hard' | 'soft';
  note?: string;
}

export interface PreflightReport {
  claude: ClaudePreflight;
  auth: { status: 'unknown' | 'authed' | 'login-required'; note: string };
  git: DependencyProbe;
  soft: DependencyProbe[];
  ok: boolean;
}

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

  createFolder: async (input: {
    parentPath: string;
    name: string;
    gateRoot?: string;
  }): Promise<BrowseResult> => {
    const data = await postJson<{
      ok: true;
      path: string;
      parent: string | null;
      entries: BrowseEntry[];
    }>('/api/fs/mkdir', input);
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

  /** Section 1.5 — fetch attachment by id without a work-item path component.
   *  Used by rich-link previews (URL = `pc://attachment/<aId>` only). */
  getAttachmentById: (projectId: ULID, aId: ULID) =>
    getJson<{ ok: true; attachment: Attachment }>(
      `/api/projects/${projectId}/attachments/${aId}`,
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

  // ── Onboarding (Section 10 Phase 2) ──────────────────────────────────────
  getPreflight: () =>
    getJson<{ ok: true; preflight: PreflightReport }>('/api/preflight').then((r) => r.preflight),

  /** Install Claude Code via the official installer. Long-running; returns the
   *  fresh preflight + a log on completion. */
  installClaude: () =>
    postJson<{ ok: true; preflight: PreflightReport; log: string }>(
      '/api/onboarding/install/claude',
      {},
    ),

  /** Install git (winget-first, silent-installer fallback). Long-running. */
  installGit: () =>
    postJson<{ ok: true; preflight: PreflightReport; log: string }>(
      '/api/onboarding/install/git',
      {},
    ),

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

  // ── Workflow-builder (Section 19.9, v2-aware) ─────────────────────────────
  /** Section 19.9 — start the v2 workflow-builder transient session. Returns
   *  the initial state + transient sessionId (used to scope `workflow-builder-
   *  draft` broadcasts to this modal). */
  startWorkflowBuilder: (projectId: ULID) =>
    postJson<{ ok: true; state: string; sessionId: string | null }>(
      `/api/projects/${projectId}/workflow-builder/start`,
      {},
    ).then((r) => ({ state: r.state, sessionId: r.sessionId })),

  /** Send a user prompt into the workflow-builder session. */
  sendWorkflowBuilder: (projectId: ULID, text: string) =>
    postJson<{ ok: true }>(`/api/projects/${projectId}/workflow-builder/send`, { text }),

  /** Press Escape on the workflow-builder session. */
  interruptWorkflowBuilder: (projectId: ULID) =>
    postJson<{ ok: true }>(`/api/projects/${projectId}/workflow-builder/interrupt`, {}),

  /** Kill the workflow-builder session + clear its draft state. Idempotent. */
  stopWorkflowBuilder: async (projectId: ULID): Promise<void> => {
    const res = await fetch(`/api/projects/${projectId}/workflow-builder`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error(`stop workflow-builder → ${res.status}`);
  },

  /** Push a user-drag draft from the visualizer into the server-side store so
   *  the next agent turn sees the position changes (sync-model-A). Same
   *  payload as the MCP-side `pc_save_workflow_draft` write. */
  saveWorkflowBuilderDraft: (
    projectId: ULID,
    sessionId: string,
    def: unknown,
  ) =>
    postJson<{ ok: true }>(`/api/projects/${projectId}/workflow-builder/draft`, {
      sessionId,
      def,
    }),

  // ── Workflow v2 definitions + runs (Section 19.11) ────────────────────────
  /** Section 19.11 — list every v2 workflow definition for a project. */
  listV2WorkflowDefinitions: (projectId: ULID) =>
    getJson<{
      ok: true;
      valid: Array<{ id: string; name: string; workflow: V2WorkflowDefSummary }>;
      invalid: Array<{ fileName: string; errors: string[] }>;
    }>(`/api/projects/${projectId}/workflow-v2/definitions`),

  /** Section 19.11 — list every v2 workflow run for a project (sidecar rows). */
  listV2WorkflowRuns: (projectId: ULID) =>
    getJson<{ ok: true; runs: V2RunSummary[] }>(
      `/api/projects/${projectId}/workflow-v2/runs`,
    ),

  /** Section 19.11 — manual "Run now" for a v2 workflow. The full definition
   *  is passed inline today; the trigger is `manual`. */
  fireV2Workflow: (projectId: ULID, workflow: unknown) =>
    postJson<{ ok: true; runId: string; workItemId?: string }>(
      `/api/projects/${projectId}/workflow-v2/fire`,
      { workflow, trigger: { kind: 'manual' } },
    ),

  /** 19.12 — fetch one v2 run with its sidecar dagState + event log. Backs the
   *  tactical v2 run viewer (Activity Panel jump-to-watch). 404 on unknown id. */
  getV2Run: (projectId: ULID, runId: string) =>
    getJson<{ ok: true; run: V2RunDetail; events: V2RunEvent[] }>(
      `/api/projects/${projectId}/workflow-v2/runs/${encodeURIComponent(runId)}`,
    ),

  /** 19.12 — fetch one parsed v2 workflow def by id. The v2 run viewer pairs
   *  this with `getV2Run` to render live dagState overlays on the graph. */
  getV2WorkflowDef: (projectId: ULID, wfId: string) =>
    getJson<{ ok: true; workflow: V2WorkflowDef; yamlText: string }>(
      `/api/projects/${projectId}/workflow-v2/definitions/${encodeURIComponent(wfId)}`,
    ),

  // 19.12 — v1 workflow client methods removed (getWorkflow, editWorkflow,
  // deleteWorkflow, cancelRunsAndDeleteWorkflow, duplicateWorkflow,
  // fireWorkflow, listWorkflowRuns, getWorkflowRun, retryWorkflowRunFrom,
  // cancelWorkflowRun). Their server routes are gone; v2 surface lives
  // under `/workflow-v2/*` (listV2WorkflowDefinitions / listV2WorkflowRuns
  // / fireV2Workflow / getV2Run / getV2WorkflowDef above).

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

  /** Section 31.7 — latest statusline snapshot for a project; null if none
   *  received yet. Initial-fetch path so the rail caps aren't blank on first
   *  paint after the user opens PC mid-session. */
  getStatuslineSnapshot: (projectId: ULID) =>
    getJson<{ ok: true; snapshot: unknown | null }>(
      `/api/projects/${projectId}/statusline`,
    ).then((r) => r.snapshot),

  /** Section 31.11 — usage aggregation across projects. Server bucket-by-day
   *  / week / month over a window; returns latest-cost-per-session summed
   *  into each bucket. Account-wide cap data lives on the most-recent
   *  snapshot — fetch via getStatuslineSnapshot(activeProject). */
  getUsageAggregate: (
    bucket: 'day' | 'week' | 'month',
    windowDays: number,
  ) =>
    getJson<{
      ok: true;
      bucket: string;
      windowDays: number;
      rows: Array<{
        bucket: string;
        costUsd: number;
        sessions: number;
        inputTokens: number;
        outputTokens: number;
      }>;
    }>(`/api/usage/aggregate?bucket=${bucket}&windowDays=${windowDays}`),

  /** Section 23 — server returns envelope-shape objects so the client can
   *  demux on `type`. New path: `{type:'jsonl', event}`. Legacy fallback:
   *  `{type:'event', event}` (pre-23 hook-written events.jsonl). */
  getSessionEvents: (projectId: ULID, sessionId: ULID) =>
    getJson<{ ok: true; events: Array<{ type: 'jsonl' | 'event'; event: unknown }> }>(
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

  /** Section 36+ — Reset every drifted stock pod in one call. Returns
   *  per-pod summary: which were reset (with the field list), which were
   *  already pristine, and any names registered in the canonical roster
   *  but missing from the DB (shouldn't happen — defensive). */
  resetAllStockPodsToDefault: () =>
    postJson<{
      ok: true;
      reset: Array<{ name: string; resetFields: string[] }>;
      unchanged: string[];
      missing: string[];
    }>(`/api/agents/pods/reset-all-stock-to-default`, {}).then((r) => ({
      reset: r.reset,
      unchanged: r.unchanged,
      missing: r.missing,
    })),

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

// 19.12 — v1 workflow wire shapes (Workflow / WfDagNode / WorkflowTriggers /
// WorkflowEdges / NodeOutput / WorkflowRun + the error classes
// WorkflowInFlightRunsError / WorkflowValidationError / WorkflowFireError)
// removed alongside the v1 server routes + client methods. The v2 wire
// shape lives in `@pc/domain` (`WorkflowV2.Workflow`) and the slim
// `V2WorkflowDefSummary` + `V2RunSummary` types below.

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

/** Public snapshot of an agent run. Mirrors the AgentRunRecord shape the
 *  server emits via the activity-panel shim. Internal timer / session fields
 *  are stripped server-side before the shape leaves the registry. */
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

// Section 19.11 — slim summary shapes for the Workflows tab v2 section. The
// full v2 Workflow type lives in @pc/domain (WorkflowV2.Workflow); the list
// endpoint passes it through verbatim, but the tab only needs id + name +
// trigger count to render the row.
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

/** 19.12 — full v2 run row shape returned by `getV2Run`. dagState is the live
 *  per-node runtime record the viewer overlays onto the graph; fields the
 *  viewer doesn't read are typed loosely as `unknown` to keep the surface narrow. */
export interface V2RunDetail extends V2RunSummary {
  dagState: {
    nodes: Record<string, { state: string; workItemId?: string; iteration?: number; error?: string; startedAt?: number; endedAt?: number }>;
    rejectIterations?: Record<string, number>;
    rejectFeedback?: Record<string, string>;
  };
  workflowYamlSnapshot: string;
  triggerContext: Record<string, unknown>;
  metadata: Record<string, unknown>;
  triggeredBySessionId: string | null;
  lastActivityAt: number | null;
}

/** 19.12 — append-only event for the run's audit log. Not currently rendered
 *  by the viewer; the type exists so `getV2Run` can return the event array
 *  without an `unknown` cast at the call site. */
export interface V2RunEvent {
  id: string;
  runId: string;
  type: string;
  nodeId: string | null;
  data: Record<string, unknown> | null;
  occurredAt: number;
}

/** 19.12 — parsed v2 workflow def returned by `getV2WorkflowDef`. The viewer
 *  passes this straight to `WorkflowGraphV2`. Shape is `WorkflowV2.Workflow`
 *  from `@pc/domain`; opaque on the client (we never inspect node fields). */
export type V2WorkflowDef = V2WorkflowDefSummary & { [key: string]: unknown };
