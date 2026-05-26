// Section 37.13 — cross-component bridge for pre-filling the orchestrator
// chat composer from somewhere outside the chat surface. The Initiative
// Inspector's "Chat about this →" button pushes a prefill + switches to
// the chat tab; the composer consumes it on next render, sets its text +
// focus, and clears the pending value.
//
// Mirrors the [[chat-scroll-target]] / [[useChatScrollTarget]] pattern:
// fire-once payload that the consumer absorbs on read.

import { create } from 'zustand';

interface ComposerPrefillState {
  /** Pending text to inject. Null means nothing to consume. */
  pending: string | null;
  /** Monotonic counter so the consumer's effect re-fires for back-to-back
   *  prefills of the same text (e.g. user opens Chat-about twice in a row). */
  seq: number;
  push: (text: string) => void;
  consume: () => string | null;
}

export const useChatComposerPrefill = create<ComposerPrefillState>((set, get) => ({
  pending: null,
  seq: 0,
  push: (text) => set({ pending: text, seq: get().seq + 1 }),
  consume: () => {
    const text = get().pending;
    if (text !== null) set({ pending: null });
    return text;
  },
}));
