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

import type { OrchestratorSession, Project, ULID, Workflow } from '@pc/domain';
import {
  createOrchestratorSession,
  endOrchestratorSession,
  getActiveOrchestratorSession,
  getOrchestratorSession,
  reactivateOrchestratorSession,
} from '@pc/db';
import { jsonlPathFor, PtySession } from '@pc/runtime';
import { WorkflowRegistry } from '@pc/workflows';

import { renderTemplate } from './project-scaffold.ts';
import { preparePodSpawn, type PodSpawnPrep } from './pod-spawn.ts';
import { WorktreeService } from './worktree.ts';
import { WorkflowRuntime, type BroadcastFn } from './workflow-runtime.ts';
import { evaluateBoolean } from './output-substitution.ts';
import { migrateWorkflowsInPlace } from './workflow-boot-migration.ts';
import { WorkItemService } from './work-item.ts';
import { AttachmentService } from './attachment.ts';
import { FieldSchemaService } from './field-schema.ts';
import { getWorkItem, listFieldSchemas } from '@pc/db';

export interface ProjectRuntimeOptions {
  /** Trunk data dir. Per-project subpaths derived from this. */
  dataDir: string;
  /** Channel server port for subagent dispatch + UI proxy. */
  channelPort: number;
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
  private workflowCreator: PtySession | null = null;
  private setupWizard: PtySession | null = null;
  /** Tracks the transient PC_SESSION_ID assigned to the current workflow-
   *  creator. Used to scope draft-state cleanup on session exit. */
  private workflowCreatorSessionId: string | null = null;
  private workflow: WorkflowRuntime | null = null;
  private worktreesSvc: WorktreeService | null = null;
  private registry: WorkflowRegistry | null = null;
  private workItemSvc: WorkItemService | null = null;
  private attachmentSvc: AttachmentService | null = null;
  private fieldSchemaSvc: FieldSchemaService | null = null;
  private hooksRefreshed = false;
  /** Section 4h.8 / D80. Boot-time mandatory typed-edge migration runs once
   *  per ProjectRuntime lifecycle, the first time the workflow registry is
   *  initialised. Flag survives subsequent registry resets — re-running the
   *  scan is cheap (per-file idempotence) but pointless once a project has
   *  been migrated within the current process. */
  private workflowMigrationRan = false;
  /** 4b.1: in-memory workflow-creator drafts keyed by transient PC_SESSION_ID.
   *  Populated by `pc_update_workflow_draft` mid-interview; consumed by the
   *  visualizer via the `workflow-creator-draft` WS envelope. Cleared on
   *  session exit (4b.3's `endWorkflowCreator` plus a sweep in `shutdown()`). */
  private readonly workflowCreatorDrafts: Map<string, Workflow> = new Map();

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

  /** Lazy: workflow YAML registry rooted at `<folder>/.project-companion/workflows/`.
   *  First access runs the 4h.8 typed-edge migration in place — failures
   *  throw, preventing the registry from ever loading legacy-shape YAML. */
  workflowRegistry(): WorkflowRegistry {
    if (!this.registry) {
      const dir = resolve(this.project.folderPath, '.project-companion', 'workflows');
      this.runWorkflowBootMigration(dir);
      this.registry = new WorkflowRegistry(dir);
      this.registry.reload();
    }
    return this.registry;
  }

  /** Section 4h.8 / D80. Runs the boot-time migration on this project's
   *  workflows dir once per ProjectRuntime lifecycle. Delegates the actual
   *  scan + rewrite to `migrateWorkflowsInPlace` in
   *  `workflow-boot-migration.ts`. Logs each rewritten file so the user
   *  has a paper trail; rethrows on any failure so the registry never
   *  loads legacy YAML by accident. */
  private runWorkflowBootMigration(dir: string): void {
    if (this.workflowMigrationRan) return;
    this.workflowMigrationRan = true;
    const stats = migrateWorkflowsInPlace(dir);
    for (const path of stats.migrated) {
      console.log(
        `[project-runtime] migrated workflow to typed-edge shape: ${path} (backup at ${path}.pre-4h.bak)`,
      );
    }
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

  /** Lazy: WorkflowRuntime — instantiated on first work-item / workflow API call. */
  workflowRuntime(): WorkflowRuntime {
    if (!this.workflow) {
      this.workflow = new WorkflowRuntime({
        workspaceDir: this.project.folderPath,
        projectId: this.project.id,
        channelPort: this.opts.channelPort,
        evaluateBoolean,
        broadcast: this.opts.broadcast,
        registry: this.workflowRegistry(),
        worktrees: this.worktrees(),
        workItemService: this.workItemService(),
        attachmentService: this.attachmentService(),
        getProject: () => this.project,
        subagentSessionDirFor: (pcSessionId) => this.sessionDataPath(pcSessionId),
      });
    }
    return this.workflow;
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
   * Lazy: PtySession — spawned on first WS connect. cwd = project.folderPath
   * so `claude.exe --mcp-config .mcp.json` resolves to `<folder>/.mcp.json`
   * (generated at project-create per P7).
   *
   * Session continuity: looks up the active OrchestratorSession row for this
   * project. If found → spawn with `--resume <uuid>` so Claude picks up the
   * conversation it had. If none → mint a UUID, insert a row, spawn with
   * `--session-id <uuid>` so the UI's events.jsonl and Claude's session JSONL
   * stay in lockstep.
   */
  ensurePty(): PtySession {
    if (this.pty && this.pty.getState() !== 'exited') return this.pty;
    this.refreshHooksIfStale();
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
    const jsonlPath = jsonlPathFor(this.project.folderPath, session.providerSessionId);
    // Section 16a.3 — materialise the orchestrator pod into the project's
    // workspace. Replaces the pre-16a `--append-system-prompt-file` lever
    // (which layered PC's PM identity on top of CC's coding-assistant
    // default). `--agent orchestrator` instead REPLACES the default — PC
    // owns the orchestrator's prompt + tool surface end-to-end via the pod
    // row seeded at server boot (16a.2).
    let podPrep: PodSpawnPrep;
    try {
      const prep = preparePodSpawn({
        agentName: 'orchestrator',
        worktreeDir: this.project.folderPath,
        scratchDir: sessionDir,
      });
      if (!prep) {
        // Boot-time seed (16a.2) always inserts the row; a null here
        // means the DB is in an unexpected state (row deleted manually
        // mid-session?). Fail loud — falling back to a default-CC
        // orchestrator would silently lose the locked tool allowlist.
        throw new Error(
          'orchestrator pod row not found (boot-time seed did not run, or row was deleted)',
        );
      }
      podPrep = prep;
    } catch (err) {
      throw new Error(
        `orchestrator pod materialisation failed: ${(err as Error).message}`,
      );
    }

    this.pty = new PtySession({
      workspaceDir: this.project.folderPath,
      stopMarkerPath: resolve(sessionDir, 'stop-markers.txt'),
      eventsPath: resolve(sessionDir, 'events.jsonl'),
      transcriptPath: resolve(sessionDir, 'transcript.log'),
      claudeSessionId: session.providerSessionId,
      resume: session.resume,
      extraEnv: { PC_SESSION_ID: session.row.id, ...podPrep.extraEnv },
      jsonlPath,
      jsonlStartLine: session.resume ? session.row.jsonlLineCursor : 0,
      agentName: 'orchestrator',
      mcpConfigPath: podPrep.mcpConfigPath,
    });

    // Tear down the materialised pod + flip the session row to ended when the
    // PTY exits. 'exit' fires once per lifecycle (claude.exe exit, kill(), or
    // fatal). Explicit-end paths (startNewSession / resumeSession) flip the
    // row BEFORE calling kill(), so by the time this fires they no-op out via
    // getActiveOrchestratorSession returning null. Natural exits (Ctrl+D,
    // claude.exe crash, idle timeout) had no row-flip before this — leaving
    // the DB stuck at status='active' while the chat panel correctly saw the
    // session-end hook event. SessionsRail and Orchestrator disagreed.
    this.pty.once('exit', () => {
      try { podPrep.cleanup(); } catch { /* best-effort */ }
      try {
        const active = getActiveOrchestratorSession(this.project.id);
        if (active) endOrchestratorSession(active.id, 'pty_exit');
      } catch { /* best-effort */ }
    });

    return this.pty;
  }

  /** Returns the live PtySession if one is spawned; otherwise null. */
  ptySession(): PtySession | null {
    return this.pty && this.pty.getState() !== 'exited' ? this.pty : null;
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
    try { this.workflowCreator?.kill(); } catch { /* best-effort */ }
    this.pty = null;
    this.workflowCreator = null;
    this.workflowCreatorSessionId = null;
    this.workflow = null;
    this.worktreesSvc = null;
    this.registry = null;
    this.workItemSvc = null;
    this.attachmentSvc = null;
    this.fieldSchemaSvc = null;
    this.workflowCreatorDrafts.clear();
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
   *     per-pod MCP servers; baseline pc-rig still present)
   *   - cleanup() on session-end removes the materialised .md + mcp.json
   *  Otherwise the wiring (events.jsonl path, transient session id,
   *  hook plumbing) mirrors startAgentCreator. */
  startAgentDesigner(): PtySession {
    this.endAgentDesigner();
    this.refreshHooksIfStale();
    const transientId = `ad-${randomUUID()}`;
    const sessionDir = this.sessionDataPath(transientId);
    mkdirSync(sessionDir, { recursive: true });

    const prep = preparePodSpawn({
      agentName: 'agent-designer',
      worktreeDir: this.project.folderPath,
      scratchDir: sessionDir,
      filterMcpToReferencedTools: false,
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
      extraEnv: { PC_SESSION_ID: transientId, ...prep.extraEnv },
      agentName: 'agent-designer',
      mcpConfigPath: prep.mcpConfigPath,
    });
    return this.agentDesigner;
  }

  /** Returns the live agent-designer PtySession, or null. */
  agentDesignerPty(): PtySession | null {
    return this.agentDesigner && this.agentDesigner.getState() !== 'exited'
      ? this.agentDesigner
      : null;
  }

  /** Kill the agent-designer session + clean up the materialised pod
   *  files. Idempotent. */
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

  /** 4b.1: stash the latest workflow-creator draft for a session. The MCP
   *  tool `pc_update_workflow_draft` calls into this through the matching
   *  HTTP endpoint. Index.ts handles the WS broadcast. */
  setWorkflowCreatorDraft(sessionId: string, def: Workflow): void {
    this.workflowCreatorDrafts.set(sessionId, def);
  }

  /** Lookup helper — currently unused beyond tests + a future "replay on
   *  reconnect" pass. Returns undefined if no draft exists for the session. */
  getWorkflowCreatorDraft(sessionId: string): Workflow | undefined {
    return this.workflowCreatorDrafts.get(sessionId);
  }

  /** Drop draft state for a specific workflow-creator session. 4b.3 calls
   *  this from `endWorkflowCreator`. */
  clearWorkflowCreatorDraft(sessionId: string): void {
    this.workflowCreatorDrafts.delete(sessionId);
  }

  /** 4b.3: transient PtySession driving the conversational workflow-creator
   *  modal. Mirrors `startAgentCreator`. One workflow-creator at a time per
   *  project; calling `start` again kills the prior one. */
  startWorkflowCreator(): PtySession {
    if (this.workflowCreator) {
      try { this.workflowCreator.kill(); } catch { /* best-effort */ }
      this.workflowCreator = null;
    }
    if (this.workflowCreatorSessionId) {
      this.clearWorkflowCreatorDraft(this.workflowCreatorSessionId);
      this.workflowCreatorSessionId = null;
    }
    this.refreshHooksIfStale();
    const transientId = `wc-${randomUUID()}`;
    const sessionDir = this.sessionDataPath(transientId);
    mkdirSync(sessionDir, { recursive: true });
    this.workflowCreator = new PtySession({
      workspaceDir: this.project.folderPath,
      stopMarkerPath: resolve(sessionDir, 'stop-markers.txt'),
      eventsPath: resolve(sessionDir, 'events.jsonl'),
      transcriptPath: resolve(sessionDir, 'transcript.log'),
      extraEnv: { PC_SESSION_ID: transientId },
      appendSystemPromptPath: resolve(
        this.project.folderPath,
        '.project-companion',
        'workflow-creator-prompt.md',
      ),
    });
    this.workflowCreatorSessionId = transientId;
    return this.workflowCreator;
  }

  /** Returns the live workflow-creator PtySession, or null if not started /
   *  exited. */
  workflowCreatorPty(): PtySession | null {
    return this.workflowCreator && this.workflowCreator.getState() !== 'exited'
      ? this.workflowCreator
      : null;
  }

  /** The transient PC_SESSION_ID assigned to the current workflow-creator
   *  PtySession (or the most-recently exited one). Used by the draft-state
   *  endpoint to scope cleanup. */
  workflowCreatorSession(): string | null {
    return this.workflowCreatorSessionId;
  }

  /** Kill the workflow-creator session + clear its draft state. Idempotent. */
  endWorkflowCreator(): void {
    if (this.workflowCreator) {
      try { this.workflowCreator.kill(); } catch { /* best-effort */ }
      this.workflowCreator = null;
    }
    if (this.workflowCreatorSessionId) {
      this.clearWorkflowCreatorDraft(this.workflowCreatorSessionId);
      this.workflowCreatorSessionId = null;
    }
  }

  /** 5.6 / D82: transient PtySession driving the conversational setup wizard
   *  that writes CLAUDE.md. Mirrors startAgentCreator. One wizard at a time
   *  per project — calling start again kills the prior one. */
  startSetupWizard(): PtySession {
    if (this.setupWizard) {
      try { this.setupWizard.kill(); } catch { /* best-effort */ }
      this.setupWizard = null;
    }
    this.refreshHooksIfStale();
    const transientId = `sw-${randomUUID()}`;
    const sessionDir = this.sessionDataPath(transientId);
    mkdirSync(sessionDir, { recursive: true });
    this.setupWizard = new PtySession({
      workspaceDir: this.project.folderPath,
      stopMarkerPath: resolve(sessionDir, 'stop-markers.txt'),
      eventsPath: resolve(sessionDir, 'events.jsonl'),
      transcriptPath: resolve(sessionDir, 'transcript.log'),
      extraEnv: { PC_SESSION_ID: transientId },
      appendSystemPromptPath: resolve(
        this.project.folderPath,
        '.project-companion',
        'setup-wizard-prompt.md',
      ),
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
  }

  private resolveSessionForSpawn(): {
    row: OrchestratorSession;
    providerSessionId: string;
    resume: boolean;
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
    return { row: fresh, providerSessionId: fresh.providerSessionId!, resume: false };
  }

  /**
   * Re-render the project's `.claude/hooks/*.cjs` from the trunk templates
   * once per server boot. The template was updated to read PC_SESSION_ID for
   * per-session path routing; existing projects scaffolded before that
   * update have the old hardcoded-path version and need a refresh. Idempotent;
   * the second call per ProjectRuntime instance is a no-op.
   */
  private refreshHooksIfStale(): void {
    if (this.hooksRefreshed) return;
    this.hooksRefreshed = true;
    const srcDir = resolve(this.opts.templatesDir, '.claude', 'hooks');
    const destDir = resolve(this.project.folderPath, '.claude', 'hooks');
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
      mkdirSync(destDir, { recursive: true });
      for (const f of readdirSync(srcDir)) {
        if (!f.endsWith('.cjs')) continue;
        const raw = readFileSync(resolve(srcDir, f), 'utf-8');
        writeFileSync(resolve(destDir, f), renderTemplate(raw, tokens), 'utf-8');
      }
      // Also re-render settings.json so additions to the template
      // (new hook events, permissions, etc.) reach existing projects without
      // requiring re-scaffold. Section 0 phase 0e added SubagentStop /
      // SessionEnd / Notification entries that need this.
      const settingsSrc = resolve(this.opts.templatesDir, '.claude', 'settings.template.json');
      const settingsDest = resolve(this.project.folderPath, '.claude', 'settings.json');
      if (existsSync(settingsSrc)) {
        const raw = readFileSync(settingsSrc, 'utf-8');
        writeFileSync(settingsDest, renderTemplate(raw, tokens), 'utf-8');
      }
      // Section 16a.4 — orchestrator-prompt.md backfill removed. The
      // orchestrator's identity now lives in the `agents` DB table as a
      // pod row (seeded at boot per 16a.2; materialised into the worktree
      // at spawn per 16a.3). Existing per-project copies of the legacy
      // `.project-companion/orchestrator-prompt.md` are unused post-16a;
      // safe to leave on disk (no reader) or manually delete.

      // Section 4b phase 4b.3: keep the workflow-creator prompt in lock-step
      // with the trunk template. This file backs a transient session that
      // nobody hand-edits — always re-render so changes to the interview
      // script land on next boot.
      const wfCreatorSrc = resolve(
        this.opts.templatesDir,
        '.project-companion',
        'workflow-creator-prompt.md',
      );
      const wfCreatorDest = resolve(
        this.project.folderPath,
        '.project-companion',
        'workflow-creator-prompt.md',
      );
      if (existsSync(wfCreatorSrc)) {
        mkdirSync(resolve(this.project.folderPath, '.project-companion'), { recursive: true });
        const raw = readFileSync(wfCreatorSrc, 'utf-8');
        writeFileSync(wfCreatorDest, renderTemplate(raw, tokens), 'utf-8');
      }
      // 5.6 / D82: setup-wizard prompt. Same always-re-render rule as the
      // workflow-creator — nobody hand-edits this file, and the interview
      // script may evolve between PC versions.
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
      console.error(`[pc] hook refresh failed for ${this.project.slug}:`, (err as Error).message);
    }
  }
}
