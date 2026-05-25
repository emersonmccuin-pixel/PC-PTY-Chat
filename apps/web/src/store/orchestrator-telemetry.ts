// Section 32.4 — single source of truth for orchestrator model + token
// usage, so App.tsx's slim header can show them on the right without
// drilling props through Shell → Center → Orchestrator → StatusBar.
// Orchestrator publishes on every change; subscribers (header, footer)
// render off the same store.
//
// Single orchestrator is active at a time (one project = one chat panel),
// so the store is flat — no per-project keying. Switching projects writes
// fresh values; clearing on unmount avoids stale display when no chat is
// mounted.

import { create } from 'zustand';

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

const EMPTY_USAGE: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
};

interface OrchestratorTelemetryState {
  model: string | null;
  usage: UsageTotals;
  set: (next: { model: string | null; usage: UsageTotals }) => void;
  clear: () => void;
}

export const useOrchestratorTelemetry = create<OrchestratorTelemetryState>(
  (set) => ({
    model: null,
    usage: EMPTY_USAGE,
    set: (next) => set(next),
    clear: () => set({ model: null, usage: EMPTY_USAGE }),
  }),
);
