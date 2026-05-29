import { useCallback, useEffect, useRef } from 'react';

import { createClientMessageId } from '@/features/chat/usePendingPrompts';
import { type SendBatchChunk, useSendBatchStore } from '@/store/send-batch';

export type { SendBatchChunk };

// When Claude returns to ready, wait this long before flushing the batch so a
// fast turn doesn't snatch a half-composed batch. Submitting another chunk
// during the window resets the timer (debounce).
const FLUSH_SETTLE_MS = 1200;

// Stable empty array so the selector below never hands a fresh ref to the flush
// effect (which would reset the settle timer every render).
const EMPTY_CHUNKS: SendBatchChunk[] = [];

/**
 * Coalesces sends made while Claude is busy into a single combined prompt
 * (docs/chat-canonical-source-redesign.md discussion). Chunks accumulate in
 * send order, keyed by session id, so a queue composed in one chat stays bound
 * to that chat. When that chat returns to ready (+ a brief settle) its queue
 * flushes as ONE message under ONE clientMessageId — the existing send queue
 * and id-keyed reconcile treat it as a single send, no server change needed.
 */
export function useSendBatch({
  sessionId,
  isThinking,
  onFlush,
}: {
  sessionId: string | null;
  isThinking: boolean;
  onFlush: (combinedText: string, batchId: string) => void;
}) {
  const onFlushRef = useRef(onFlush);
  useEffect(() => {
    onFlushRef.current = onFlush;
  }, [onFlush]);

  const batch = useSendBatchStore((s) => (sessionId ? s.bySession[sessionId] : undefined));
  const chunks = batch?.chunks ?? EMPTY_CHUNKS;
  const addChunkRaw = useSendBatchStore((s) => s.addChunk);
  const cancelLastRaw = useSendBatchStore((s) => s.cancelLast);
  const clearRaw = useSendBatchStore((s) => s.clear);

  const addChunk = useCallback(
    (text: string) => {
      if (!sessionId) return;
      addChunkRaw(sessionId, { id: createClientMessageId(), text }, createClientMessageId());
    },
    [sessionId, addChunkRaw],
  );

  const cancelLast = useCallback(() => {
    if (sessionId) cancelLastRaw(sessionId);
  }, [sessionId, cancelLastRaw]);

  const cancelBatch = useCallback(() => {
    if (sessionId) clearRaw(sessionId);
  }, [sessionId, clearRaw]);

  // Flush on ready + settle, for THIS session's queue only. Re-runs (resetting
  // the timer) when a chunk is added or the thinking state flips; clears the
  // timer while Claude is busy. Switching chats swaps sessionId/chunks, so a
  // busy chat's queue is left untouched until you return to it.
  useEffect(() => {
    if (!sessionId || isThinking || chunks.length === 0) return;
    const timer = setTimeout(() => {
      const combined = chunks.map((chunk) => chunk.text).join('\n\n');
      const batchId = batch?.batchId ?? createClientMessageId();
      clearRaw(sessionId);
      onFlushRef.current(combined, batchId);
    }, FLUSH_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [sessionId, isThinking, chunks, batch?.batchId, clearRaw]);

  return { batchChunks: chunks, addChunk, cancelLast, cancelBatch };
}
