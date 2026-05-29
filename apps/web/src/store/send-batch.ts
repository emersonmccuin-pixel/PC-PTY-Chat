// Coalesced send-batch chunks, keyed by session id. Per-session so a queue
// composed while one chat is busy stays put when you switch chats and only
// flushes for the chat it belongs to — fixes the cross-chat misfire where a
// queue built in chat A fired through the active chat B's send.
//
// Not persisted — a queued-but-unsent batch is transient navigation state.

import { create } from 'zustand';

export interface SendBatchChunk {
  id: string;
  text: string;
}

interface SessionBatch {
  chunks: SendBatchChunk[];
  batchId: string | null;
}

interface SendBatchState {
  bySession: Record<string, SessionBatch>;
  addChunk: (sessionId: string, chunk: SendBatchChunk, batchId: string) => void;
  cancelLast: (sessionId: string) => void;
  clear: (sessionId: string) => void;
}

export const useSendBatchStore = create<SendBatchState>((set) => ({
  bySession: {},
  addChunk: (sessionId, chunk, batchId) =>
    set((s) => {
      const cur = s.bySession[sessionId];
      return {
        bySession: {
          ...s.bySession,
          [sessionId]: {
            chunks: [...(cur?.chunks ?? []), chunk],
            batchId: cur?.batchId ?? batchId,
          },
        },
      };
    }),
  cancelLast: (sessionId) =>
    set((s) => {
      const cur = s.bySession[sessionId];
      if (!cur || cur.chunks.length === 0) return s;
      const chunks = cur.chunks.slice(0, -1);
      return {
        bySession: {
          ...s.bySession,
          [sessionId]: { chunks, batchId: chunks.length === 0 ? null : cur.batchId },
        },
      };
    }),
  clear: (sessionId) =>
    set((s) => {
      if (!s.bySession[sessionId]) return s;
      return {
        bySession: { ...s.bySession, [sessionId]: { chunks: [], batchId: null } },
      };
    }),
}));
