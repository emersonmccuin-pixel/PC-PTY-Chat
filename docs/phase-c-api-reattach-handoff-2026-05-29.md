# Phase C API Reattach Handoff - 2026-05-29

## Current State

- Worktree: `E:\Claude Code Projects\Personal\PC-PTY-Chat-post-phase5`
- Branch: `codex/post-phase5-dev-controls-cleanup`
- Code commit: `27973582586f363a9b3ddee90e951621f09487bd`
- Code commit message: `Add host reattach API seam`
- This handoff file is committed separately on top of that code commit.
- Base pickup commit for this slice was `a072e756`.
- Do not edit the primary checkout at `E:\Claude Code Projects\Personal\PC-PTY-Chat`.
- Do not restart app/dev server/dogfood/Vite/channel server.
- Do not POST `/api/dev/restart`.

## Phase C Progress

Implemented first API reattach slice:

- Added host-aware active-run handle in `apps/server/src/services/agent-active-runs.ts`.
- Added `mark-paused` to `packages/runtime/src/agent-host-protocol.ts`.
- Implemented `mark-paused` in `packages/agent-host/src/agent-host-service.ts`.
- Tightened host-mode boot reconcile in `apps/server/src/services/agent-run-boot-reconcile.ts`.
- Added `apps/server/src/services/agent-host-reattach.ts`.
- Added tests:
  - `apps/server/test/agent-host-reattach.test.ts`
  - expanded `apps/server/test/agent-active-runs.test.ts`
  - expanded `apps/server/test/agent-run-boot-reconcile.test.ts`
  - expanded `packages/agent-host/test/agent-host-service.test.ts`

Behavior now covered:

- Host-mode reconcile uses `host-lost`, not `server-restart`, for host-missing runs.
- Host snapshots are validated against DB row identity.
- Terminal host snapshots are persisted idempotently.
- Paused host-missing rows are kept only when an open pending ask exists and JSONL is still present.
- Host-backed active handles route cancel, pause, answer, and MCP handshake to host commands.
- Reattach coordinator can register host-backed handles, backfill JSONL, broadcast host JSONL events, and apply host terminal events once.

Continuation update:

- Added the API-side JSON-lines host client seam and server boot coordinator.
- Wired server boot to use host reattach when a host client is available, preserving legacy reconcile when not.
- Routed fresh/continue agent dispatch through host `start-run` / `resume-run` when the API has a host client.
- Reused API-owned terminal side effects for host terminal events: DB terminal persistence, Activity Panel broadcast, inbox/channel delivery, contract verification, and cleanup.
- Threaded the boot-resolved host client into invoke/continue routes and verification-reject continuations.
- Added fake-host coverage for boot reattach, dispatch, terminal replay, route wiring, and multi-run boot reattach.

## Verification Run

Passed:

```powershell
pnpm --filter @pc/web typecheck
pnpm --filter @pc/server typecheck
pnpm --filter @pc/runtime typecheck
pnpm --filter @pc/agent-host typecheck
pnpm --filter @pc/server exec tsx --test test/agent-run-boot-reconcile.test.ts test/agent-active-runs.test.ts test/agent-host-reattach.test.ts test/mcp-bridge-routes.test.ts test/agent-pause-resume.test.ts test/agent-run-routes.test.ts
pnpm --filter @pc/agent-host test
git diff --check
```

Focused server test result: 36 passed.

Agent host test result: 5 passed.

## Not Done Yet

Phase C API-side seams are complete under the no-real-host constraint.

Remaining durable-host work:

- Phase D: start/supervise the agent host from dev supervisor and packaged Electron.
- Phase D: wire real host discovery into `resolveAgentHostClientForBoot()`.
- Phase D: define shutdown semantics for user quit vs. API restart.
- Phase E: workflow subagent migration.

## Suggested Next Slice

Start Phase D without restarting the live app:

1. Add a host lock-file schema under `PC_DATA_DIR/agent-host`.
2. Teach the dev supervisor to launch the host as a sibling child process.
3. Keep sentinel API restart scoped to the API child only.
4. Wire `resolveAgentHostClientForBoot()` to discover/connect to the lock-file host.
5. Add fake process/transport tests first; do not run manual restart smoke until the user explicitly allows it.

## Startup Checks For Next Session

Run from `E:\Claude Code Projects\Personal\PC-PTY-Chat-post-phase5`:

```powershell
git worktree list --porcelain
git status --short --branch
git rev-parse HEAD
pnpm --filter @pc/web typecheck
pnpm --filter @pc/server typecheck
```

Then read:

- `docs/out-of-process-agent-host-design.md`
- `docs/out-of-process-agents-todo.md`
- `docs/phase-c-api-reattach-handoff-2026-05-29.md`
- `apps/server/src/services/agent-host-reattach.ts`
- `apps/server/src/services/agent-run-boot-reconcile.ts`
- `apps/server/src/services/agent-active-runs.ts`

## Starter Prompt

```text
Use only E:\Claude Code Projects\Personal\PC-PTY-Chat unless verifying state.
Do edits only in E:\Claude Code Projects\Personal\PC-PTY-Chat-post-phase5.
Do not restart app/dev server/dogfood/Vite/channel server or POST /api/dev/restart.

Pick up branch codex/post-phase5-dev-controls-cleanup at the latest committed HEAD.
Continue Phase C API reattach from docs/phase-c-api-reattach-handoff-2026-05-29.md and docs/out-of-process-agent-host-design.md.
First verify worktree/branch state and read the relevant docs before code changes.

Next slice: add the API-side host client seam and wire server boot reattach in fake-host/testable form without starting or restarting any real server/host process.
```
