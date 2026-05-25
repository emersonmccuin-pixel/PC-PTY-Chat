// Section 31.7 — per-project statusline snapshot store. Populated via WS
// `statusline-snapshot` envelopes (broadcast by the server on every POST to
// /api/internal/statusline-data). Read by the left-rail usage-caps section.
//
// Account-wide rate limits are the load-bearing data here; we still scope
// by project so switching projects doesn't show stale caps from another
// session if the new project hasn't reported yet.

import { create } from 'zustand';

// Mirror of packages/domain/src/statusline.ts (web stays off @pc/domain —
// see api/client.ts header for the convention).
export interface StatuslineRateLimit {
  usedPercentage: number;
  resetsAt: string;
}

export interface StatuslineSnapshot {
  pcSessionId: string;
  ccSessionId: string;
  receivedAt: number;
  model: { id: string; displayName: string } | null;
  rateLimits: {
    fiveHour: StatuslineRateLimit | null;
    sevenDay: StatuslineRateLimit | null;
  };
  cost: {
    totalCostUsd: number;
    totalDurationMs: number;
    totalApiDurationMs: number;
  } | null;
  contextWindow: {
    currentUsage: number;
    contextWindowSize: number;
    usedPercentage: number;
    totalInputTokens: number;
    totalOutputTokens: number;
  } | null;
}

interface StatuslineState {
  byProject: Record<string, StatuslineSnapshot | null>;
  set: (projectId: string, snapshot: StatuslineSnapshot) => void;
  clear: (projectId: string) => void;
}

export const useStatuslineStore = create<StatuslineState>((set) => ({
  byProject: {},
  set: (projectId, snapshot) =>
    set((s) => ({ byProject: { ...s.byProject, [projectId]: snapshot } })),
  clear: (projectId) =>
    set((s) => {
      const next = { ...s.byProject };
      delete next[projectId];
      return { byProject: next };
    }),
}));
