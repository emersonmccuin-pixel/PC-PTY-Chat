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
  /** Section 32.5 — session metadata for the header breadcrumb dropdown. */
  sessionId: string | null;
  sessionLabel: string | null;
  set: (next: { model: string | null; usage: UsageTotals }) => void;
  setSession: (next: { sessionId: string | null; sessionLabel: string | null }) => void;
  clear: () => void;
}

export const useOrchestratorTelemetry = create<OrchestratorTelemetryState>(
  (set) => ({
    model: null,
    usage: EMPTY_USAGE,
    sessionId: null,
    sessionLabel: null,
    set: (next) => set(next),
    setSession: (next) => set(next),
    clear: () =>
      set({
        model: null,
        usage: EMPTY_USAGE,
        sessionId: null,
        sessionLabel: null,
      }),
  }),
);
