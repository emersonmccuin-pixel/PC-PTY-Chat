# Caisson — Project Tracker

Living "where are we / what's next." The durable course doc — update it at each session close.
Last updated: 2026-05-29.

## ⏭ Next session — discuss first
Open threads to triage at the top of the next session (detail in "Open threads" below):
1. **Verify unread-project indicators** — feature landed (`52b606fa`) + crash-guard added (`f52c70a8`); not yet eyeballed in the browser after the fix. Quick Ctrl+R + confirm dots behave, then it's done.
2. **Packaged agent-host: crash-isolation vs. survival** (open #2) — release-gating decision.
3. **Workflow isolation bug** `pc-pty-chat-82` (open #3) — agents sometimes commit to `dev` not their worktree; correctness hazard. Has a canary repro plan.
4. **WS binder → store/slice refactor** (open #4) — in progress in a parallel session; check status before touching `wsEvents[]` consumers.
5. **Chat follow-ups** (open #5) — Stage 2b inline cards, then Stage 6 legacy-renderer deletion after A/B soak.
6. **node-pty `AttachConsole failed`** (open #6) — recurring native crash; mitigation tied to #2.

Housekeeping: `dev` is unpushed (now @ `1fa589c9`); integration worktrees still need pruning (see Cleanup).

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
