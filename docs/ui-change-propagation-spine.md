# UI Change-Propagation Spine (ADR)

Drafted: 2026-05-29
Status: proposed
Companion to: `chat-canonical-source-redesign.md` (the chat-specific instance of this same pattern), Section 23 (JSONL-as-canonical)

Derived from a first-principles conversation, not from current code. Where it contradicts today's implementation, today is wrong.

## Problem

Background things change — database rows, the JSONL transcript, the PTY/terminal stream — and those changes have to show up in the UI. Today that happens through **three different mechanisms taped to one pipe**, with uneven reliability:

- **JSONL** is genuinely *watched* (a file tailer reacts to new lines — correct, because Claude writes it from outside our code).
- **The database** is *not* watched. It relies on **announce-on-write**: the code that performs a write is also supposed to broadcast that it happened. Scattered across many write paths, so it's easy to forget — and any out-of-band write (e.g. a manual SQL edit) is invisible to the UI.
- **The PTY** is a live pipe, forwarded as it flows.

Two failure modes fall out of this:
1. **Stale UI.** A change that doesn't go through an announcing code path never reaches the screen (observed: the right rail not updating after a direct DB write).
2. **The "binder" reload.** Most announcements today are *dumb pings* — "something in this list changed" — so the frontend responds by **refetching the entire list and re-rendering it**, because it doesn't know *what* changed. Slow, janky, and wasteful.

## The one principle

Every change should travel **one consistent path** from "the truth changed" to "the right element on screen updated," and the message it carries should say **what** changed — not merely **that** something did.

The only legitimate branch is at the very start: *did we cause the change, or did an outside writer?*
- **We own the write** → announce it, through a single door.
- **An outsider owns the write** (JSONL) → watch it.

> Watch only what you don't control. Announce everything you do — through one door, with a precise, versioned message. The frontend files messages by id and redraws only the affected slice. Nothing reloads a whole list.

## The shape — six parts

Three of these already exist in some form; the work is finishing and aligning, not starting over.

1. **One write-door per kind of data (the chokepoint).** Every write of a given kind (work items, runs, etc.) goes through a single layer whose job is to *make the change and announce it together, always*. With one door, "forgetting to announce" becomes structurally impossible, and out-of-band writes have a single obvious place to be funneled into. *(New discipline; exists in pieces.)*

2. **One watcher — only for what you don't control.** The JSONL transcript, written by Claude externally. This is the *exception*, reserved for outside writers. *(Exists.)*

3. **One road to the frontend.** All announcements ride the same per-project WebSocket, fanned out by the hub (`apps/server/src/services/websocket-hub.ts`). *(Exists — keep.)*

4. **Smart messages, not dumb pings.** A message carries *"entity #47 is now exactly this, version 12"* — the changed thing plus a version stamp. The version lets the frontend discard a stale message that arrives after a newer one. *(Main rewrite. Hooks exist: work items already carry `version`; runs carry `lastActivityAt`.)*

5. **One normalized store on the frontend, filed by id.** Instead of each panel holding its own copy of a list, a single store holds every item keyed by id. A message arrives → find that id → swap it in place. No whole-binder reloads. *(Chat is already moving to this; generalize it.)*

6. **Each panel reads only its slice.** A panel reads just the items it displays; when its slice changes, only it redraws. *(Comes for free once #5 exists.)*

## End-to-end flow

Something changes → goes through the **one door** (or, for JSONL, the **one watcher** catches it) → a **precise, versioned message** goes down the **one road** → the frontend **files it by id** in the store → only the **panel showing that id** redraws.

Same path for everything. One branch, at the source: door (we wrote it) vs. watcher (an outsider wrote it).

## What this kills

- **Stale UI** — impossible: writing and announcing become the same act through one door.
- **The binder reload** — patch one item, never refetch the list.
- **Lag/jank** — only the changed slice redraws, not the world. (Same root cause as the prior chat/terminal lag + dev OOM: one giant array threaded into every panel.)
- **"Three mechanisms taped together"** — collapses to one shape with a single documented exception.

## Sequencing (do not big-bang)

1. **Chat is the reference implementation.** It already runs the id-store + slice pattern (the JSONL-canonical refactor). Point at it: "like that, everywhere."
2. **Right rail / runs goes second** — that's where the staleness pain was just felt. Build its write-door, its versioned delta message, its store-slice. Acceptance: a direct DB change cannot leave the rail stale (because the only write path is the announcing door), and the rail patches one run rather than refetching the list.
3. **Roll the same recipe across the rest** — work items, pods, stages — one domain at a time. Each repeat is faster.

## Guardrails (write these down so nobody drifts)

- **The database stays the single source of truth. Do NOT build a second event-log to "match chat."** Chat needed its own canonical record only because its source (Claude's output) lives outside the database. Everything else already has its truth in the DB — this work upgrades *how changes are announced and rendered*, never duplicates the truth.
- **Watch only what you don't own; announce everything you do.** If anyone finds themselves adding a watcher over our own database, that's the signal a write is sneaking around the door. Fix the door; don't add a watcher.
- **Every announce carries a version.** Stale messages must be discardable by comparing versions, so out-of-order WS delivery can't clobber newer state.

## Relationship to other in-flight work

- **Chat JSONL-canonical refactor** — the first instance of this spine; default-on per the project tracker. This ADR is the generalization of its delivery + client-store half.
- **WS store/slice refactor** — listed open on the project course; this ADR is its design.
- **Worktree isolation / Needs-Attention rail** — the rail escalation surface should ride this spine (id-keyed flag updates), not a bespoke refresh.
