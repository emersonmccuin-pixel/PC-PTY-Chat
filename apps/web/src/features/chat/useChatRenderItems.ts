import { useMemo } from 'react';

import type { WsEnvelope } from '@/features/runtime/ws-types';
import { injectTodoSnapshots, normalizeJsonlEnvelope } from '@/features/chat/normalizeJsonlEnvelope';
import { synthesizeRenderItems } from '@/features/chat/toolGrouping';
import { pendingPromptEnvelope } from '@/features/chat/usePendingPrompts';
import type { PendingPrompt, RenderItem, StableEnvelope } from '@/features/chat/types';

interface BuildEnvelopesArgs {
  events: WsEnvelope[];
  currentSessionId: string | null;
  projectId: string;
  visiblePendingPrompts: PendingPrompt[];
}

/**
 * Stage 2 (docs/chat-canonical-source-redesign.md): build chat envelopes from
 * the canonical JSONL stream only. Differs from the legacy path by dropping
 * `type:'event'` CONTENT — the dual-source that caused duplicates/reordering.
 * Kept inputs:
 *   - `jsonl` rows: the durable, complete, seq-ordered transcript (the reducer's
 *     sequenced buffer already orders these by seq, so a filter preserves order;
 *     we never sort by array index).
 *   - `ask` prompts: live approval requests that are legitimately NOT in the
 *     transcript (a "truly-live signal" per the ADR's WS role).
 *   - synthetic `todos` events emitted by injectTodoSnapshots.
 * Suppression here still rides normalizeJsonlEnvelope's null-returns, whose
 * hidden set is proven equal to rowPolicy()'s in chat-policy.test.ts; Stage 3
 * swaps it for explicit policy + a debug reveal.
 */
export function buildCanonicalChatEnvelopes({
  events,
  currentSessionId,
  projectId,
  visiblePendingPrompts,
}: BuildEnvelopesArgs): StableEnvelope[] {
  const content = events.filter((env) => env.type === 'jsonl' || env.type === 'ask');
  const withTodos = injectTodoSnapshots(content);
  const out: StableEnvelope[] = [];
  for (let i = 0; i < withTodos.length; i++) {
    const env = withTodos[i]!;
    if (env.type === 'ask') {
      const askSessionId = (env as { sessionId?: string | null }).sessionId;
      if (currentSessionId && askSessionId && askSessionId !== currentSessionId) continue;
      out.push({ origIdx: i, env });
      continue;
    }
    if (env.type === 'event') {
      // Only synthetic todos envelopes reach here (input was jsonl|ask only).
      out.push({ origIdx: i, env });
      continue;
    }
    if (env.type === 'jsonl') {
      const normalized = normalizeJsonlEnvelope(env);
      if (normalized) out.push({ origIdx: i, env: normalized });
    }
  }
  for (let i = 0; i < visiblePendingPrompts.length; i++) {
    const pending = visiblePendingPrompts[i]!;
    out.push({
      origIdx: withTodos.length + i,
      key: `pending-${pending.id}`,
      env: pendingPromptEnvelope(projectId, pending),
    });
  }
  return out;
}

export function useChatRenderItems({
  events,
  currentSessionId,
  projectId,
  visiblePendingPrompts,
  canonical = false,
}: {
  events: WsEnvelope[];
  currentSessionId: string | null;
  projectId: string;
  visiblePendingPrompts: PendingPrompt[];
  canonical?: boolean;
}): { chatEnvelopes: StableEnvelope[]; renderItems: RenderItem[] } {
  const chatEnvelopes = useMemo<StableEnvelope[]>(() => {
    if (canonical) {
      return buildCanonicalChatEnvelopes({ events, currentSessionId, projectId, visiblePendingPrompts });
    }
    // --- legacy path (frozen; the trustworthy A/B baseline) ---
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
  }, [events, currentSessionId, projectId, visiblePendingPrompts, canonical]);

  const renderItems = useMemo(
    () => synthesizeRenderItems(chatEnvelopes),
    [chatEnvelopes],
  );

  return { chatEnvelopes, renderItems };
}
