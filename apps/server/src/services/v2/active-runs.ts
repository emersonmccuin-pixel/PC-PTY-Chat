// Section 25 Session 8 — in-memory registry of active v2 AgentRuns.
//
// Pause / resume / continuation primitives need a way to look up a live
// AgentRun by various identifiers — agent_run_id (the primary key), the
// pending_ask_id of an outstanding pause, or the CC provider session-id
// when the JSONL pause-detector fires.
//
// The registry is a thin process-wide Map. It does NOT own AgentRun
// lifecycle — callers `register(run)` after `run.start()` and the registry
// auto-unregisters on the run's `terminal` event (cap-slot freed +
// completed | failed | cancelled).
//
// Each entry carries dispatcher metadata so the pause/resume layer can
// build the channel-event body (which references projectId / dispatcher
// session / parent work item) without re-querying the DB.
//
// Section 9's MCP tool wiring is the primary caller. Section 10 wires the
// workflow runtime + activity panel adapters.

import type { ULID } from '@pc/domain';
import type { v2 as runtimeV2 } from '@pc/runtime';

type AgentRun = runtimeV2.AgentRun;

export interface ActiveRunEntry {
  run: AgentRun;
  projectId: ULID;
  dispatcherSessionId: string;
  ccSessionId: string;
  podName: string;
  parentWorkItemId: ULID | null;
  /** Pod row's `updated_at` (or revision string) captured at dispatch time.
   *  Drives §6.4 drift detection on resume. NULL when the materialiser
   *  didn't supply one. */
  podRevisionAtDispatch: string | null;
  registeredAt: number;
}

export interface RegisterActiveRunInput {
  run: AgentRun;
  projectId: ULID;
  dispatcherSessionId: string;
  ccSessionId: string;
  podName: string;
  parentWorkItemId?: ULID | null;
  podRevisionAtDispatch?: string | null;
  now?: number;
}

export class ActiveRunRegistry {
  private byRunId = new Map<string, ActiveRunEntry>();
  private byCcSession = new Map<string, ActiveRunEntry>();

  register(input: RegisterActiveRunInput): ActiveRunEntry {
    const entry: ActiveRunEntry = {
      run: input.run,
      projectId: input.projectId,
      dispatcherSessionId: input.dispatcherSessionId,
      ccSessionId: input.ccSessionId,
      podName: input.podName,
      parentWorkItemId: input.parentWorkItemId ?? null,
      podRevisionAtDispatch: input.podRevisionAtDispatch ?? null,
      registeredAt: input.now ?? Date.now(),
    };
    const runId = entry.run.getRecord().agentRunId;
    this.byRunId.set(runId, entry);
    this.byCcSession.set(entry.ccSessionId, entry);

    // Auto-cleanup on terminal. The terminal event fires exactly once per
    // run lifetime; subsequent listeners are no-ops because the run won't
    // emit further.
    const onTerminal = () => {
      this.unregister(runId);
    };
    entry.run.once('terminal', onTerminal);
    return entry;
  }

  unregister(agentRunId: string): void {
    const entry = this.byRunId.get(agentRunId);
    if (!entry) return;
    this.byRunId.delete(agentRunId);
    if (this.byCcSession.get(entry.ccSessionId) === entry) {
      this.byCcSession.delete(entry.ccSessionId);
    }
  }

  get(agentRunId: string): ActiveRunEntry | null {
    return this.byRunId.get(agentRunId) ?? null;
  }

  getByCcSession(ccSessionId: string): ActiveRunEntry | null {
    return this.byCcSession.get(ccSessionId) ?? null;
  }

  list(): ActiveRunEntry[] {
    return Array.from(this.byRunId.values());
  }

  /** Test-only utility — drop every entry without invoking listeners. */
  clear(): void {
    this.byRunId.clear();
    this.byCcSession.clear();
  }
}

let singleton: ActiveRunRegistry | null = null;

export function getActiveRunRegistry(): ActiveRunRegistry {
  if (!singleton) singleton = new ActiveRunRegistry();
  return singleton;
}

/** Test-only override. Pass `null` to revert to a fresh singleton on the
 *  next `getActiveRunRegistry()` call. */
export function setActiveRunRegistryForTest(reg: ActiveRunRegistry | null): void {
  singleton = reg;
}
