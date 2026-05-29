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

Phase C is not complete.

Remaining Phase C work:

- Wire `reattachAgentRunsOnBoot` into server boot.
- Add a real API-side host client for the Phase B JSON-lines host process.
- Route orchestrator-dispatched agent start/continue through host `start-run` and `resume-run`.
- Reuse terminal side effects for host terminal events:
  - DB terminal persistence
  - Activity Panel broadcast
  - inbox/channel delivery
  - contract verification
  - cleanup where still API-owned
- Add boot-level fake-host integration tests around API startup behavior.
- Decide whether legacy in-process mode remains default until Phase D supervisor wiring exists.

Later phases:

- Phase D: dev supervisor and Electron packaged host startup/shutdown.
- Phase E: workflow subagent migration.

## Suggested Next Slice

Build a server-side host client seam without starting real processes yet.

Recommended order:

1. Add an interface around the JSON-lines host process command/event stream.
2. Add a fake-host implementation for server boot tests.
3. Wire `reconcileAgentRunsOnBoot()` call in `apps/server/src/index.ts` to use host mode only when a host client is available.
4. Register reattached host handles after boot using `reattachAgentRunsOnBoot`.
5. Keep production in legacy mode until Phase D starts/supervises the host.

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
