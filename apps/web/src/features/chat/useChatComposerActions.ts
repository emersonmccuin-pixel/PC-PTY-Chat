import { useCallback, useEffect, useRef } from 'react';

import type { RuntimeInputCapabilities } from '@/features/chat/runtimeState';
import {
  createClientMessageId,
  type PendingPromptInput,
} from '@/features/chat/usePendingPrompts';
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

  const handleSend = useCallback(
    (text: string): boolean => {
      if (inputCapabilities && !inputCapabilities.canSubmitChatInput) return false;
      const clientMessageId = createClientMessageId();
      const ok = onSend(text, clientMessageId);
      const queueOptimistically = composerQueueing || isThinking;
      if (ok) {
        recordPendingPrompt({
          id: clientMessageId,
          text,
          eventFloor: eventsRef.current.length,
          expectsAck: wsStatus !== undefined,
          queued: queueOptimistically,
        });
      }
      return ok;
    },
    [inputCapabilities, onSend, composerQueueing, isThinking, wsStatus, recordPendingPrompt],
  );

  const resolvedComposerSendLabel =
    composerSendLabel ??
    (isThinking || composerQueueing ? 'Queue ↵' : 'Send ↵');

  return {
    handleSend,
    handleInterrupt,
    resolvedComposerSendLabel,
  };
}
