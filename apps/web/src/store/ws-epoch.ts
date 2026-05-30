// Per-project WebSocket "epoch" — incremented every time the focused project
// socket (re)opens. Resource-list hooks key their full refetch off this so the
// UI reconciles to server truth on every (re)connect.
//
// Why: the per-project WS hub has no catch-up — it broadcasts only to sockets
// that are OPEN at that instant (websocket-hub.ts) and drops the rest. Any
// agent-run / workflow-run created while a socket was down or half-open (server
// restart/promote, network blip, renderer backgrounded) is lost to that client
// until something forces a refetch. Bumping the epoch on reconnect turns that
// "manual refresh" into an automatic reconcile.

import { create } from 'zustand';

interface WsEpochState {
  byProject: Record<string, number>;
  bump: (projectId: string) => void;
}

export const useWsEpoch = create<WsEpochState>((set) => ({
  byProject: {},
  bump: (projectId) =>
    set((s) => ({
      byProject: { ...s.byProject, [projectId]: (s.byProject[projectId] ?? 0) + 1 },
    })),
}));
