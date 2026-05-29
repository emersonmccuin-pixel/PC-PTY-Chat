import { useCallback, useEffect, useRef, useState } from 'react';

import { createClientMessageId } from '@/features/chat/usePendingPrompts';

export interface SendBatchChunk {
  id: string;
  text: string;
}

// When Claude returns to ready, wait this long before flushing the batch so a
// fast turn doesn't snatch a half-composed batch. Submitting another chunk
// during the window resets the timer (debounce).
const FLUSH_SETTLE_MS = 1200;

/**
 * Coalesces sends made while Claude is busy into a single combined prompt
 * (docs/chat-canonical-source-redesign.md discussion). Chunks accumulate in
 * send order; when Claude returns to ready (+ a brief settle) they flush as ONE
 * message under ONE clientMessageId, so the existing send queue and the
 * id-keyed reconcile treat it as a single send — no server change needed.
 */
export function useSendBatch({
  isThinking,
  onFlush,
}: {
  isThinking: boolean;
  onFlush: (combinedText: string, batchId: string) => void;
}) {
  const [chunks, setChunks] = useState<SendBatchChunk[]>([]);
  const batchIdRef = useRef<string | null>(null);
  const onFlushRef = useRef(onFlush);
  useEffect(() => {
    onFlushRef.current = onFlush;
  }, [onFlush]);

  const addChunk = useCallback((text: string) => {
    if (!batchIdRef.current) batchIdRef.current = createClientMessageId();
    setChunks((prev) => [...prev, { id: createClientMessageId(), text }]);
  }, []);

  const cancelLast = useCallback(() => {
    setChunks((prev) => {
      const next = prev.slice(0, -1);
      if (next.length === 0) batchIdRef.current = null;
      return next;
    });
  }, []);

  const cancelBatch = useCallback(() => {
    batchIdRef.current = null;
    setChunks([]);
  }, []);

  // Flush on ready + settle. Re-runs (and so resets the timer) whenever a chunk
  // is added or the thinking state flips; clears the timer while Claude is busy.
  useEffect(() => {
    if (isThinking || chunks.length === 0) return;
    const timer = setTimeout(() => {
      const combined = chunks.map((chunk) => chunk.text).join('\n\n');
      const batchId = batchIdRef.current ?? createClientMessageId();
      batchIdRef.current = null;
      setChunks([]);
      onFlushRef.current(combined, batchId);
    }, FLUSH_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [isThinking, chunks]);

  return { batchChunks: chunks, addChunk, cancelLast, cancelBatch };
}
