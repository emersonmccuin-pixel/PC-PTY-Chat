// ProjectRuntime — per-project bundle of PtySession + WorkflowRuntime +
// WorktreeService. Replaces the singleton wiring that lived in apps/server's
// bootstrap during the rig phase. One instance per active project; held by
// ProjectRegistry.
//
// Lazy spawn: the PtySession + WorkflowRuntime are only constructed on first
// access. Lets the server boot with N projects in the DB without spawning N
// claude.exe processes — each waits for a UI subscriber.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { OrchestratorSession, Project, ULID, WorkflowRow, WorkflowV2, WorkItem } from '@pc/domain';
import { isQuickTasksKind, postMoveStatusForStage } from '@pc/domain';
import type { ReviewDecision } from '@pc/workflows';
import {
  createOrchestratorSession,
  endOrchestratorSession,
  getActiveOrchestratorSession,
  getOrchestratorSession,
  moveWorkItemStage,
  reactivateOrchestratorSession,
  workflowsRepo,
} from '@pc/db';
import { claudeConfigDirFromJsonlPath, jsonlPathFor, PtySession } from '@pc/runtime';
import type { SessionState } from '@pc/runtime';
import { selectStageEntryWorkflows } from '@pc/workflows';

import { renderTemplate } from './project-scaffold.ts';
import { preparePodSpawn, type PodSpawnPrep } from './pod-spawn.ts';
import { prepareClaudeRuntimeFiles } from './claude-runtime-bundle.ts';
import { WorktreeService } from './worktree.ts';
import { importV2WorkflowsFromDisk } from './workflow-import.ts';
import {
  fireDagWorkflow,
  applyV2ReviewDecision,
  type DagRunServiceOptions,
} from './dag-run-service.ts';
import { WorkItemService } from './work-item.ts';
import { AttachmentService } from './attachment.ts';
import { FieldSchemaService } from './field-schema.ts';
import { getWorkItem, listFieldSchemas } from '@pc/db';

/** WS broadcast bound to a single project. Was originally exported from the
 *  now-deleted workflow-runtime.ts; lives here so consumers don't need to
 *  drag in a defunct module just for the type alias. */
export type BroadcastFn = (event: unknown) => void;

export interface ProjectRuntimeOptions {
  /** Trunk data dir. Per-project subpaths derived from this. */
  dataDir: string;
  /** Channel server port for subagent dispatch + UI proxy. */
  channelPort: number;
  /** HTTP server port for hook callbacks and pc-rig MCP. */
  serverPort: number;
  /** WS broadcaster pre-bound to this project — registry produces it. */
  broadcast: BroadcastFn;
  /** Templates dir for hook re-render (per-session paths via env var). */
  templatesDir: string;
  /** Trunk repo root. 18.4 — substituted as `{{PC_TRUNK_PATH}}` into the
   *  inbox-drain hook so it can `createRequire` better-sqlite3 from the
   *  trunk's pnpm-managed `node_modules`. */
  trunkPath: string;
}

export class ProjectRuntime {
  private pty: PtySession | null = null;
  /** 17b.12 — transient agent-designer session that spawns CC with
   *  `--agent agent-designer` + the materialised pod (prompt + tools +
   *  knowledge from the agent-designer pod row). One per project at a time.
   *  Pod-spawn cleanup is bound to the session end. */
  private agentDesigner: PtySession | null = null;
  private agentDesignerPrep: PodSpawnPrep | null = null;
  /** Section 19.9 — transient `workflow-builder` stock pod session that drives
   *  the "+ New workflow" modal. v1 `workflowCreator` removed in 19.12. */
  private workflowBuilder: PtySession | null = null;
  private workflowBuilderPrep: PodSpawnPrep | null = null;
  private workflowBuilderSessionId: string | null = null;
  private setupWizard: PtySession | null = null;
  private setupWizardCleanup: (() => void) | null = null;
  private worktreesSvc: WorktreeService | null = null;
  /** Section 19.13 — one-shot YAML→DB import per ProjectRuntime lifetime.
   *  ProjectRegistry calls `bootstrap()` right after construct; the flag
   *  keeps the second call a no-op (defends against hot-reload + ensure()
   *  fallthrough during dev). */
  private workflowsBootstrapped = false;
  private workItemSvc: WorkItemService | null = null;
  private attachmentSvc: AttachmentService | null = null;
  private fieldSchemaSvc: FieldSchemaService | null = null;
  private hooksRefreshed = false;
  /** Section 19.9 — v2 workflow-builder drafts keyed by transient PC_SESSION_ID.
   *  Populated by `pc_save_workflow_draft` mid-interview; consumed by the
   *  visualizer via the `workflow-builder-draft` WS envelope. Cleared on
   *  session exit. */
  private readonly workflowBuilderDrafts: Map<string, WorkflowV2.Workflow> = new Map();

  constructor(public project: Project, private readonly opts: ProjectRuntimeOptions) {}

  get id(): ULID {
    return this.project.id;
  }

  get folderPath(): string {
    return this.project.folderPath;
  }

  /** Per-project data root. Holds the `sessions/` subtree + legacy
   *  project-wide files (until they're all session-scoped). */
  get dataPath(): string {
    return resolve(this.opts.dataDir, 'projects', this.project.id);
  }

  /** Per-session data dir. Hooks read PC_SESSION_ID to write here; the
   *  Sessions tab reads from here to render past chats. */
  sessionDataPath(sessionId: string): string {
    return resolve(this.dataPath, 'sessions', sessionId);
  }

  /**
   * Base dir for this project's worktrees: `<data_dir>/worktrees/<slug>/`.
   * Per `docs/design/multi-tenancy.md` §4 — keeps the user's actual repo clean and
   * namespaces parallel-project worktrees on disk. Slug is locked at create
   * time (rename → slug migration is a deferred followup).
   */
  get worktreeBaseDir(): string {
    return resolve(this.opts.dataDir, 'worktrees', this.project.slug);
  }

  /** Refresh the cached `Project` after rename / settings change. Drops the
   *  cached WorktreeService when slug changes so the next access rebuilds with
   *  the new baseDir. Rename → slug migration itself is a deferred followup.
   *  WorkItemService reads `this.project` via a closure so it picks up the
   *  new stage list automatically without a rebuild. */
  refresh(project: Project): void {
    const slugChanged = project.slug !== this.project.slug;
    this.project = project;
    if (slugChanged) this.worktreesSvc = null;
  }

  /** Section 19.13 — one-shot bootstrap. Called by ProjectRegistry right
   *  after construct() / register(). Runs the v2 YAML → DB importer. Future
   *  one-shot project-init work can chain here.
   *
   *  Idempotent: the second call (e.g. via `ensure()` after `loadAll()`) is
   *  a no-op. Synchronous on purpose — fs reads are cheap, and we want the
   *  import to happen before any UI fetch lands. */
  bootstrap(): void {
    if (this.workflowsBootstrapped) return;
    this.workflowsBootstrapped = true;
    const dir = resolve(this.project.folderPath, '.project-companion', 'workflows');
    try {
      const out = importV2WorkflowsFromDisk({ projectId: this.project.id, workflowsDir: dir });
      if (out.scanned > 0 || out.yamlFilesDeleted > 0) {
        console.log(
          `[pc] workflow-import ${this.project.slug}: scanned=${out.scanned} imported=${out.imported} invalid=${out.importedInvalid} alreadyPresent=${out.alreadyPresent} yamlFilesDeleted=${out.yamlFilesDeleted} skippedNonV2=${out.skippedNonV2}`,
        );
      }
    } catch (err) {
      console.log(
        `[pc] workflow-import ${this.project.slug} failed: ${(err as Error).message}`,
      );
    }
  }

  /** Section 19.17 — DB-backed view of every v2 workflow visible to this
   *  project (project-scope rows + globals). Returns `{ valid, invalid }`
   *  shaped to match the legacy registry surface so the compat GET endpoint
   *  (`/api/projects/:id/workflow-v2/definitions`) can serialize without
   *  reshaping. 19.18 swaps the web client over to `/api/workflows` and the
   *  compat endpoint goes with it. */
  listV2Workflows(): {
    valid: Array<{ id: string; name: string; workflow: WorkflowV2.Workflow; rowId: ULID }>;
    invalid: Array<{ id: string; slug: string; errors: string[] }>;
  } {
    const rows = workflowsRepo.listWorkflows({
      projectId: this.project.id,
      includeGlobals: true,
    });
    const valid: Array<{
      id: string;
      name: string;
      workflow: WorkflowV2.Workflow;
      rowId: ULID;
    }> = [];
    const invalid: Array<{ id: string; slug: string; errors: string[] }> = [];
    for (const r of rows) {
      if (r.status === 'active' && r.parsedDefinition !== null) {
        const wf = r.parsedDefinition as WorkflowV2.Workflow;
        valid.push({ id: r.slug, name: r.name, workflow: wf, rowId: r.id });
      } else {
        invalid.push({
          id: r.id,
          slug: r.slug,
          errors: r.parseError ? [r.parseError] : ['invalid workflow row'],
        });
      }
    }
    return { valid, invalid };
  }

  /** Look up a single v2 workflow by its YAML slug (the legacy in-memory
   *  registry's contract). Used by the slug-based compat GET endpoint;
   *  prefer `getWorkflowById` for new code paths. */
  findV2WorkflowBySlug(slug: string): {
    workflow: WorkflowV2.Workflow;
    yamlText: string;
    row: WorkflowRow;
  } | null {
    const project = workflowsRepo.getWorkflowBySlug({
      slug,
      scope: 'project',
      projectId: this.project.id,
    });
    const row = project ?? workflowsRepo.getWorkflowBySlug({ slug, scope: 'global' });
    if (!row || row.status !== 'active' || row.parsedDefinition === null) return null;
    return {
      workflow: row.parsedDefinition as WorkflowV2.Workflow,
      yamlText: row.yaml,
      row,
    };
  }

  /**
   * Lazy: WorktreeService bound to this project's repo + per-project baseDir
   * under `<data_dir>/worktrees/<slug>/`.
   */
  worktrees(): WorktreeService {
    if (!this.worktreesSvc) {
      this.worktreesSvc = new WorktreeService(this.project.folderPath, this.worktreeBaseDir);
    }
    return this.worktreesSvc;
  }

  /** Section 19.4f — assemble the live deps options for the v2 DAG executor
   *  from this project's existing context (same surfaces WorkflowRuntime uses). */
  private dagRunOptions(): DagRunServiceOptions {
    return {
      projectId: this.project.id,
      workspaceDir: this.project.folderPath,
      channelPort: this.opts.channelPort,
      serverPort: this.opts.serverPort,
      dataDir: this.opts.dataDir,
      templatesDir: this.opts.templatesDir,
      trunkPath: this.opts.trunkPath,
      getProject: () => this.project,
      workItemService: this.workItemService(),
      worktrees: this.worktrees(),
      sessionDirFor: (pcSessionId) => this.sessionDataPath(pcSessionId),
      broadcast: this.opts.broadcast,
    };
  }

  /** Fire a v2 workflow. Returns once the run is set up (root WI + sidecar);
   *  the run itself proceeds in the background (the executor advances on its
   *  own and broadcasts state). Errors after setup are logged, not thrown. */
  async fireV2Workflow(
    workflow: WorkflowV2.Workflow,
    trigger: WorkflowV2.WorkflowTrigger = { kind: 'manual' },
  ): Promise<{ runId: ULID; rootWorkItemId: ULID }> {
    const res = await fireDagWorkflow(workflow, trigger, this.dagRunOptions());
    res.done.catch((err: Error) => {
      console.error(`[dag-run] run ${res.runId} failed:`, err.message);
    });
    return { runId: res.runId, rootWorkItemId: res.rootWorkItemId };
  }

  /** Section 19.12 — pure stage-move + v2 stage-on-entry firing. Reads
   *  `fromStageId` before the move, commits the move (version-checked when
   *  `expectedVersion` is supplied, legacy otherwise), then evaluates v2
   *  workflows whose `stage-on-entry` trigger matches and fires each.
   *
   *  Move errors (unknown stage, version conflict) propagate — the card stays
   *  put. v2 firing errors are logged, not thrown: the move already succeeded
   *  and a misconfigured v2 workflow shouldn't retro-fail the move.
   *
   *  v1's on_enter trigger + lock-on-fire + worktree-ensure semantics are
   *  gone — v2 attaches the run to a `WorkItem` via the runtime's own
   *  attach-to-work-item node instead. */
  async moveAndFireV2(args: {
    id: string;
    toStage: string;
    expectedVersion?: number;
    position?: number;
    notes?: string | null;
  }): Promise<WorkItem> {
    const pre = getWorkItem(args.id as ULID);
    if (!pre) throw new Error(`unknown work item: ${args.id}`);
    const fromStageId = pre.stageId ?? null;
    const destStage = this.project.stages.find((s) => s.id === args.toStage);
    if (!destStage) throw new Error(`unknown stage: ${args.toStage}`);

    let moved: WorkItem;
    if (args.expectedVersion !== undefined) {
      const input: { expectedVersion: number; stageId: string; position?: number } = {
        expectedVersion: args.expectedVersion,
        stageId: args.toStage,
      };
      if (args.position !== undefined) input.position = args.position;
      moved = this.workItemService().move(args.id as ULID, input, args.notes ?? undefined);
    } else {
      // Legacy path (no expectedVersion) — MCP `pc_move_work_item` lands here.
      const targetStatus = postMoveStatusForStage(destStage);
      const out = moveWorkItemStage(args.id as ULID, args.toStage, targetStatus, args.notes ?? null);
      if (!out) throw new Error(`unknown work item: ${args.id}`);
      moved = out;
      this.opts.broadcast({ type: 'work-items-changed', change: 'moved', workItem: moved });
    }

    if (fromStageId !== args.toStage) {
      const stages = (this.project.stages ?? []).map((s) => ({
        id: s.id,
        ...(s.order !== undefined ? { order: s.order } : {}),
      }));
      const validDefs = this.listV2Workflows().valid.map((e) => e.workflow);
      const matches = selectStageEntryWorkflows(validDefs, stages, {
        fromStageId,
        toStageId: args.toStage,
      });
      for (const workflow of matches) {
        try {
          await this.fireV2Workflow(workflow, { kind: 'stage-on-entry', stage: args.toStage });
        } catch (err) {
          console.error(
            `[project-runtime] v2 fire failed (workflow=${workflow.id} stage=${args.toStage}):`,
            (err as Error).message,
          );
        }
      }
    }

    return moved;
  }

  /** Apply an orchestrator/human review decision to a paused v2 run. */
  async applyV2Review(
    runId: ULID,
    reviewNodeId: string,
    decision: ReviewDecision,
  ): Promise<string | null> {
    return applyV2ReviewDecision(runId, reviewNodeId, decision, this.dagRunOptions());
  }

  /** Lazy: WorkItemService — owns create/patch/move/softDelete/restore/list/get
   *  with stage + field validation. workflow-runtime's createWorkItem shim
   *  delegates here. */
  workItemService(): WorkItemService {
    if (!this.workItemSvc) {
      this.workItemSvc = new WorkItemService({
        projectId: this.project.id,
        getProject: () => this.project,
        getFieldSchemas: () => listFieldSchemas(this.project.id),
        broadcast: this.opts.broadcast,
      });
    }
    return this.workItemSvc;
  }

  /** Lazy: AttachmentService — project-scoped facade over the attachments repo,
   *  asserts work-item ownership before any CRUD. */
  attachmentService(): AttachmentService {
    if (!this.attachmentSvc) {
      this.attachmentSvc = new AttachmentService({
        projectId: this.project.id,
        getWorkItem,
        broadcast: this.opts.broadcast,
      });
    }
    return this.attachmentSvc;
  }

  /** Lazy: FieldSchemaService — list + bulk-replace per-project field schemas. */
  fieldSchemaService(): FieldSchemaService {
    if (!this.fieldSchemaSvc) {
      this.fieldSchemaSvc = new FieldSchemaService({
        projectId: this.project.id,
        broadcast: this.opts.broadcast,
      });
    }
    return this.fieldSchemaSvc;
  }

  /**
   * Lazy: PtySession — spawned on first WS connect. cwd is still the user's
   * project folder, but PC's Claude runtime files are passed explicitly from
   * the per-session data dir so terminal-launched Claude does not inherit them.
   *
   * Session continuity: looks up the active OrchestratorSession row for this
   * project. If found → spawn with `--resume <uuid>` so Claude picks up the
   * conversation it had. If none → mint a UUID, insert a row, spawn with
   * `--session-id <uuid>` so the UI's events.jsonl and Claude's session JSONL
   * stay in lockstep.
   */
  ensurePty(): PtySession {
    if (this.pty && this.pty.getState() !== 'exited') return this.pty;
    this.refreshProjectCompanionFilesIfStale();
    const session = this.resolveSessionForSpawn();
    const sessionDir = this.sessionDataPath(session.row.id);
    mkdirSync(sessionDir, { recursive: true });
    // Deterministic JSONL path. With --session-id passed at spawn (gate on
    // by default since 15.3), claude.exe writes to this exact filename. No
    // directory scan, no mtime race, no bleed-through risk from a sibling
    // claude.exe in the same cwd. Uses path-resolver to honor
    // CLAUDE_CONFIG_DIR (was a latent bug pre-Section-23: hardcoded homedir
    // here, CC writes elsewhere when env var is set, hooks hid the
    // mismatch by feeding the chat panel directly).
    const jsonlPath = session.jsonlPath;
    // Section 16a.3 — materialise the project's PM pod into a session-local
    // plugin. Nothing lands in `<project>/.claude`.
    // Replaces the pre-16a `--append-system-prompt-file` lever (which layered
    // PC's PM identity on top of CC's coding-assistant default). `--agent
    // <name>` REPLACES the default — PC owns the prompt + tool surface end-
    // to-end via the pod row seeded at server boot (16a.2).
    //
    // Section 34.2 — Quick Tasks project spawns with `--agent quick-tasks-pm`
    // (constrained tool surface: no specialist dispatch, no work-item-as-
    // contract verbs). All other projects spawn with `--agent orchestrator`.
    const pmAgentName = isQuickTasksKind(this.project.kind)
      ? 'quick-tasks-pm'
      : 'orchestrator';
    let podPrep: PodSpawnPrep;
    try {
      const prep = preparePodSpawn({
        agentName: pmAgentName,
        projectId: this.project.id,
        worktreeDir: this.project.folderPath,
        scratchDir: sessionDir,
        dataDir: this.opts.dataDir,
        templatesDir: this.opts.templatesDir,
        trunkPath: this.opts.trunkPath,
        serverPort: this.opts.serverPort,
        channelPort: this.opts.channelPort,
        projectSlug: this.project.slug,
        projectName: this.project.name,
      });
      if (!prep) {
        // Boot-time seed (16a.2 / 34.2) always inserts the row; a null here
        // means the DB is in an unexpected state (row deleted manually
        // mid-session?). Fail loud — falling back to a default-CC PM
        // would silently lose the locked tool allowlist.
        throw new Error(
          `${pmAgentName} pod row not found (boot-time seed did not run, or row was deleted)`,
        );
      }
      podPrep = prep;
    } catch (err) {
      throw new Error(
        `${pmAgentName} pod materialisation failed: ${(err as Error).message}`,
      );
    }

    this.pty = new PtySession({
      workspaceDir: this.project.folderPath,
      stopMarkerPath: resolve(sessionDir, 'stop-markers.txt'),
      eventsPath: resolve(sessionDir, 'events.jsonl'),
      transcriptPath: resolve(sessionDir, 'transcript.log'),
      claudeSessionId: session.providerSessionId,
      resume: session.resume,
      extraEnv: {
        ...podPrep.extraEnv,
        PC_SESSION_ID: session.row.id,
        ...(session.claudeConfigDir ? { CLAUDE_CONFIG_DIR: session.claudeConfigDir } : {}),
      },
      jsonlPath,
      jsonlStartLine: session.resume ? session.row.jsonlLineCursor : 0,
      agentName: podPrep.agentCliName,
      mcpConfigPath: podPrep.mcpConfigPath,
      settingsPath: podPrep.settingsPath,
      settingSources: podPrep.settingSources,
      pluginDirs: [podPrep.pluginDir],
    });

    // Process lifecycle is not chat lifecycle. A claude.exe child can exit
    // because of a transient resume/config problem, a terminal disconnect, or
    // a user-level Ctrl+D. The orchestrator session row stays active until PC
    // explicitly starts another session; the next ensurePty() resumes the same
    // row from its persisted JSONL path.
    this.pty.once('exit', () => {
      try { podPrep.cleanup(); } catch { /* best-effort */ }
    });

    return this.pty;
  }

  /** Returns the live PtySession if one is spawned; otherwise null. */
  ptySession(): PtySession | null {
    return this.pty && this.pty.getState() !== 'exited' ? this.pty : null;
  }

  /** Returns the current orchestrator PTY state without spawning a process. */
  orchestratorPtyState(): SessionState | null {
    return this.pty ? this.pty.getState() : null;
  }

  /** Returns the active orchestrator session row, if any. */
  activeSession(): OrchestratorSession | null {
    return getActiveOrchestratorSession(this.project.id);
  }

  /**
   * End the current session row, kill the PtySession, and clear cached state.
   * The next `ensurePty()` mints a fresh session row + spawns into a new
   * per-session dir — UI and Claude both start blank, and the prior session's
   * events.jsonl is preserved on disk for the Sessions tab to surface.
   */
  startNewSession(): OrchestratorSession {
    const active = getActiveOrchestratorSession(this.project.id);
    if (active) endOrchestratorSession(active.id, 'user_ended');
    try { this.pty?.kill(); } catch { /* best-effort */ }
    this.pty = null;
    const fresh = createOrchestratorSession({
      projectId: this.project.id,
      providerSessionId: randomUUID(),
    });
    return fresh;
  }

  /**
   * Resume a past orchestrator session by re-activating its row. Ends the
   * current active row (if different), kills the current PtySession,
   * flips the target's status back to 'active' + bumps its startedAt so it
   * sorts to the top of the Sessions list. Next ensurePty() picks up the
   * re-activated row and spawns claude.exe with --resume <uuid>.
   *
   * Identity is preserved — same row id, same title, same conversation. The
   * chat panel re-renders by tailing the existing JSONL from its start.
   *
   * Errors if the target doesn't exist, belongs to another project, has no
   * providerSessionId, or has no JSONL on disk (would fail at spawn anyway).
   * If the target is already the active row, returns it unchanged (no-op).
   */
  resumeSession(targetId: ULID): OrchestratorSession {
    const target = getOrchestratorSession(targetId);
    if (!target) throw new Error(`session not found: ${targetId}`);
    if (target.projectId !== this.project.id) {
      throw new Error('session belongs to a different project');
    }
    if (!target.providerSessionId) {
      throw new Error('session has no claude.exe conversation associated');
    }
    if (target.status === 'active') return target;
    // Prefer the JSONL path the tailer actually stored at write time —
    // that's the ground-truth location on disk. Compute via path-resolver
    // as a fallback for sessions that pre-dated jsonl-path persistence.
    // (Without this preference, sessions spawned with CLAUDE_CONFIG_DIR
    // unset still get a recomputed path under whatever env the current
    // server process has, which can miss legitimate transcripts.)
    const jsonlPath =
      target.jsonlPath ?? jsonlPathFor(this.project.folderPath, target.providerSessionId);
    if (!existsSync(jsonlPath)) {
      throw new Error(
        'no transcript on disk for this conversation (claude.exe never wrote it)',
      );
    }
    const active = getActiveOrchestratorSession(this.project.id);
    if (active && active.id !== targetId) {
      endOrchestratorSession(active.id, 'user_ended');
    }
    try { this.pty?.kill(); } catch { /* best-effort */ }
    this.pty = null;
    const reactivated = reactivateOrchestratorSession(targetId);
    if (!reactivated) throw new Error('reactivation failed');
    return reactivated;
  }

  /**
   * Section 17d.10 — restart-on-pod-edit for the orchestrator. CC memoizes the
   * agent definition per-process, so mid-session pod edits don't propagate
   * until the claude.exe child is killed + respawned. After the kill, the
   * active session row is preserved (same id, same providerSessionId, same
   * JSONL on disk), so the next `ensurePty()` re-spawns with `--resume` and
   * the conversation continues from the same point — only with the new pod
   * content materialised. Returns true if a live PTY was killed (caller is
   * expected to ensure() + re-attach handlers); false if there was nothing
   * to restart.
   *
   * Worker agents (researcher / writer / etc.) deliberately do NOT restart on
   * pod edit — killing them mid-task would orphan their in-flight work. Worker
   * agents pick up new pod content on their next dispatch, which is the safer
   * default.
   */
  restartIfOrchestratorPod(podName: string): boolean {
    if (podName !== 'orchestrator') return false;
    if (!this.pty) return false;
    if (this.pty.getState() === 'exited') return false;
    try { this.pty.kill(); } catch { /* best-effort */ }
    this.pty = null;
    return true;
  }

  /** Kill the PtySession (if any) and clear caches so the runtime cold-starts. */
  shutdown(): void {
    try { this.pty?.kill(); } catch { /* best-effort */ }
    this.endAgentDesigner();
    this.endWorkflowBuilder();
    this.endSetupWizard();
    this.pty = null;
    this.worktreesSvc = null;
    this.workItemSvc = null;
    this.attachmentSvc = null;
    this.fieldSchemaSvc = null;
    this.workflowBuilderDrafts.clear();
  }

  /** 17b.12 — transient agent-designer session backed by the agent-designer
   *  pod (DB-resident; materialised at spawn time). Free-form chat
   *  conversation, like the orchestrator chat but scoped to designing a new
   *  pod. One per project at a time; calling `start` again kills any prior
   *  session. Pod materialisation cleanup is bound to session-end.
   *
   *  Differences from `startAgentCreator`:
   *   - uses `--agent agent-designer` (REPLACES CC's default system prompt
   *     with the pod's content; the pod owns the rulebook)
   *   - materialised pod mcp.json (carries the pod's tool allowlist + any
   *     per-pod MCP servers; session-local baseline pc-rig still present)
   *   - cleanup() on session-end removes the plugin, settings, and mcp.json
   *  Otherwise the wiring (events.jsonl path, transient session id,
   *  hook plumbing) mirrors startAgentCreator. */
  startAgentDesigner(): PtySession {
    this.endAgentDesigner();
    this.refreshProjectCompanionFilesIfStale();
    const transientId = `ad-${randomUUID()}`;
    const sessionDir = this.sessionDataPath(transientId);
    mkdirSync(sessionDir, { recursive: true });
    const cc = this.transientCcSession();

    const prep = preparePodSpawn({
      agentName: 'agent-designer',
      projectId: this.project.id,
      worktreeDir: this.project.folderPath,
      scratchDir: sessionDir,
      filterMcpToReferencedTools: false,
      dataDir: this.opts.dataDir,
      templatesDir: this.opts.templatesDir,
      trunkPath: this.opts.trunkPath,
      serverPort: this.opts.serverPort,
      channelPort: this.opts.channelPort,
      projectSlug: this.project.slug,
      projectName: this.project.name,
    });
    if (!prep) {
      throw new Error(
        'agent-designer pod row not found — boot-time seedStockPods should have ensured it exists',
      );
    }
    this.agentDesignerPrep = prep;

    this.agentDesigner = new PtySession({
      workspaceDir: this.project.folderPath,
      stopMarkerPath: resolve(sessionDir, 'stop-markers.txt'),
      eventsPath: resolve(sessionDir, 'events.jsonl'),
      transcriptPath: resolve(sessionDir, 'transcript.log'),
      claudeSessionId: cc.ccSessionId,
      resume: false,
      jsonlPath: cc.jsonlPath,
      extraEnv: { ...prep.extraEnv, PC_SESSION_ID: transientId },
      agentName: prep.agentCliName,
      mcpConfigPath: prep.mcpConfigPath,
      settingsPath: prep.settingsPath,
      settingSources: prep.settingSources,
      pluginDirs: [prep.pluginDir],
    });
    return this.agentDesigner;
  }

  /** Deterministic CC session identity for a transient (non-resumable) modal
   *  session — agent-designer / workflow-builder / setup-wizard. Mirrors the
   *  orchestrator's session ownership (resolveSessionForSpawn): mint a clean
   *  UUID, pass it as `--session-id`, and tail the EXACT jsonl path CC writes.
   *
   *  Without this, PtySession falls back to a directory scan of
   *  `~/.claude/projects/<cwd-hash>/` and attaches to the newest `.jsonl` by
   *  mtime — which latches onto a SIBLING claude.exe writing into the same
   *  cwd (e.g. a VS Code Claude Code session open in the same project folder),
   *  bleeding that unrelated chat into the modal. The CC session id is
   *  intentionally distinct from PC's internal `PC_SESSION_ID` (the `ad-`/`wc-`/
   *  `sw-` prefixed id that names the on-disk session dir). */
  private transientCcSession(): { ccSessionId: string; jsonlPath: string } {
    const ccSessionId = randomUUID();
    return {
      ccSessionId,
      jsonlPath: jsonlPathFor(this.project.folderPath, ccSessionId),
    };
  }

  /** Returns the live agent-designer PtySession, or null. */
  agentDesignerPty(): PtySession | null {
    return this.agentDesigner && this.agentDesigner.getState() !== 'exited'
      ? this.agentDesigner
      : null;
  }

  /** Kill the agent-designer session + clean up the materialised session-local
   *  runtime files. Idempotent. */
  endAgentDesigner(): void {
    if (this.agentDesigner) {
      try { this.agentDesigner.kill(); } catch { /* best-effort */ }
      this.agentDesigner = null;
    }
    if (this.agentDesignerPrep) {
      try { this.agentDesignerPrep.cleanup(); } catch { /* best-effort */ }
      this.agentDesignerPrep = null;
    }
  }

  // ── Section 19.9 — workflow-builder transient session (v2-aware) ──────────
  //
  // Mirror of `startAgentDesigner` (uses `preparePodSpawn` to materialise the
  // pod's prompt + tool allowlist — REPLACES CC's default identity). Replaces
  // the v1 `workflow-creator` PtySession + draft store, both removed in 19.12.

  /** Section 19.9 — stash the latest v2 workflow-builder draft for a session.
   *  Called by the matching HTTP endpoint when `pc_save_workflow_draft` fires.
   *  Index.ts handles the WS broadcast. */
  setWorkflowBuilderDraft(sessionId: string, def: WorkflowV2.Workflow): void {
    this.workflowBuilderDrafts.set(sessionId, def);
  }

  /** Section 19.9 — read the current draft for a session. Used by
   *  `pc_read_workflow_draft` so the agent can pick up user drags between
   *  turns (sync-model-A). Returns undefined if no draft exists. */
  getWorkflowBuilderDraft(sessionId: string): WorkflowV2.Workflow | undefined {
    return this.workflowBuilderDrafts.get(sessionId);
  }

  /** Section 19.9 — drop draft state for a specific workflow-builder session.
   *  Called from `endWorkflowBuilder`. */
  clearWorkflowBuilderDraft(sessionId: string): void {
    this.workflowBuilderDrafts.delete(sessionId);
  }

  /** Section 19.9 — transient PtySession driving the conversational v2
   *  workflow-builder modal. Spawned with `--agent workflow-builder` (replaces
   *  CC's default identity with the pod's content). One workflow-builder at a
   *  time per project; calling `start` again kills the prior one. */
  startWorkflowBuilder(): PtySession {
    this.endWorkflowBuilder();
    this.refreshProjectCompanionFilesIfStale();
    const transientId = `wb-${randomUUID()}`;
    const sessionDir = this.sessionDataPath(transientId);
    mkdirSync(sessionDir, { recursive: true });
    const cc = this.transientCcSession();

    const prep = preparePodSpawn({
      agentName: 'workflow-builder',
      projectId: this.project.id,
      worktreeDir: this.project.folderPath,
      scratchDir: sessionDir,
      filterMcpToReferencedTools: false,
      dataDir: this.opts.dataDir,
      templatesDir: this.opts.templatesDir,
      trunkPath: this.opts.trunkPath,
      serverPort: this.opts.serverPort,
      channelPort: this.opts.channelPort,
      projectSlug: this.project.slug,
      projectName: this.project.name,
    });
    if (!prep) {
      throw new Error(
        'workflow-builder pod row not found — boot-time seedStockPods should have ensured it exists',
      );
    }
    this.workflowBuilderPrep = prep;

    this.workflowBuilder = new PtySession({
      workspaceDir: this.project.folderPath,
      stopMarkerPath: resolve(sessionDir, 'stop-markers.txt'),
      eventsPath: resolve(sessionDir, 'events.jsonl'),
      transcriptPath: resolve(sessionDir, 'transcript.log'),
      claudeSessionId: cc.ccSessionId,
      resume: false,
      jsonlPath: cc.jsonlPath,
      extraEnv: { ...prep.extraEnv, PC_SESSION_ID: transientId },
      agentName: prep.agentCliName,
      mcpConfigPath: prep.mcpConfigPath,
      settingsPath: prep.settingsPath,
      settingSources: prep.settingSources,
      pluginDirs: [prep.pluginDir],
    });
    this.workflowBuilderSessionId = transientId;
    return this.workflowBuilder;
  }

  /** Returns the live workflow-builder PtySession, or null if not started /
   *  exited. */
  workflowBuilderPty(): PtySession | null {
    return this.workflowBuilder && this.workflowBuilder.getState() !== 'exited'
      ? this.workflowBuilder
      : null;
  }

  /** The transient PC_SESSION_ID assigned to the current workflow-builder
   *  PtySession (or the most-recently exited one). Used by the draft-state
   *  endpoint to scope cleanup. */
  workflowBuilderSession(): string | null {
    return this.workflowBuilderSessionId;
  }

  /** Kill the workflow-builder session + clean up the materialised
   *  session-local runtime files + drop its draft state. Idempotent. */
  endWorkflowBuilder(): void {
    if (this.workflowBuilder) {
      try { this.workflowBuilder.kill(); } catch { /* best-effort */ }
      this.workflowBuilder = null;
    }
    if (this.workflowBuilderPrep) {
      try { this.workflowBuilderPrep.cleanup(); } catch { /* best-effort */ }
      this.workflowBuilderPrep = null;
    }
    if (this.workflowBuilderSessionId) {
      this.clearWorkflowBuilderDraft(this.workflowBuilderSessionId);
      this.workflowBuilderSessionId = null;
    }
  }

  /** 5.6 / D82: transient PtySession driving the conversational setup wizard
   *  that writes CLAUDE.md. Mirrors startAgentCreator. One wizard at a time
   *  per project — calling start again kills the prior one. */
  startSetupWizard(): PtySession {
    if (this.setupWizard) {
      this.endSetupWizard();
    }
    this.refreshProjectCompanionFilesIfStale();
    const transientId = `sw-${randomUUID()}`;
    const sessionDir = this.sessionDataPath(transientId);
    mkdirSync(sessionDir, { recursive: true });
    const cc = this.transientCcSession();
    const runtimeFiles = prepareClaudeRuntimeFiles({
      scratchDir: sessionDir,
      worktreeDir: this.project.folderPath,
      projectId: this.project.id,
      projectSlug: this.project.slug,
      projectName: this.project.name,
      dataDir: this.opts.dataDir,
      templatesDir: this.opts.templatesDir,
      trunkPath: this.opts.trunkPath,
      serverPort: this.opts.serverPort,
      channelPort: this.opts.channelPort,
    });
    this.setupWizardCleanup = runtimeFiles.cleanup;
    this.setupWizard = new PtySession({
      workspaceDir: this.project.folderPath,
      stopMarkerPath: resolve(sessionDir, 'stop-markers.txt'),
      eventsPath: resolve(sessionDir, 'events.jsonl'),
      transcriptPath: resolve(sessionDir, 'transcript.log'),
      claudeSessionId: cc.ccSessionId,
      resume: false,
      jsonlPath: cc.jsonlPath,
      extraEnv: { ...runtimeFiles.extraEnv, PC_SESSION_ID: transientId },
      mcpConfigPath: runtimeFiles.mcpConfigPath,
      settingsPath: runtimeFiles.settingsPath,
      settingSources: runtimeFiles.settingSources,
      appendSystemPromptPath: resolve(
        this.project.folderPath,
        '.project-companion',
        'setup-wizard-prompt.md',
      ),
    });
    this.setupWizard.once('exit', () => {
      if (this.setupWizardCleanup) {
        try { this.setupWizardCleanup(); } catch { /* best-effort */ }
        this.setupWizardCleanup = null;
      }
    });
    return this.setupWizard;
  }

  /** Returns the live setup-wizard PtySession, or null if not started / exited. */
  setupWizardPty(): PtySession | null {
    return this.setupWizard && this.setupWizard.getState() !== 'exited'
      ? this.setupWizard
      : null;
  }

  /** Kill the setup-wizard session. Idempotent. */
  endSetupWizard(): void {
    if (!this.setupWizard) return;
    try { this.setupWizard.kill(); } catch { /* best-effort */ }
    this.setupWizard = null;
    if (this.setupWizardCleanup) {
      try { this.setupWizardCleanup(); } catch { /* best-effort */ }
      this.setupWizardCleanup = null;
    }
  }

  private resolveSessionForSpawn(): {
    row: OrchestratorSession;
    providerSessionId: string;
    resume: boolean;
    jsonlPath: string;
    claudeConfigDir: string | null;
  } {
    const active = getActiveOrchestratorSession(this.project.id);
    if (active?.providerSessionId) {
      // Only resume if claude.exe has a JSONL on disk for this UUID. UUIDs
      // minted in the DB without a matching JSONL ("phantoms") happen when
      // a row pre-dates --session-id rollout or was never spawned. Passing
      // --resume on a phantom UUID makes claude.exe exit with "No
      // conversation found with session ID..." — pass --session-id to mint
      // at the recorded UUID instead.
      const expectedJsonl = active.jsonlPath ?? jsonlPathFor(
        this.project.folderPath,
        active.providerSessionId,
      );
      return {
        row: active,
        providerSessionId: active.providerSessionId,
        resume: existsSync(expectedJsonl),
        jsonlPath: expectedJsonl,
        claudeConfigDir: active.jsonlPath
          ? claudeConfigDirFromJsonlPath(active.jsonlPath)
          : null,
      };
    }
    if (active) {
      // Row exists but no provider id — shouldn't happen since we mint at
      // create-time, but treat it as resume-with-no-target → end and re-mint.
      endOrchestratorSession(active.id, 'provider_session_lost');
    }
    const fresh = createOrchestratorSession({
      projectId: this.project.id,
      providerSessionId: randomUUID(),
    });
    return {
      row: fresh,
      providerSessionId: fresh.providerSessionId!,
      resume: false,
      jsonlPath: jsonlPathFor(this.project.folderPath, fresh.providerSessionId!),
      claudeConfigDir: null,
    };
  }

  /**
   * Backfill project-visible PC files that are intentionally part of the repo
   * scaffold (`.project-companion/*`). Claude runtime files (`.mcp.json`,
   * `.claude/settings.json`, hooks, and agents) are now session-local and must
   * never be refreshed into the user's project root.
   */
  private refreshProjectCompanionFilesIfStale(): void {
    if (this.hooksRefreshed) return;
    this.hooksRefreshed = true;
    const tokens = {
      PROJECT_DATA_DIR: this.dataPath.replace(/\\/g, '/'),
      PROJECT_ID: this.project.id,
      PROJECT_SLUG: this.project.slug,
      PROJECT_NAME: this.project.name,
      PROJECT_FOLDER: this.project.folderPath.replace(/\\/g, '/'),
      // 18.4 — added so refresh-on-boot picks up the inbox-drain hook template
      // for projects scaffolded pre-18.4. Trunk path resolves better-sqlite3
      // via createRequire from the hook script; db path is the global
      // PC sqlite file the drain query reads from.
      PC_TRUNK_PATH: this.opts.trunkPath.replace(/\\/g, '/'),
      PC_DB_PATH: resolve(this.opts.dataDir, 'pc.sqlite').replace(/\\/g, '/'),
    };
    try {
      // Section 16a.4 — orchestrator-prompt.md backfill removed. The
      // orchestrator's identity now lives in the `agents` DB table as a
      // pod row (seeded at boot per 16a.2; materialised into a session-local
      // plugin at spawn). Existing per-project copies of the legacy
      // `.project-companion/orchestrator-prompt.md` are unused post-16a;
      // safe to leave on disk (no reader) or manually delete.

      // 19.12 — workflow-creator-prompt.md backfill removed. The v1
      // workflow-creator session (which `appendSystemPromptPath`-ed this file
      // onto CC's default identity) is gone; v2 uses the workflow-builder
      // stock pod via `preparePodSpawn`. Existing per-project copies are
      // unused; safe to leave on disk or manually delete.

      // 5.6 / D82: setup-wizard prompt. Always-re-render (nobody hand-edits
      // this file, and the interview script may evolve between PC versions).
      const swCreatorSrc = resolve(
        this.opts.templatesDir,
        '.project-companion',
        'setup-wizard-prompt.md',
      );
      const swCreatorDest = resolve(
        this.project.folderPath,
        '.project-companion',
        'setup-wizard-prompt.md',
      );
      if (existsSync(swCreatorSrc)) {
        mkdirSync(resolve(this.project.folderPath, '.project-companion'), { recursive: true });
        const raw = readFileSync(swCreatorSrc, 'utf-8');
        writeFileSync(swCreatorDest, renderTemplate(raw, tokens), 'utf-8');
      }
      // Section 3 phase 3i: backfill any workflow YAMLs from templates that
      // don't yet exist in the project. Write-if-missing — user-edited copies
      // of seed workflows (bash-loop.yaml, approval-demo.yaml, etc.) survive.
      // New built-in workflows land in existing projects on next boot.
      const workflowsSrc = resolve(this.opts.templatesDir, '.project-companion', 'workflows');
      const workflowsDest = resolve(this.project.folderPath, '.project-companion', 'workflows');
      if (existsSync(workflowsSrc)) {
        mkdirSync(workflowsDest, { recursive: true });
        for (const f of readdirSync(workflowsSrc)) {
          if (!f.endsWith('.yaml')) continue;
          const destFile = resolve(workflowsDest, f);
          if (existsSync(destFile)) continue;
          const raw = readFileSync(resolve(workflowsSrc, f), 'utf-8');
          writeFileSync(destFile, raw, 'utf-8');
        }
      }
    } catch (err) {
      console.error(`[pc] project companion refresh failed for ${this.project.slug}:`, (err as Error).message);
    }
  }
}
