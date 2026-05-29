# Caisson — Project Tracker

Living "where are we / what's next." The durable course doc — update it at each session close.
Last updated: 2026-05-29.

## Current state
- `dev` @ `ebb2b735`, pushed to `origin`. Running live in the dev stack.
- Backup tags: `backup/dev-pre-host-merge`, `backup/dev-pre-perf-oom`.

## Landed (2026-05-29)
- **Chat: JSONL-canonical renderer** — default ON. Chat renders from the JSONL transcript only (no dual-sourcing); id-keyed optimistic reconcile; `rowPolicy` is the suppression authority. ADR: `docs/chat-canonical-source-redesign.md`. Stages 0–3 done. Legacy renderer frozen, reachable via `localStorage caisson.chat.jsonlCanonical='0'`. DevControls has `canon`/`reveal` toggles.
- **Chat: send-batching** — messages sent while Claude is busy coalesce into ONE prompt, flushed on ready + ~1.2s settle. `useSendBatch` + `SendBatchTray`. Triggers on in-flight pending (not just laggy isThinking).
- **Agent-host v2 merged** (adopt v2 / retire v1) — Codex's out-of-process host (`packages/agent-host`). **DORMANT**: `resolveAgentHostClientForBoot()` returns null → boot/dispatch stay in-process. Host OFF until Phase D. v1 (`runtime/src/host`, `server/agent-host`) deleted.
- **Dev perf-OOM fix** — `apps/web/src/dev-perf-buffer.ts` reaper clears `performance` measures/marks every 30s (dev-only); stops the React `logComponentRender` `DataCloneError` OOM.

## Open threads (priority order)
1. **Agent host Phase D** — supply/connect the host client + validate agents survive a server restart (the actual goal; scaffolding shipped, off). `docs/out-of-process-agents-todo.md`.
2. **Workflow isolation bug** (EPIC `pc-pty-chat-82`) — workflow agents sometimes commit straight to `dev` instead of their auto-worktree (canary-4 failed, canary-3 passed). Correctness hazard. Next: dispatch a canary, inspect the live coder's materialized `.claude/settings.json` + confirm `PreToolUse` path-guard hook registered AND `PC_WORKFLOW_RUN_ID` in env. `docs/workflow-hardening-handoff-2026-05-29.md`.
3. **WS "binder" → store/slice refactor** — one `wsEvents[]` array is handed to every panel; each rescans it (perf + the "activity rail doesn't update until refresh" bug). **Full design: `docs/ui-change-propagation-spine.md` (ADR).** Core: one write-door per data kind that announces *what* changed (versioned, by id), frontend redraws only the affected slice (no whole-list reloads); watch only what you don't control (JSONL), announce everything you do. Server already emits per-domain `*-changed` doorbells → route to per-domain zustand store slices → panels subscribe via selectors. Start with **work-items** (highest scan volume). Generalizes the chat-canonical fix.
4. **Chat follow-ups** — Stage 2b: workflow/agent inline cards in the canonical renderer (they're `type:'event'` overlay, no JSONL equivalent). Then Stage 6: delete legacy renderer + `seenTs` dedup + fuzzy-text reconcile, after A/B soak confirms canonical.
5. **node-pty `AttachConsole failed`** — recurring native ConPTY crash (3× on 2026-05-29), uncatchable in JS, tied to PTY spawn churn. Server has survived recent hits (helper-process crash). Agent host (Phase D) is the durable mitigation.

## Guardrails / decisions
- **Agent host stays OFF** until Phase D is validated.
- **Canonical chat is default-on for A/B**; legacy reachable via `localStorage '0'`; **do NOT delete legacy** until soak confirms.
- `dev` = the integration + live-test checkout. **Merge-only / ff-only** from worktrees; never run a merge *computation* in the primary checkout (resolve in a worktree, then `ff-only`).
- Codex worktrees are Codex-owned; integrate their committed work via worktree-merge → verify → `ff-only`.

## Cleanup (when sure)
- Prune integration worktrees: `PC-PTY-Chat-host-merge`, `PC-PTY-Chat-perf-oom`, `PC-PTY-Chat-chat-canonical`.
- `codex/architecture-refactor` branch is redundant — its only commit's content (`architecture-hardening-audit.md`) is already byte-identical in `dev`.
