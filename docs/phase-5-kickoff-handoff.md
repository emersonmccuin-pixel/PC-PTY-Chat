# Phase 5 Kickoff Handoff

Purpose: make a fresh session able to start the next phase after the architecture
refactor without reconstructing state from chat history.

## Current State

As of this handoff:

- Primary checkout: `E:\Claude Code Projects\Personal\PC-PTY-Chat`
- Primary branch: `dev`
- Refactor phases complete:
  - Phase 1: server route extraction
  - Phase 2: MCP tool split
  - Phase 3: web API client/contract split
  - Phase 4: `ChatSurface` decomposition
- Architecture hardening plan exists at:
  - `docs/architecture-hardening-audit.md`
- The next phase should start from `dev` after the refactor merge.

Do not assume old Codex worktree branches are still current. If using a Codex
worktree, base the next branch from current `dev`.

## Start A Fresh Codex Session

Use this exact first message after clearing context:

```text
Use only this worktree unless you need to create a fresh Codex worktree:
E:\Claude Code Projects\Personal\PC-PTY-Chat

Do not restart the app, dev server, dogfood app, Vite, channel server, or POST /api/dev/restart.

Read:
E:\Claude Code Projects\Personal\PC-PTY-Chat\AGENTS.md
E:\Claude Code Projects\Personal\PC-PTY-Chat\CLAUDE.md
E:\Claude Code Projects\Personal\PC-PTY-Chat\docs\architecture-refactor-plan.md
E:\Claude Code Projects\Personal\PC-PTY-Chat\docs\architecture-hardening-audit.md
E:\Claude Code Projects\Personal\PC-PTY-Chat\docs\phase-5-kickoff-handoff.md

Then start Phase 5.
First verify branch/worktree state.
If you need to make code changes, create or use a Codex-owned worktree/branch from current dev.
Do not begin with code changes.
First create docs/system-map.md and docs/pods/index.md.
Then begin the first pod audit for chat-runtime-websocket.
```

## Startup Checks

Run from the primary checkout before creating or using a worktree:

```powershell
Set-Location "E:\Claude Code Projects\Personal\PC-PTY-Chat"
git status --short --branch
git worktree list --porcelain
git log --oneline -8
```

Expected:

- `dev` is the integration branch.
- Primary checkout is clean before starting.
- No app/server restart is needed.

If a Codex worktree is needed for edits, create a new branch from current `dev`.
Use a new branch name so old refactor branches are not reused accidentally:

```powershell
git worktree add -b codex/phase-5-hardening "E:\Claude Code Projects\Personal\PC-PTY-Chat-phase5" dev
```

Then work only in:

```text
E:\Claude Code Projects\Personal\PC-PTY-Chat-phase5
```

## Next Objective

Start the Architecture Hardening Audit.

First deliverables:

1. `docs/system-map.md`
2. `docs/pods/index.md`
3. First pod audit: `docs/pods/chat-runtime-websocket.md`

Do not start by changing runtime behavior. Start by mapping.

## Phase 5 Method

Use the loop from `docs/architecture-hardening-audit.md`:

1. Inventory
2. Audit
3. Plan
4. Patch
5. Verify
6. Record

For the first pod, trace these workflows:

- project opens and receives current runtime snapshot;
- WebSocket connects, heartbeats, misses heartbeat, reconnects;
- replay restores prior session events;
- user prompt gets client id, pending prompt, server ack, queue status, PTY write, JSONL user echo, turn end;
- queued prompt waits through busy/spawning and drains later;
- terminal mode receives raw events and sends gated raw input;
- session switch/new/resume updates replay, queue, JSONL cursor, and UI state;
- agent transcript modal opens active and historical runs.

## Guardrails

- Work one pod at a time.
- Read and map before changing code.
- Do not let multiple agents edit overlapping pods at the same time.
- Keep behavior-preserving moves separate from behavior changes.
- Add or update tests before deleting compatibility paths.
- Do not replace runtime primitives without a failing trace or explicit product reason.
- Do not restart servers or apps.

## Useful Verification Commands

Use focused checks after mapping/code slices:

```powershell
pnpm --filter @pc/web typecheck
pnpm --filter @pc/server typecheck
pnpm --filter @pc/server test
git diff --check
```

Use broader checks before closing a major slice:

```powershell
pnpm typecheck
pnpm test:unit
git diff --check
git status --short --branch
```

## Completion Criteria For Kickoff Slice

The kickoff slice is complete when:

- `docs/system-map.md` exists and maps packages, route groups, web features,
  WebSocket/event surfaces, MCP tools, and DB repo/table areas.
- `docs/pods/index.md` exists and lists pod status.
- `docs/pods/chat-runtime-websocket.md` exists with ownership, workflows,
  dependency map, dead-code/drift notes, tests/gaps, cleanup plan, and
  completion criteria.
- No runtime behavior has been changed unless explicitly scoped after mapping.
- Verification commands have been run and recorded.
