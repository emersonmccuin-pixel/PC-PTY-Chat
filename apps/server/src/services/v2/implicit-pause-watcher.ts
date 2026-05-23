// Section 25 Session 8 — implicit-pause watcher.
//
// Safety net for the cross-cutting "agent calls pc_ask_* but emits no
// closing assistant text" case. Section 25 Session 7's JsonlTailerV2
// emits `jsonl-pause-detected` when this happens; the explicit pause
// primitive (recordExplicitPauseV2) is the PRIMARY path. The watcher
// fires only as a backstop in case the MCP route didn't observe the
// pause for whatever reason (route handler crashed, race with the
// run terminating, etc.).
//
// Lifecycle: the orchestration layer constructs one watcher per active
// AgentRun at register time. The watcher attaches a JsonlTailerV2 to the
// run's CC session JSONL path. On `jsonl-pause-detected`, it consults the
// caller's `isAlreadyPaused()` predicate (which reads the live AgentRun
// state + checks for an open pending_asks_v2 row); only fires the
// fallback if neither is true.
//
// LowLevelSpawn's primary tailer is v1 — we DON'T swap it here (Session 9
// cutover does). v2 tailer is attached separately; both read the same
// file. Cheap (each emits a different signal set).

import { existsSync } from 'node:fs';

import { v2 as runtimeV2 } from '@pc/runtime';

const { JsonlTailerV2 } = runtimeV2;

export interface ImplicitPauseWatcherInput {
  /** Path to the per-session JSONL the run writes to. Tailer attaches
   *  here. */
  jsonlPath: string;
  /** Called when the tailer's pause-detector fires AND no pause is
   *  already recorded for this run. Caller is responsible for writing
   *  the pending_asks_v2 row + flipping AgentRun → paused + delivering
   *  the agent-asks-* event (same body shape as the explicit path). */
  onPauseDetected: () => void;
  /** Predicate the watcher calls before firing onPauseDetected. Return
   *  true to suppress (run already paused / already terminal / pending
   *  ask already exists). */
  isAlreadyPaused: () => boolean;
  /** Poll interval ms for watchFile. Defaults to the tailer's default. */
  pollIntervalMs?: number;
}

export interface ImplicitPauseWatcher {
  start(): void;
  stop(): void;
}

/** Create (but don't start) an implicit-pause watcher. Callers
 *  start it after the AgentRun reaches running state, and stop it when
 *  the run terminates. */
export function createImplicitPauseWatcher(
  input: ImplicitPauseWatcherInput,
): ImplicitPauseWatcher {
  let tailer: InstanceType<typeof JsonlTailerV2> | null = null;
  let started = false;
  let stopped = false;
  let pollTimer: NodeJS.Timeout | null = null;

  const tryAttach = (): void => {
    if (stopped || tailer) return;
    if (!existsSync(input.jsonlPath)) {
      pollTimer = setTimeout(tryAttach, input.pollIntervalMs ?? 250);
      return;
    }
    tailer = new JsonlTailerV2({
      filePath: input.jsonlPath,
      // Start at end-of-file — historical lines are not pauses we'd want
      // to re-trigger on every run-register call. The tailer's seek
      // would re-trigger on the same already-handled pause event after
      // a server restart otherwise.
      startLine: countLines(input.jsonlPath),
      pollIntervalMs: input.pollIntervalMs,
    });
    tailer.on('event', (ev: { kind: string }) => {
      if (ev.kind === 'jsonl-pause-detected') {
        if (input.isAlreadyPaused()) return;
        input.onPauseDetected();
      }
    });
    tailer.start();
  };

  return {
    start(): void {
      if (started || stopped) return;
      started = true;
      tryAttach();
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      tailer?.stop();
      tailer = null;
    },
  };
}

function countLines(filePath: string): number {
  if (!existsSync(filePath)) return 0;
  try {
    // Cheap: read the file, split, count non-empty. Files at this layer
    // are at most thousands of lines; not worth a stream parser.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    return readFileSync(filePath, 'utf-8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}
