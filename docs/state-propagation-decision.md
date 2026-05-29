# Caisson State Propagation — Decision Note

Status: proposed (2026-05-29). Generalizes `ui-change-propagation-spine.md` to every hop.
Derived from a research+audit workflow (4 external pattern lenses + internal codebase audit → synthesis → adversarial critique → final). Where it contradicts today's code, today is the gap.

## TL;DR

Caisson keeps the database as the single source of truth, but standardizes *how* state changes reach everyone who needs to know. Every database write, in one place, bumps a per-row version and atomically appends a row to a single `changes` outbox; a relay drains that outbox to the UI over WebSocket, and reconnecting clients catch up by cursor — so a write can never commit without an announcement, and a disconnected client never silently misses one. For the things the app *observes* but doesn't own — the agent host's live process state and Claude's JSONL transcripts — a continuous, idempotent reconcile loop re-derives truth from authoritative artifacts and converges the DB, demoting all events to mere "look at this id" nudges. The net effect: a dropped message costs latency until the next reconcile, never a permanently wrong row — which is exactly what kills today's phantom "still running" agent.

## The mechanism

Three tiers, sorted by *who owns the fact*. Reconcile is the correctness backstop for the first two; the third is pure pass-through.

1. **DB-owned facts → the outbox spine.** API is the only SQLite writer. One commit-and-announce chokepoint does, inside a single transaction: write the business row, bump that row's per-entity `rev`, insert one row into the global `changes` outbox. After commit (never inside the transaction), a relay drains `changes` and delivers over the per-project WebSocket. Clients file each delta by id into a versioned store, discard by `rev`, redraw only the touched slice, and on reconnect ask "everything after global `version` N."

2. **Externally-owned artifacts → watch + reconcile.** JSONL transcripts are tailed (we don't write them). The agent host's live run state is *observed*, never trusted as a recorded transition. A continuous reconcile loop re-derives each entity's truth from a defined precedence ladder and writes it idempotently through the same chokepoint in (1).

3. **Ephemeral high-frequency streams → pass-through.** Live PTY output and `run-chunk`/`run-jsonl` byte spam are streamed raw. They are inherently replayable and latency-class; they never enter the outbox and have no rev/reconcile semantics.

This is **not** "one mechanism for all subsystems" — that framing is dropped as false. It is **one spine for DB-owned facts, watch+reconcile for externally-owned artifacts, pass-through for ephemeral streams** — three tiers unified by *ownership*, with reconcile as the shared correctness net under the first two.

### Two counters, named separately (this was a latent defect — resolved)

The note formerly called these "one monotonic rev." They are two different counters and conflating them corrupts state under reconnect:

- **`version`** — a single **global, gapless, monotonic** outbox sequence. Sole purpose: cursor ordering and replay (`WHERE version > N`). Assigned when the `changes` row is inserted.
- **`rev`** — a **per-entity** row version. Sole purpose: the UI's idempotent apply (`incoming.rev ≤ stored.rev → discard`, already implemented in `use-resource-list.ts:122-125`).

The outbox row is `(version, domain, entityId, rev, payload)`. Catch-up orders by `version`; the client dedupes by `(entityId, rev)`. Never use one where the other is required.

## Core principles

- **Single owner per fact.** API/SQLite owns committed truth. The host is the authoritative *observer* of run lifecycle (only it can `waitpid` the child) but never the *recorder*. Claude CLI owns the JSONL transcript. Everyone else holds projections.
- **Watch only what you don't control; announce everything you do; reconcile to be sure.**
- **Announce ≡ durable write, not delivery.** Inside the txn: business row + `changes` row, committed atomically. After commit: the relay delivers. Delivery failure must never roll back the business write. (Today's writers read-back-then-broadcast, e.g. `workflow-run-writer.ts` `announceRun`; that becomes relay-drains-outbox. Never call `hub.broadcast` inside a `db.transaction(...)` closure.)
- **Events are latency; reconcile is correctness.** The test for any piece: *would a dropped message here ever leave a permanently wrong row?* If yes, it needs a reconcile/replay path behind it. Correctness-load-bearing: `version`, the in-txn outbox row, cursor catch-up, per-entity `rev` discard, idempotent apply, the periodic sweep, the on-disk artifact. Pure latency (droppable): the live event stream, per-event push, heartbeats, chunk/jsonl spam.
- **At-least-once + idempotent = effectively once.** Terminal state is absorbing (terminal-over-terminal is a no-op *when sources agree* — see the precedence rule for when they don't). UI discards by rev.
- **The outbox is a prunable delivery buffer, not an event store.** Prune by fixed size/age, not by a live-cursor watermark. Do **not** build a second event-log-as-truth — the in-repo ADR, kept.

## Per-subsystem mapping

| Subsystem | Owner | Tier | Action under the standard |
|---|---|---|---|
| **Work-items** | API/DB | Spine ✅ | Already correct (`work-item-writer.ts`). Route through unified `changes`; else unchanged. |
| **Workflow-runs (v2)** | API/DB | Spine ✅ | Reference impl. Has per-entity `rev` already. Move onto `changes`/cursor; replace read-back-broadcast with relay. |
| **Pods** | API/DB | Spine ✅ | Correct. Keep delete-as-separate-envelope. Onto `changes`. |
| **Stages** | API/DB | Spine ✅ | Correct. Batch-atomic shared rev fits. Onto `changes`. |
| **Agent-host lifecycle (the bug)** | **Host observes, API records** | **Watch+reconcile** | Whole fix lives here — see next section. Host events = nudges; API re-derives from precedence ladder; covered by the sweep. |
| **Agent-runs (DB row)** | API/DB | Spine, **missing `rev`** ❌ | Add per-entity `rev` to `AgentRunRecord`; create `agent-run-writer.ts`; fix `use-project-agent-runs.ts` (`getVersion: r => r.rev`). |
| **Chat / JSONL** | Claude CLI (external) | **Watch+reconcile** 🔍 | File-tailed. Spine carries pointer + rev, never transcript bytes. Tailer feeds reconcile (terminal detection). Its "apply" is render-bytes — no rev semantics; do not pretend it shares the outbox apply. |
| **Terminal PTY** | Host (live I/O) | **Pass-through** 📡 | Raw live stream. Not a fact to reconcile. Out of scope for the outbox. Keep heartbeat/reap. |
| **`run-chunk` / `run-jsonl`** | Host (live I/O) | **Pass-through** 📡 | Latency-class byte spam. Must **not** share the lifecycle event log or the outbox replay budget (see #1 fix below). |
| **Orchestrator runtime** | API/DB | Spine (snapshot) | Acceptable as monolithic snapshot. Stamp per-entity `rev`, ride `changes` for reconnect catch-up. |
| **Orchestrator send-queue** | API/DB | Spine (full-replace) | Fine as full-replace; stamp `rev`, ride `changes`. |
| **Usage / telemetry** | API/DB | **Separate channel** | Do **not** dilute the correctness-critical replay budget. Coalesce to periodic snapshots, or give it its own aggressively-pruned channel. A missed tick is pure latency. |
| **Unread badges** | Client-derived | Observe | Stays client-side. Gets gap-detection for free once it consumes the versioned stream. |

## Host→DB hop + crash durability (the load-bearing section)

Today's bug: `agent-host-client.ts:409-434` `readEventStream` runs exactly **once** — no reconnect, no backoff, no heartbeat; on `done`/error it nulls `eventAbort` and returns. The DB row (`AgentRunRecord`) has no `rev`. The host's event buffer is in-memory only. Three independent layers, each a fallback for the one above. **Note the migration order is reconcile-first — see below — because shipping the fragile reconnect loop before the backstop exists is the riskiest possible ordering.**

**Layer 2 first — level read + continuous reconcile (correctness; this is what makes the bug impossible).**
Give the host a pull endpoint returning complete live state plus a process-identity stamp:
```
GET /host/runs → { hostEpoch: <uuid-per-host-process>, rev: <monotonic>,
                   runs: [{ runId, status, pid, pidStartTime, exitCode, terminalAt? }] }
```
- `reconcileRun(id)`: read DB row + host snapshot + JSONL tail, compute desired state via the **precedence ladder**, write idempotently through the chokepoint. The host event carries no trusted transition — it only says "look at this id."
- **Precedence ladder (must be specified, not hand-waved):** live `waitpid` observation > full-snapshot-omission + `hostEpoch` flip > JSONL terminal marker > host's *claimed* `terminalResult`. **Host-says-terminal-but-artifact-disagrees → trust the artifact, log a divergence.** Rationale: the host's `terminalResult` is in-memory and is exactly what is lost on crash; the artifact survives. This is a *behavior change* — `agent-run-boot-reconcile.ts:156-174` currently reads `hostRun.terminalResult`/`state` and writes it as terminal truth. That must stop trusting the claim and cross-check the artifact.
- **Never infer terminal from a single absent event.** Require a full-snapshot omission or an epoch flip, cross-checked against the artifact.
- `hostEpoch` flip = host restarted/crashed = its memory was lost → any DB run still "running" that the new epoch doesn't claim is orphaned → finalize from artifact.
- **Triggers:** periodic **sweep (10–30s) over all non-terminal runs** (the guarantee), on host (re)connect with a full snapshot resync, on epoch change, and — coalesced — on host events. **`reconcileAgentRunsOnBoot` becomes the boot-time first call of this same continuous function, not a one-shot.**
- **Trigger hygiene (from the stress-test):** coalesce/debounce per-run reconcile (collapse N events for run X in a tick into one). Make JSONL-tail reads **lazy** — only tail the transcript when the cheap sources (host snapshot + DB row) are insufficient to decide (row non-terminal AND host doesn't claim it). Do not tail JSONL on every healthy state transition, and stagger the reconnect "resync all runs" so it doesn't stampede the disk on the one event we most want to handle gracefully.

**Layer 1 second — make the stream resumable (latency optimization on top of a working backstop).**
*Build from scratch* (there is no reconnect loop today): heartbeat + reconnect with backoff in `HttpAgentHostClient`, guarding the abort races (`eventAbort?.signal === signal`, double-subscribe). Crucially, **fix the lossy replay buffer** — this is non-negotiable:
- `agent-host-service.ts` caps `events` at 1000 with `events.shift()` eviction, and the *same* seq stream carries high-frequency `run-chunk`/`run-jsonl` spam (`wireRun`, 311-324). A single active run overflows the window during any disconnect, so `getEventsAfter(N)` returns a **silent gap**.
- **Split lifecycle events into their own large/unbounded monotonic log, separate from chunk/jsonl spam** (which are pass-through and droppable). Have `getEventsAfter` return an explicit `{ truncatedBelow: seq }` marker when the requested seq predates the buffer floor, so the API *knows* it has a gap and **falls to a Layer-2 level read** rather than silently trusting an incomplete replay. This makes Layer-1 failure *detectable* — the whole premise of "events are latency, reconcile is correctness."
- Respect `res.write` backpressure in the host's `streamEvents` (`http-server.ts`): pause forwarding until `drain`, or drop latency-class chunk/jsonl for a backpressured consumer while keeping lifecycle events queued — otherwise a wedged API-side reader is an unbounded host-side memory leak under exactly the "API not listening" scenario.

**Layer 3 — host self-durability (survive the host's own crash).**
The host can't write the DB, so its outbox is its own small local journal (append-only file / tiny SQLite in `PC_DATA_DIR`), keyed by `(runId, hostSeq)`:
- Append each lifecycle transition *before* acting; periodic snapshot + checkpoint to bound growth.
- On restart: load snapshot + replay journal → candidate runs; probe each by **PID + process-start-time (or a per-run sentinel file)** — never PID alone. This is a `win32` app; PID reuse is fast, and "alive + ours" by bare PID will reattach to a stranger's process and stream its exit code as the run's terminal result.
- For terminated/unknown, derive from the artifact, mark terminal, re-announce on next connect. Deliver-until-acked by `hostSeq`; API applies idempotently by `(runId, hostSeq)`.
- **Concurrent-decision hazard (real, must be handled):** journal-replay-on-restart and the periodic sweep can both decide terminal for the same run in the same window. SQLite serializes the *writes*, not the *decisions* — if they derive different failure causes (journal `cancelled` vs sweep-from-JSONL `failed`), blind last-writer-wins is nondeterministic. Fix: `markTerminal` is **compare-and-set on derive-source priority** (artifact > journal > host claim), refusing to overwrite a terminal row written by a higher-priority source — or funnel all terminal derivation for a given run through a single serialized per-run task in the API so only one decision is ever in flight.

Together: Layer 2 survives an **API restart**, Layer 3 survives a **host crash**, the artifact survives **both** dying. The terminal transition can no longer be lost.

## Why this over alternatives

- **vs. just hardening the event stream (reconnect/ack/retry):** still edge-triggered — a bad-enough blip loses the transition forever. Reconcile makes the loss *recoverable*. And as the buffer analysis shows, a hardened edge over a lossy replay buffer is *still* lossy.
- **vs. pure reconcile / polling only:** correct but laggy and wasteful; throws away the instant-update UX. The hybrid keeps events as the fast path, pays O(N) sweep only on a slow timer — trivial at desktop N.
- **vs. event sourcing / CQRS:** violates the repo ADR ("DB stays SoT; do not build a second event-log") and imposes schema-versioning/replay-correctness/snapshotting burden a solo-user app shouldn't carry. The outbox is transient and prunable; an event store is permanent truth.
- **vs. CDC / WAL-tailing SQLite:** CDC's win is auto-capturing many heterogeneous writers. Caisson has one writer; an in-txn outbox row gets ~95% of the benefit with none of the trigger/WAL-parse fragility, and emits semantic events (`run.terminated`) instead of raw row-diffs.
- **vs. a real sync engine (Replicache/Convex/Electric/PowerSync) or a broker (Kafka):** all buy offline writes, multi-client merge, CRDT/OT, or Postgres coupling — none relevant to one user on localhost. The primitives that matter (global `version`, per-entity `rev`, replayable one-door outbox, id-keyed reconcile) are a few hundred lines in the existing in-process API with zero new infra.

## Known limits & where the one mechanism bends

- **It's three tiers, not one.** Chat/JSONL (watch) and PTY/chunks (pass-through) are deliberately *exempt* from the outbox spine. Reconcile is the unifier only for DB-owned facts and externally-owned artifacts; chat's "apply" is render-bytes with no rev semantics, and JSONL reconcile (tail + parse transcript grammar) shares almost no code with DB-row reconcile (read a SQLite row). Honest framing: coherent by ownership tier, not one-size.
- **Layer-1 replay is lossy unless lifecycle events are separated from byte spam.** Without the split + `truncatedBelow` marker, reconnect replay silently gaps. The marker converts a silent gap into a detectable "fall to level read."
- **Reconnect-before-reconcile is backwards.** Reconcile-first (Layer 2 + sweep) kills the bug at sweep latency with simple stateless code; reconnect is then a pure latency add. A buggy reconnect shipped first reintroduces the lost-edge bug under a new guise.
- **The WS cursor cut-over is one atomic infra build, not a per-domain trickle.** The hub (`websocket-hub.ts`) is pure fanout — no per-socket cursor, no buffer, no replay. Catch-up requires: global-ordered outbox query, per-subscriber cursor, gap-detection→reload fallback, and an interleave-safe handoff. **Subscribe handshake (must be exact):** client sends `lastVersion`; server snapshots current max `version`, replays `(lastVersion, snapshot]` from the outbox, *then* attaches the live listener; live events with `version ≤ snapshot` are deduped client-side by per-entity `rev`. The per-domain work is only "switch each broadcaster to also append a `changes` row"; the cursor plumbing is built once for all domains.
- **Terminal-over-terminal is only a no-op when sources agree.** When they don't, compare-and-set on source priority (artifact > journal > host claim) is required; absorbing-state alone is insufficient.
- **Outbox pruning is by size/age, not live cursor.** Tracking durable per-client cursors (and reaping dead ones — closed tabs, sleep, crash) is over-engineered for a solo-user app. Keep a fixed cap (e.g. last 10k rows or 1h); a reconnecting client whose `lastVersion` predates the floor gets "too old → full domain reload," which is the cheap self-healing escape hatch.
- **Usage/telemetry must not share the correctness replay budget.** High-volume latency-class writes diluting the buffer that lifecycle deltas replay from is the same overflow failure mode one layer up. Separate channel or periodic-snapshot coalescing.

## Sequenced migration path

Reordered to **reconcile-first**. Each step independently shippable; nothing big-bang.

1. **Continuous reconcile + sweep (kills the bug, simple, stateless).** Add `GET /host/runs` (epoch + rev + runs + pid-start-time). Implement `reconcileRun(id)` with the precedence ladder and lazy JSONL. Add the periodic non-terminal sweep and epoch-change handling. Promote `reconcileAgentRunsOnBoot` into this continuous function, and **change it to stop trusting `hostRun.terminalResult`** — re-derive from the artifact. This alone kills the phantom-running bug at sweep latency, with no fragile concurrency code.
2. **Add per-entity `rev` to agent-runs + a write door.** Add `rev` to `AgentRunRecord` (`packages/domain/src/agent-system.ts`), bump on every write; create `apps/server/src/services/agent-run-writer.ts` mirroring the reference writers so mutation-without-announcement is structurally impossible; fix `use-project-agent-runs.ts` to `getVersion: r => r.rev`.
3. **Harden the stream as a latency layer.** Split lifecycle events from chunk/jsonl into a separate large/monotonic log; make `getEventsAfter` return `{ truncatedBelow }`. Add heartbeat + reconnect-with-backoff to `HttpAgentHostClient` (the abort-race-guarded loop). Add `res.write` backpressure to the host's `streamEvents`. On reconnect: replay lifecycle; on `truncatedBelow`, fall to a Layer-2 level read.
4. **Artifact backstop wired as tier-3.** JSONL/exit-file terminal detection as the precedence-ladder rung and the sweep's last resort for stuck rows.
5. **Host self-durability.** Append-only journal + snapshot/checkpoint; reattach-on-restart by PID+start-time; deliver-until-acked by `(runId, hostSeq)`; API applies idempotently; `markTerminal` compare-and-set on source priority (or per-run serialized derivation).
6. **Introduce the unified `changes` outbox + global `version`, dual-write first.** Add the `changes` table `(version, domain, entityId, rev, payload)` and a single commit-and-announce chokepoint in the API write helper. Existing per-domain broadcasts *also* append a `changes` row — zero behavior change yet.
7. **Cut WS over to cursor catch-up — one atomic infra milestone.** Build the subscribe handshake exactly as specified (snapshot max version → replay `(lastVersion, snapshot]` → attach listener → client dedupe by rev). Switch all domains to deliver from `changes` together; per-domain work is only deleting each ad-hoc broadcast as the relay takes over. Prune by size/age; `lastVersion` below the floor → full domain reload.
8. **Generalize.** Orchestrator runtime, send-queue ride `changes` by construction; enforce via the write helper so new write paths announce automatically. Usage/telemetry goes on its **separate** coalesced channel. In-process (no-host) agent runs stream through a local file/pipe so boot-reattach works there too.

Steps 1–5 retire the critical bug (reconcile before reconnect); 6–8 generalize the one door.

## Non-goals (do NOT)

- Do **not** build a second event-log as source of truth, adopt event sourcing, or make SQLite append-only. The outbox is transient and prunable; domain tables stay canonical.
- Do **not** let the host (or anything but the API) write SQLite. Single-writer is *why* the host is out-of-process.
- Do **not** trust a single host event's claimed transition, or the host's `terminalResult`, over the artifact — re-derive from the precedence ladder. Do **not** infer "terminal" from one absent event; require a full-snapshot omission or epoch flip, cross-checked against the artifact.
- Do **not** conflate `version` (global outbox sequence) and `rev` (per-entity row version) — they are two counters with two jobs.
- Do **not** call `hub.broadcast` inside a `db.transaction(...)` closure — announce in-txn (the `changes` row), deliver post-commit (the relay).
- Do **not** push transcript bytes or any large blob through the outbox — carry pointer + rev; chat stays file-tailed.
- Do **not** put the live PTY stream or raw JSONL/chunk lines under the versioned-snapshot model, or let them share the lifecycle event log / outbox replay budget — they're pass-through latency-class.
- Do **not** ship the reconnect loop before the reconcile backstop exists — reconcile-first.
- Do **not** treat `getEventsAfter` replay as complete — it is lossy by construction until lifecycle events are separated and `truncatedBelow` is surfaced.
- Do **not** reattach by bare PID on Windows — identity is PID + process-start-time (or a sentinel).
- Do **not** prune the outbox by live-cursor watermark or track durable per-client cursors — prune by size/age, full-reload stale reconnects.
- Do **not** route high-volume usage/telemetry through the correctness-critical replay budget — separate channel or periodic snapshots.
- Do **not** adopt CDC/WAL parsing, a broker, a sync-engine product, or chase exactly-once at the transport layer. At-least-once + idempotent is the target.
- Do **not** keep "reconcile only at boot." Continuous sweep is the correctness guarantee; the boot pass is just its first invocation.

## Implementation anchors

`apps/server/src/services/agent-host-client.ts:409-434` (no reconnect loop), `agent-run-boot-reconcile.ts:156-174` (trusts host terminalResult — must stop), `agent-run-writer.ts` (to create), `agent-run-factory.ts`, `agent-run-terminal-effects.ts`; `packages/agent-host/src/agent-host-service.ts` (buffer cap + mixed event classes — split them), `packages/agent-host/src/http-server.ts` (no `res.write` backpressure); `packages/domain/src/agent-system.ts` (`AgentRunRecord` needs `rev`); `apps/web/src/hooks/use-project-agent-runs.ts`, `use-resource-list.ts:122-125` (per-entity rev discard); `apps/server/src/services/websocket-hub.ts` (no cursor/replay — build the handshake); reference writers `apps/server/src/services/{work-item,workflow-run,pod}-writer.ts` (replace read-back-broadcast with relay-drains-outbox).
