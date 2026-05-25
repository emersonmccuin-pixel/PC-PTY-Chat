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
  /** Section 31.3 — most-recent CC `session_state_changed` value
   *  (`idle` | `running` | `requires_action` | …) seen in JSONL. Drives the
   *  composer status-line state indicator. Null until first signal lands. */
  sessionState: string | null;
  /** Section 31.8 — durationMs of the most-recent `jsonl-turn-duration`
   *  envelope (fires after `jsonl-turn-end`). */
  lastTurnDurationMs: number | null;
  /** Section 31.8 follow-up — context-window fill % (0..100) from CC's
   *  statusline payload. Drives the composer status-line ctx bar. Null
   *  until the first statusline snapshot lands. */
  contextUsedPct: number | null;
  set: (next: { model: string | null; usage: UsageTotals }) => void;
  setSession: (next: { sessionId: string | null; sessionLabel: string | null }) => void;
  setRuntime: (next: { sessionState: string | null; lastTurnDurationMs: number | null }) => void;
  setContextUsedPct: (next: number | null) => void;
  clear: () => void;
}

export const useOrchestratorTelemetry = create<OrchestratorTelemetryState>(
  (set) => ({
    model: null,
    usage: EMPTY_USAGE,
    sessionId: null,
    sessionLabel: null,
    sessionState: null,
    lastTurnDurationMs: null,
    contextUsedPct: null,
    set: (next) => set(next),
    setSession: (next) => set(next),
    setRuntime: (next) => set(next),
    setContextUsedPct: (next) => set({ contextUsedPct: next }),
    clear: () =>
      set({
        model: null,
        usage: EMPTY_USAGE,
        sessionId: null,
        sessionLabel: null,
        sessionState: null,
        lastTurnDurationMs: null,
        contextUsedPct: null,
      }),
  }),
);
