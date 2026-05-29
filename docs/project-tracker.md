# Caisson — Project Tracker

Living "where are we / what's next." The durable course doc — update it at each session close.
Last updated: 2026-05-29 (state-propagation decision locked + build started).

## ⏭ Next session — discuss first
Open threads to triage at the top of the next session (detail in "Open threads" below):
0. **🚧 ACTIVE BUILD — State-propagation overhaul** (see "Active workstream" below). Locked decision: `docs/state-propagation-decision.md`. Resume at the next unchecked step. This is the current primary thread; supersedes open #4 (WS store/slice) and absorbs the agent-host lifecycle drift (open #2 evidence).
1. **Verify unread-project indicators** — feature landed (`52b606fa`) + crash-guard added (`f52c70a8`); not yet eyeballed in the browser after the fix. Quick Ctrl+R + confirm dots behave, then it's done.
2. **Packaged agent-host: crash-isolation vs. survival** (open #2) — release-gating decision.
3. **Workflow isolation bug** `pc-pty-chat-82` (open #3) — agents sometimes commit to `dev` not their worktree; correctness hazard. Has a canary repro plan.
4. **WS binder → store/slice refactor** (open #4) — in progress in a parallel session; check status before touching `wsEvents[]` consumers.
5. **Chat follow-ups** (open #5) — Stage 2b inline cards, then Stage 6 legacy-renderer deletion after A/B soak.
6. **node-pty `AttachConsole failed`** (open #6) — recurring native crash; mitigation tied to #2.

Housekeeping: `dev` is unpushed (now @ `1fa589c9`); integration worktrees still need pruning (see Cleanup).

## Active workstream — State-propagation overhaul (outbox spine + watch/reconcile)
**Decision doc:** `docs/state-propagation-decision.md` (locked 2026-05-29). Generalizes `ui-change-propagation-spine.md` to every hop.
**One-line:** DB-owned facts ride a versioned `changes` outbox w/ cursor catch-up; externally-owned state (host runs, JSONL) is re-derived by a continuous idempotent reconcile loop; firehose streams are pass-through. Events = latency, reconcile = correctness.
**Why:** agent-host terminal transitions are lost when the API isn't listening (no reconnect/heartbeat) → phantom "running" runs, orchestrator never notified, stages don't flip. Evidence: 2 runs terminal in host, stuck `queued` in DB (verified 2026-05-29).
**Build order is reconcile-FIRST** (ship the backstop before the fragile reconnect, else the bug returns in a new costume).

- [~] **Step 1 — Continuous reconcile + sweep.** ✅ CORE SHIPPED (uncommitted on dev, 2026-05-29): `reconcileAgentRunsAgainstHost()` in `agent-host-reattach.ts` (idempotent, full effects via `applyHostTerminalSnapshot` → DB flip + orchestrator notify + rail broadcast) + 15s interval in `index.ts` (host-mode only, `list-runs` pull → reconcile, unref'd, cleared in gracefulShutdown) + 2 tests (reproduces the stuck-`queued`/host-`completed` bug). Server typecheck + 5/5 reattach tests green. **This self-heals the phantom-running bug within 15s.** REMAINING sub-items (don't close Step 1 yet): (a) `GET /host/runs` exposing `hostEpoch` + per-run `pid`+`pidStartTime`; (b) full precedence ladder w/ **waitpid** rung + **artifact-wins-on-disagreement** (stop trusting `hostRun.terminalResult` in `agent-run-boot-reconcile.ts:156-174`); (c) `hostEpoch`-flip orphan finalization for host-missing rows (sweep currently leaves them alone — conservative); (d) lazy JSONL tail + per-run coalesce/debounce. NOTE: takes effect on next dev-server restart (user-triggered).
- [ ] **Step 2 — Agent-runs per-entity `rev` + write-door.** Add `rev` to `AgentRunRecord` (`packages/domain/src/agent-system.ts`); create `agent-run-writer.ts`; fix `use-project-agent-runs.ts` → `getVersion: r => r.rev`.
- [ ] **Step 3 — Harden stream as latency layer.** Split lifecycle events from chunk/jsonl into a separate large/monotonic log; `getEventsAfter` returns `{ truncatedBelow }`; heartbeat + reconnect-with-backoff in `HttpAgentHostClient` (abort-race guarded); `res.write` backpressure in host `streamEvents`. On `truncatedBelow` → fall to Layer-2 level read.
- [ ] **Step 4 — Artifact backstop (tier 3).** JSONL/exit-file terminal detection as the precedence-ladder rung + sweep last-resort for stuck rows.
- [ ] **Step 5 — Host self-durability.** Append-only journal + snapshot/checkpoint in `PC_DATA_DIR`; reattach by **PID+process-start-time** (never bare PID — win32); deliver-until-acked by `(runId, hostSeq)`; idempotent apply; `markTerminal` compare-and-set on source priority (artifact > journal > host claim).
- [ ] **Step 6 — Unified `changes` outbox + global `version`, dual-write first.** `changes(version, domain, entityId, rev, payload)` + commit-and-announce chokepoint in API write helper; existing broadcasts *also* append a row (zero behavior change yet).
- [ ] **Step 7 — Cut WS to cursor catch-up (one atomic infra build).** Subscribe handshake: client sends `lastVersion` → server snapshots max version → replays `(lastVersion, snapshot]` → attaches listener → client dedupes by rev. Prune outbox by size/age; stale `lastVersion` → full domain reload. `websocket-hub.ts` has no cursor today — build it once for all domains.
- [ ] **Step 8 — Generalize.** Orchestrator runtime + send-queue ride `changes` via the write helper; usage/telemetry on a SEPARATE coalesced channel; in-process (no-host) runs stream via local file/pipe so boot-reattach works there too.

**Guardrails (from the doc — do NOT):** no second event-log-as-truth; only API writes SQLite; never trust one host event / `terminalResult` over the artifact; don't conflate `version` (global cursor) vs `rev` (per-entity); never `hub.broadcast` inside a `db.transaction()`; no transcript bytes through the outbox; PTY/chunks stay pass-through; reconnect never before reconcile.

## Current state
- `dev` @ `1fa589c9` (local; NOT yet pushed to `origin`). Phase D + schema-intact guard + unread indicators landed; applies on next `pnpm dev` restart.
- Backup tags: `backup/dev-pre-host-merge`, `backup/dev-pre-perf-oom`, `backup/dev-pre-phaseD-merge`.

## Landed (2026-05-29)
- **Agent host Phase D (dev + packaged wiring)** — `integ/phase-d` ff'd into `dev` (`2a43e525`). Codex's two commits: (1) dev-supervisor launches the host as a sibling + lock-file discovery in `resolveAgentHostClientForBoot()`; (2) packaged Electron spawns the host via `ELECTRON_RUN_AS_NODE` + staged `agent-host.mjs` + quit-time shutdown. **No env gate** — host is on-by-default once running. Verified: server 567 + runtime 260 tests, all typechecks, both bundles build. **CAVEAT:** packaged host is *crash-isolation, not survival* — it dies with the app on quit/crash and starts fresh (no re-adopt). True restart-survival only works in the dev stack. Decision needed before release (see open #2).
- **Chat: send-batch per-session scoping fix** — `2522b752`. Queue moved from component-local state into a `sessionId`-keyed zustand store (`store/send-batch.ts`); each chat owns its queue and only flushes for the chat it belongs to. Fixes cross-chat misfire (queue composed in A fired through active chat B). No web test infra → covered by typecheck + manual.
- **Chat: JSONL-canonical renderer** — default ON. Chat renders from the JSONL transcript only (no dual-sourcing); id-keyed optimistic reconcile; `rowPolicy` is the suppression authority. ADR: `docs/chat-canonical-source-redesign.md`. Stages 0–3 done. Legacy renderer frozen, reachable via `localStorage caisson.chat.jsonlCanonical='0'`. DevControls has `canon`/`reveal` toggles.
- **Chat: send-batching** — messages sent while Claude is busy coalesce into ONE prompt, flushed on ready + ~1.2s settle. `useSendBatch` + `SendBatchTray`. Triggers on in-flight pending (not just laggy isThinking).
- **Agent-host v2 merged** (adopt v2 / retire v1) — Codex's out-of-process host (`packages/agent-host`). **DORMANT**: `resolveAgentHostClientForBoot()` returns null → boot/dispatch stay in-process. Host OFF until Phase D. v1 (`runtime/src/host`, `server/agent-host`) deleted.
- **Dev perf-OOM fix** — `apps/web/src/dev-perf-buffer.ts` reaper clears `performance` measures/marks every 30s (dev-only); stops the React `logComponentRender` `DataCloneError` OOM.

## Open threads (priority order)
1. **DB migration ledger drift — RESOLVED (was a one-off, NOT a migration bug)** — dev server crash-looped on boot (`no such column: rev` in orchestrator-pod seed) because `data/pc.sqlite`'s `__drizzle_migrations` ledger recorded `0031`/`0032` as *applied* while their columns were absent (drizzle decides what to apply by timestamp, so it skipped them). **Verified the migrations are sound:** a fresh DB applies `0031`–`0033` cleanly (all `rev` columns land). So fresh installs / releases / dogfood-on-next-promote are unaffected — this was a one-off corruption of the dev DB only (likely a hand-created/regenerated migration recorded before its SQL existed, or a backup restore). Repaired by hand-adding `workflow_runs_v2.rev`, `agent_runs.rev`, `agents.rev` (`projects.stages_rev` already present). Detail: [[reference_drizzle_ledger_lies_fresh_db_crash]]. **Hardening shipped (`972ae72b`):** `assertSchemaIntact()` runs after `migrate()` and throws a clear error naming any table/column the schema declares but the DB lacks — so this class of drift fails loudly at boot instead of an opaque `no such column` crash-loop. Guarded by `packages/db/test/schema-intact-guard.test.ts`.
2. **Packaged agent-host: crash-isolation vs. survival (DECISION before release)** — Phase D's packaged host dies with the app and starts fresh (no re-adopt), so packaged agents do NOT survive a quit/crash; only the dev stack delivers true survival. Decide whether v1 release ships isolation-only or needs detached-host + re-adopt (more work). Gates the release.
3. **Workflow isolation bug** (EPIC `pc-pty-chat-82`) — workflow agents sometimes commit straight to `dev` instead of their auto-worktree (canary-4 failed, canary-3 passed). Correctness hazard. Next: dispatch a canary, inspect the live coder's materialized `.claude/settings.json` + confirm `PreToolUse` path-guard hook registered AND `PC_WORKFLOW_RUN_ID` in env. `docs/workflow-hardening-handoff-2026-05-29.md`.
4. **WS "binder" → store/slice refactor** — **IN PROGRESS (parallel session).** Write-doors + rev stamps + version-aware stores shipped for **work-items, workflow-runs/agent-runs, pods, and stages** (commits through `0ed6471f`). ADR: `docs/ui-change-propagation-spine.md`. Remaining: roll the same pattern across any panels still rescanning `wsEvents[]`. NOTE: this work introduced the migration-ledger bug in open #1 — keep an eye on new `rev`/version migrations applying cleanly.
5. **Chat follow-ups** — Stage 2b: workflow/agent inline cards in the canonical renderer (they're `type:'event'` overlay, no JSONL equivalent). Then Stage 6: delete legacy renderer + `seenTs` dedup + fuzzy-text reconcile, after A/B soak confirms canonical.
6. **node-pty `AttachConsole failed`** — recurring native ConPTY crash (3× on 2026-05-29), uncatchable in JS, tied to PTY spawn churn. Server has survived recent hits (helper-process crash). Agent host (now landed) is the durable mitigation once survival semantics are decided (open #2).

## Guardrails / decisions
- **Agent host Phase D landed on `dev` (on-by-default, no env gate).** Not yet live-validated via a real restart-survival test — do that with the user present before relying on it / before any release. Packaged survival semantics still undecided (open #2).
- **Canonical chat is default-on for A/B**; legacy reachable via `localStorage '0'`; **do NOT delete legacy** until soak confirms.
- `dev` = the integration + live-test checkout. **Merge-only / ff-only** from worktrees; never run a merge *computation* in the primary checkout (resolve in a worktree, then `ff-only`).
- Codex worktrees are Codex-owned; integrate their committed work via worktree-merge → verify → `ff-only`.

## Cleanup (when sure)
- Prune integration worktrees: `PC-PTY-Chat-host-merge`, `PC-PTY-Chat-perf-oom`, `PC-PTY-Chat-chat-canonical`, `PC-PTY-Chat-phaseD-merge` (Phase D landed).
- `codex/architecture-refactor` branch is redundant — its only commit's content (`architecture-hardening-audit.md`) is already byte-identical in `dev`.
