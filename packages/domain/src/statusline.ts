// Section 31.7 — shape of the per-session statusline snapshot PC receives
// from CC's `statusLine.command` hook. Stored in-memory per project (one
// latest snapshot wins); broadcast to all WS subscribers of that project.
//
// Source: CC's `StatusLineCommandInput` type, filtered to the fields PC
// actually surfaces. Quota data is the load-bearing piece (left rail caps);
// model + cost are surfaced opportunistically.

export interface StatuslineRateLimit {
  /** 0-100, may exceed 100 in overage mode. */
  usedPercentage: number;
  /** ISO timestamp. */
  resetsAt: string;
}

export interface StatuslineSnapshot {
  /** PC's session ULID (env PC_SESSION_ID at spawn). */
  pcSessionId: string;
  /** CC's session UUID (from the statusline payload's `session_id`). */
  ccSessionId: string;
  /** Ms since epoch when the server received this snapshot. */
  receivedAt: number;
  model: { id: string; displayName: string } | null;
  /** Account-wide; absent if CC has no quota data yet. */
  rateLimits: {
    fiveHour: StatuslineRateLimit | null;
    sevenDay: StatuslineRateLimit | null;
  };
  /** Per-session running totals from CC's cost-tracker. */
  cost: {
    totalCostUsd: number;
    totalDurationMs: number;
    totalApiDurationMs: number;
  } | null;
  /** Context window — used / total + percentage. */
  contextWindow: {
    currentUsage: number;
    contextWindowSize: number;
    usedPercentage: number;
  } | null;
}
