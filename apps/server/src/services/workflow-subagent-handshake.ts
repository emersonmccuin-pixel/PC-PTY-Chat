// Section 25 Session 10 — MCP handshake routing for workflow-spawned subagents.
//
// Workflow subagent spawns go through `spawnSubagent`, which uses
// `LowLevelSpawn` directly without an `AgentRun` wrapper. Their CC sessions
// never enter the `ActiveRunRegistry` (which is scoped to orchestrator-
// dispatched agents). The /api/internal/mcp-handshake route consults this
// module AFTER v2 active-runs and BEFORE the v1 manager fallback so workflow
// subagents still receive their `notifyMcpHandshake()` callback.
//
// Lifetime: a workflow subagent registers right after `spawn.start()` and
// unregisters on dispatch resolution (success / failure / kill). Mismatched
// pairs would leave a stale entry that drops a future handshake into the
// void; the caller's `done.then(...)` finally-cleanup is the load-bearing
// guarantor here.

const handshakeListeners = new Map<string, () => void>();

/** Register a handshake-notify callback for a CC provider sessionId. The
 *  /api/internal/mcp-handshake route calls the callback exactly once when
 *  pc-rig reports `oninitialized` for this session. Caller MUST call the
 *  returned unregister fn on dispatch resolution. */
export function registerWorkflowSubagentHandshake(
  ccSessionId: string,
  notify: () => void,
): () => void {
  handshakeListeners.set(ccSessionId, notify);
  return () => {
    if (handshakeListeners.get(ccSessionId) === notify) {
      handshakeListeners.delete(ccSessionId);
    }
  };
}

/** Fire the registered notifier (if any) for the given session. Returns
 *  true if a listener was matched and called. Idempotent: the call removes
 *  the listener so a duplicate POST doesn't double-fire. */
export function notifyWorkflowSubagentHandshake(ccSessionId: string): boolean {
  const fn = handshakeListeners.get(ccSessionId);
  if (!fn) return false;
  handshakeListeners.delete(ccSessionId);
  try {
    fn();
  } catch {
    /* notify failures are best-effort */
  }
  return true;
}

/** Test-only utility — drop every listener without invoking. */
export function clearWorkflowSubagentHandshakesForTest(): void {
  handshakeListeners.clear();
}
