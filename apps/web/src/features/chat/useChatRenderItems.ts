import { useMemo } from 'react';

import type { WsEnvelope } from '@/features/runtime/ws-types';
import { injectTodoSnapshots, normalizeJsonlEnvelope } from '@/features/chat/normalizeJsonlEnvelope';
import { synthesizeRenderItems } from '@/features/chat/toolGrouping';
import { pendingPromptEnvelope } from '@/features/chat/usePendingPrompts';
import type { PendingPrompt, RenderItem, StableEnvelope } from '@/features/chat/types';

export function useChatRenderItems({
  events,
  currentSessionId,
  projectId,
  visiblePendingPrompts,
}: {
  events: WsEnvelope[];
  currentSessionId: string | null;
  projectId: string;
  visiblePendingPrompts: PendingPrompt[];
}): { chatEnvelopes: StableEnvelope[]; renderItems: RenderItem[] } {
  const chatEnvelopes = useMemo<StableEnvelope[]>(() => {
    const eventsWithTodos = injectTodoSnapshots(events);
    const out: StableEnvelope[] = [];
    for (let i = 0; i < eventsWithTodos.length; i++) {
      const env = eventsWithTodos[i]!;
      if (env.type === 'ask') {
        const askSessionId = (env as { sessionId?: string | null }).sessionId;
        if (currentSessionId && askSessionId && askSessionId !== currentSessionId) {
          continue;
        }
        out.push({ origIdx: i, env });
        continue;
      }
      if (env.type === 'event') {
        out.push({ origIdx: i, env });
        continue;
      }
      if (env.type === 'jsonl') {
        const normalized = normalizeJsonlEnvelope(env);
        if (normalized) {
          out.push({ origIdx: i, env: normalized });
        }
      }
    }
    for (let i = 0; i < visiblePendingPrompts.length; i++) {
      const pending = visiblePendingPrompts[i]!;
      out.push({
        origIdx: eventsWithTodos.length + i,
        key: `pending-${pending.id}`,
        env: pendingPromptEnvelope(projectId, pending),
      });
    }
    return out;
  }, [events, currentSessionId, projectId, visiblePendingPrompts]);

  const renderItems = useMemo(
    () => synthesizeRenderItems(chatEnvelopes),
    [chatEnvelopes],
  );

  return { chatEnvelopes, renderItems };
}
