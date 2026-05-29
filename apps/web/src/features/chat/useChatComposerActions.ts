import { useCallback, useEffect, useRef } from 'react';

import type { RuntimeInputCapabilities } from '@/features/chat/runtimeState';
import {
  createClientMessageId,
  type PendingPromptInput,
} from '@/features/chat/usePendingPrompts';
import { useSendBatch } from '@/features/chat/useSendBatch';
import type { WsEnvelope, WsStatus } from '@/features/runtime/ws-types';

export function useChatComposerActions({
  events,
  inputCapabilities,
  onSend,
  onInterrupt,
  composerQueueing,
  composerSendLabel,
  isThinking,
  wsStatus,
  recordPendingPrompt,
  markInterrupted,
}: {
  events: WsEnvelope[];
  inputCapabilities?: RuntimeInputCapabilities;
  onSend: (text: string, clientMessageId: string) => boolean;
  onInterrupt: () => boolean;
  composerQueueing?: boolean;
  composerSendLabel?: string;
  isThinking: boolean;
  wsStatus?: WsStatus;
  recordPendingPrompt: (pending: PendingPromptInput) => void;
  markInterrupted: () => void;
}) {
  const eventsRef = useRef(events);
  useEffect(() => {
    eventsRef.current = events;
  }, [events]);

  const handleInterrupt = useCallback((): boolean => {
    if (inputCapabilities && !inputCapabilities.canInterrupt) return false;
    const ok = onInterrupt();
    if (ok) markInterrupted();
    return ok;
  }, [inputCapabilities, onInterrupt, markInterrupted]);

  // Actually deliver one message (immediate send, or a flushed batch).
  const doSend = useCallback(
    (text: string, clientMessageId: string): boolean => {
      const ok = onSend(text, clientMessageId);
      if (ok) {
        recordPendingPrompt({
          id: clientMessageId,
          text,
          eventFloor: eventsRef.current.length,
          expectsAck: wsStatus !== undefined,
          queued: composerQueueing ?? false,
        });
      }
      return ok;
    },
    [onSend, composerQueueing, wsStatus, recordPendingPrompt],
  );

  const { batchChunks, addChunk, cancelLast, cancelBatch } = useSendBatch({
    isThinking,
    onFlush: doSend,
  });

  const handleSend = useCallback(
    (text: string): boolean => {
      if (inputCapabilities && !inputCapabilities.canSubmitChatInput) return false;
      // Coalesce while Claude is busy, AND during the post-ready settle window
      // (batch not yet flushed) so a follow-up still joins instead of sending
      // separately — adding a chunk also resets the flush timer.
      if (isThinking || batchChunks.length > 0) {
        addChunk(text);
        return true;
      }
      return doSend(text, createClientMessageId());
    },
    [inputCapabilities, isThinking, batchChunks.length, addChunk, doSend],
  );

  const resolvedComposerSendLabel =
    composerSendLabel ??
    (isThinking || composerQueueing ? 'Queue ↵' : 'Send ↵');

  return {
    handleSend,
    handleInterrupt,
    resolvedComposerSendLabel,
    batchChunks,
    cancelLastChunk: cancelLast,
    cancelBatch,
  };
}
