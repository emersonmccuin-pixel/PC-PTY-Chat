// ProjectRuntime — per-project bundle of PtySession + WorkflowRuntime +
// WorktreeService. Replaces the singleton wiring that lived in apps/server's
// bootstrap during the rig phase. One instance per active project; held by
// ProjectRegistry.
//
// Lazy spawn: the PtySession + WorkflowRuntime are only constructed on first
// access. Lets the server boot with N projects in the DB without spawning N
// claude.exe processes — each waits for a UI subscriber.

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Project, ULID } from '@pc/domain';
import { PtySession } from '@pc/runtime';
import { WorkflowRegistry } from '@pc/workflows';

import { WorktreeService } from './worktree.ts';
import { WorkflowRuntime, type BroadcastFn } from './workflow-runtime.ts';
import { evaluateBoolean, substituteOutputs } from './output-substitution.ts';

export interface ProjectRuntimeOptions {
  /** Trunk data dir. Per-project subpaths derived from this. */
  dataDir: string;
  /** Channel server port for subagent dispatch + UI proxy. */
  channelPort: number;
  /** WS broadcaster pre-bound to this project — registry produces it. */
  broadcast: BroadcastFn;
}

export class ProjectRuntime {
  private pty: PtySession | null = null;
  private workflow: WorkflowRuntime | null = null;
  private worktreesSvc: WorktreeService | null = null;
  private registry: WorkflowRegistry | null = null;

  constructor(public project: Project, private readonly opts: ProjectRuntimeOptions) {}

  get id(): ULID {
    return this.project.id;
  }

  get folderPath(): string {
    return this.project.folderPath;
  }

  /** Where this project's events / transcript / stop-marker / tasks land. */
  get dataPath(): string {
    return resolve(this.opts.dataDir, 'projects', this.project.id);
  }

  /** Refresh the cached `Project` after rename / settings change. */
  refresh(project: Project): void {
    this.project = project;
  }

  /** Lazy: workflow YAML registry rooted at `<folder>/.project-companion/workflows/`. */
  workflowRegistry(): WorkflowRegistry {
    if (!this.registry) {
      const dir = resolve(this.project.folderPath, '.project-companion', 'workflows');
      this.registry = new WorkflowRegistry(dir);
      this.registry.reload();
    }
    return this.registry;
  }

  /** Lazy: WorktreeService bound to this project's repo. P6 reshapes the paths. */
  worktrees(): WorktreeService {
    if (!this.worktreesSvc) {
      this.worktreesSvc = new WorktreeService(this.project.folderPath);
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
        substituteOutputs,
        broadcast: this.opts.broadcast,
        registry: this.workflowRegistry(),
        worktrees: this.worktrees(),
      });
    }
    return this.workflow;
  }

  /**
   * Lazy: PtySession — spawned on first WS connect. cwd = project.folderPath
   * so `claude.exe --mcp-config .mcp.json` resolves to `<folder>/.mcp.json`
   * (generated at project-create per P7).
   */
  ensurePty(): PtySession {
    if (this.pty && this.pty.getState() !== 'exited') return this.pty;
    mkdirSync(this.dataPath, { recursive: true });
    this.pty = new PtySession({
      workspaceDir: this.project.folderPath,
      stopMarkerPath: resolve(this.dataPath, 'stop-markers.txt'),
      eventsPath: resolve(this.dataPath, 'events.jsonl'),
      transcriptPath: resolve(this.dataPath, 'transcript.log'),
    });
    return this.pty;
  }

  /** Returns the live PtySession if one is spawned; otherwise null. */
  ptySession(): PtySession | null {
    return this.pty && this.pty.getState() !== 'exited' ? this.pty : null;
  }

  /** Kill the PtySession (if any) and clear caches so the runtime cold-starts. */
  shutdown(): void {
    try { this.pty?.kill(); } catch { /* best-effort */ }
    this.pty = null;
    this.workflow = null;
    this.worktreesSvc = null;
    this.registry = null;
  }
}
