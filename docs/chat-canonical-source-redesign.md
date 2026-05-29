# Chat Canonical-Source Redesign (ADR)

Drafted: 2026-05-28
Status: proposed
Companion to: `chat-system-contract.md` (the product contract this satisfies), Section 23 (JSONL-as-canonical)

Derived from first principles, not from current code. Where it contradicts today's implementation, today is wrong.

## Problem

Chat shows missing, duplicated, and out-of-order messages. Root cause is structural, not a set of isolated bugs: chat content is built by **merging two independent streams** that describe the same events —
- `type:'event'` hook envelopes (PTY-sourced), and
- `type:'jsonl'` envelopes (transcript-sourced).

Two streams, no perfect join key. Today's joins are heuristics for a missing identity:
- dedup by timestamp (`seenTs`, only on `type:'event'`, cleared on session transition)
- optimistic-prompt reconcile by **fuzzy text match**

Duplication, gaps, and reordering are guaranteed by this design, not incidental to it.

## The one principle

There is exactly one durable, complete, totally-ordered record of a Claude conversation: **the JSONL transcript file.** Append-only, every line in position, contains everything (user, assistant, tool calls, results, system notices, usage).

Everything else — hook events, the live WS feed, optimistic bubbles — is a **latency/liveness signal, not a source of content.**

> **Only the canonical record produces durable chat items. Live channels only ever produce provisional placeholders keyed by an id, which the canonical record replaces 1:1. Nothing is merged. Nothing is deduped. Placeholders are overwritten, not reconciled.**

That single rule dissolves all three symptoms instead of patching them.

## Consequences (= the four requirements)

### 1. Completeness — get ALL of Claude's messages
- Render is a pure function of the JSONL: `render = f(jsonl_rows)`.
- Same file → same chat, always. Deterministic, replayable.
- Nothing to "miss" because nothing is reconstructed from a droppable event stream.
- Duplication is **structurally impossible** — one source.

### 2. Policy — system messages through, noise suppressed
- **Parse everything** from JSONL. Never discard at parse time.
- One pure function decides presentation: `policy(row) → { visibility: shown | collapsed | hidden, lane }`.
- Suppression is a **view filter, not a parse filter.** A debug toggle can reveal hidden rows.
- Tiers (starting point, all editable in one table):
  - **shown**: user, assistant text, errors, human-facing system notices
  - **collapsed**: tool calls/results (compact chip, expandable), usage
  - **hidden (toggleable)**: queue enqueue/dequeue, ai-title, file-history, sidechain, turn-duration, post-turn-summary, stream-event
- Replaces today's destructive + scattered suppression (`normalizeJsonlEnvelope` returning `null`, separate `SUPPRESSED_TOOLS` in `toolGrouping`).

### 3. Ordering — correct under rapid sends
- Order = **file line order.** Append-only ⇒ line N precedes N+1.
- You *read* order; you don't reconstruct it.
- Banned as ordering keys: wall-clock timestamps (ties/skew), WS arrival order (racy), optional `seq`.
- Rapid successive sends can't race — reading one totally-ordered log, not merging concurrent streams.

### 4. Performance — not laggy
- Append-only ⇒ parse is incremental: a byte/line **offset cursor** processes only the new tail. O(new), not O(total).
- Parsed + classified items live in **one** store/selector. Each panel reads only its slice. No giant array passed as a prop to every panel.
- View renders a window (last N) + virtualized scrollback. Lag bounded by what's on screen, not session length.
- (Directly fixes the dev `logComponentRender` OOM and the prior chat/terminal lag — both were the full mixed array threaded everywhere.)

## Optimistic sends & live streaming (the latency objection)

Tailing a file feels slower than a push event — likely why the second source exists. Not needed:
- User's own message → optimistic **placeholder keyed by client-message-id**. When the matching JSONL line lands, it **replaces** the placeholder in place (match on id, never text).
- Token-by-token assistant streaming (if wanted) → a liveness channel feeding a **provisional, id-keyed bubble** that the canonical JSONL line overwrites 1:1.
- Either way: live channels paint placeholders the record replaces. They never add durable items. Low latency **and** single source of truth.

## Surface/source split

| Surface  | Source                | Properties                          |
|----------|-----------------------|-------------------------------------|
| Chat     | JSONL transcript file | durable, ordered, complete, replayable |
| Terminal | PTY byte stream       | ephemeral, append-only, seq-ordered |
| (both)   | WebSocket             | transport + doorbell ("file grew, read the tail") + truly-live signals only |

PTY has no JSONL, so terminal is *legitimately* stream-sourced. Two surfaces, two proper append-only sources, each totally ordered on its own terms. No shared in-memory mixed array as a content source.

## What to delete / stop doing

- The shared `wsEvents` array as a **content** source for chat (keep WS as transport/doorbell only).
- Dual-sourcing chat from hook `type:'event'` envelopes — they become liveness hints, never bubbles.
- `seenTs` timestamp dedup.
- Fuzzy text-match reconciliation of pending prompts.
- `normalizeJsonlEnvelope` returning `null` to suppress (move to the policy layer).

## Open questions

- Does Claude's JSONL carry a stable id we can stamp on a user send for id-keyed reconcile, or do we correlate via the send queue's `clientMessageId`?
- Tail latency target: poll interval vs `fs.watch`. What feels instant enough that streaming-channel placeholders are optional?
- Migration: can the JSONL-only renderer run behind a flag alongside today's path for A/B before ripping the dual-source plumbing?
- Where does the policy table live (shared client/server) so server-side replay and client render agree?

## Convergence note

This is Section 23 finished, not a new direction. Intent (JSONL-as-canonical, rip the dedupe layer) was already chosen; the dual-source plumbing was never fully removed. First principles just says complete it and delete the rest.
