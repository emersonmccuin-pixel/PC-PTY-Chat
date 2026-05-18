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
  fields: Record<string, unknown>;
  version: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
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
}

export type CreateProjectMode = 'init-empty' | 'init-in-place';

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

  browseFolder: async (path?: string): Promise<BrowseResult> => {
    const qs = path ? `?path=${encodeURIComponent(path)}` : '';
    const res = await fetch(`/api/fs/browse${qs}`);
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
  createWorkItem: (
    projectId: ULID,
    title: string,
    stageId: string,
    opts: { body?: string; parentId?: ULID | null } = {},
  ) =>
    postJson<{ ok: true; workItem: WorkItem }>(
      `/api/projects/${projectId}/work-items/create`,
      { title, stageId, ...opts },
    ),
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

  getMcpStatus: () =>
    getJson<{ alive: boolean; toolCount: number; tools: string[] }>('/api/mcp-status'),

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

  // ── Agents (Section 3 D2) ────────────────────────────────────────────────
  // Globals live in the PC library and surface in every project. A project
  // file with the same name as a global is an "override" — editing a global
  // from inside a project creates one. Project-only entries are agents the
  // user authored just for this project.

  listAgents: () =>
    getJson<{ agents: AgentEntry[] }>('/api/agents').then((r) => r.agents),

  createLibraryAgent: (name: string, body: string) =>
    postJson<{ ok: true; agent: AgentEntry }>('/api/agents', { name, body }).then((r) => r.agent),

  listProjectAgents: (projectId: ULID) =>
    getJson<{
      ok: true;
      globals: ResolvedAgent[];
      overrides: ResolvedAgent[];
      projectOnly: ResolvedAgent[];
    }>(`/api/projects/${projectId}/agents`).then((r) => ({
      globals: r.globals,
      overrides: r.overrides,
      projectOnly: r.projectOnly,
    })),

  /** Update an agent in the context of a project. Accepts either the raw
   *  full-file text (YAML-view path) or a typed `{ def, markdown }` payload
   *  (form-view path). Server validates `def` and round-trips through the
   *  existing file as basis so comments / unknown keys / node style survive. */
  updateProjectAgent: (
    projectId: ULID,
    name: string,
    payload: { body: string } | { def: AgentDef; markdown: string },
  ) =>
    fetch(`/api/projects/${projectId}/agents/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(async (res) => {
      const data = (await res.json()) as {
        ok?: boolean;
        agent?: AgentEntry;
        error?: string;
        errors?: AgentValidationIssue[];
      };
      if (!res.ok || data.ok === false) {
        const err = new Error(data.error ?? `update agent → ${res.status}`) as Error & {
          fieldErrors?: AgentValidationIssue[];
        };
        if (data.errors) err.fieldErrors = data.errors;
        throw err;
      }
      return data.agent as AgentEntry;
    }),

  /** Promote a project agent to the global library. Server replaces the
   *  global (if `name` matches one) or adds a new global; the project file
   *  is then deleted so the entry surfaces as a Global. */
  promoteAgentToGlobal: (projectId: ULID, name: string) =>
    postJson<{ ok: true; kind: 'replaced-global' | 'added-global'; agent: AgentEntry }>(
      `/api/projects/${projectId}/agents/${encodeURIComponent(name)}/promote-to-global`,
      {},
    ).then((r) => ({ kind: r.kind, agent: r.agent })),

  /** Delete a project agent file. When the deleted file shadowed a global,
   *  the global re-surfaces ("reset to global"). When the file was
   *  project-only, the agent is fully removed. */
  deleteProjectAgent: (projectId: ULID, name: string) =>
    fetch(`/api/projects/${projectId}/agents/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }).then(async (res) => {
      const data = (await res.json()) as {
        ok?: boolean;
        kind?: 'reset-to-global' | 'project-only';
        error?: string;
      };
      if (!res.ok || data.ok === false) {
        throw new Error(data.error ?? `delete → ${res.status}`);
      }
      return data.kind ?? 'project-only';
    }),

  // ── Agent-creator transient session (Section 3 phase 3e.3) ───────────────
  /** Spawn the per-project Create-Agent modal's transient PtySession. The
   *  session is layered with `agent-creator-prompt.md` and emits its events
   *  on the `agent-creator-*` WS envelope kinds. */
  startAgentCreator: (projectId: ULID) =>
    postJson<{ ok: true; state: string }>(
      `/api/projects/${projectId}/agent-creator/start`,
      {},
    ).then((r) => r.state),

  /** Send a user prompt into the modal's transient session. */
  sendAgentCreator: (projectId: ULID, text: string) =>
    postJson<{ ok: true }>(`/api/projects/${projectId}/agent-creator/send`, { text }),

  /** Press Escape on the modal's session (matches orchestrator interrupt). */
  interruptAgentCreator: (projectId: ULID) =>
    postJson<{ ok: true }>(`/api/projects/${projectId}/agent-creator/interrupt`, {}),

  /** Kill the modal's transient session. Idempotent. */
  stopAgentCreator: async (projectId: ULID): Promise<void> => {
    const res = await fetch(`/api/projects/${projectId}/agent-creator`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error(`stop agent-creator → ${res.status}`);
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

export interface AgentEntry {
  name: string;
  /** Full file text as on disk (frontmatter + body). */
  body: string;
  /** Parsed typed view of the YAML frontmatter. Omitted when the file
   *  failed to parse — UI should fall back to the raw `body`. */
  def?: AgentDef;
  /** Markdown body below the closing `---`. Omitted when the file failed to
   *  parse. */
  markdown?: string;
  /** Structured parse error, when applicable. */
  parseError?: { reason: string; message: string };
}

export type ResolvedAgentKind = 'global' | 'override' | 'project';

export interface ResolvedAgent extends AgentEntry {
  kind: ResolvedAgentKind;
  /** Library version body when `kind === 'override'`. Lets the UI surface a
   *  Reset action without a second roundtrip. */
  globalBody?: string;
}

// Mirror of @pc/domain's AgentDef shape. Kept inline so the web bundle
// stays import-cycle-free with the server domain package.
export type AgentColor =
  | 'red'
  | 'blue'
  | 'green'
  | 'yellow'
  | 'purple'
  | 'orange'
  | 'pink'
  | 'cyan';

export const AGENT_COLORS: readonly AgentColor[] = [
  'red',
  'blue',
  'green',
  'yellow',
  'purple',
  'orange',
  'pink',
  'cyan',
];

export type AgentModelShort = 'haiku' | 'sonnet' | 'opus' | 'inherit';
export const AGENT_MODEL_SHORTCUTS: readonly AgentModelShort[] = [
  'haiku',
  'sonnet',
  'opus',
  'inherit',
];

export type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const AGENT_EFFORTS: readonly AgentEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export type AgentMemoryScope = 'user' | 'project' | 'local';

export interface AgentHookEntry {
  matcher?: string;
  command: string;
}
export type AgentHooks = Record<string, AgentHookEntry[]>;

export interface InlineMcpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  extras?: Record<string, unknown>;
}
export type AgentMcpServerRef = string | InlineMcpServer;

export interface AgentDef {
  name: string;
  description: string;
  color?: AgentColor;
  model?: string;
  effort?: AgentEffort;
  maxTurns?: number;
  background?: boolean;
  tools?: string[];
  disallowedTools?: string[];
  mcpServers?: AgentMcpServerRef[];
  isolation?: 'worktree';
  memory?: AgentMemoryScope;
  hooks?: AgentHooks;
  skills?: string[];
  permissionMode?: string;
  initialPrompt?: string;
}

export interface AgentValidationIssue {
  field: string;
  message: string;
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
