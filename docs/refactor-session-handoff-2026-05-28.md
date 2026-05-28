# Refactor Session Handoff - 2026-05-28

Purpose: make a fresh session able to continue the architecture refactor without
reconstructing state from chat history.

## Start A Fresh Codex Session

Use this exact first message in a new Codex session:

```text
Use only this worktree:
E:\Claude Code Projects\Personal\PC-PTY-Chat-codex

Do not touch this primary checkout:
E:\Claude Code Projects\Personal\PC-PTY-Chat

Read:
E:\Claude Code Projects\Personal\PC-PTY-Chat-codex\AGENTS.md
E:\Claude Code Projects\Personal\PC-PTY-Chat-codex\CLAUDE.md
E:\Claude Code Projects\Personal\PC-PTY-Chat-codex\docs\codex-worktree-workflow.md
E:\Claude Code Projects\Personal\PC-PTY-Chat-codex\docs\refactor-session-handoff-2026-05-28.md

Then continue the architecture refactor from the handoff.
Do not restart the app, dev server, dogfood app, Vite, channel server, or POST /api/dev/restart.
Do not merge anything while Claude is still working in the primary checkout.
```

Plain English:

1. Claude keeps using `E:\Claude Code Projects\Personal\PC-PTY-Chat`.
2. Codex uses `E:\Claude Code Projects\Personal\PC-PTY-Chat-codex`.
3. Codex commits work on `codex/architecture-refactor`.
4. Do not merge final refactor work until Claude is done and committed.
5. When Claude is done, ask Codex: "Claude is done and committed. Merge the refactor from the Codex worktree."

## Current State

Branch at original handoff time: `dev`, ahead of `origin/dev` by 51 commits.
Current Codex continuation work should happen in the Codex worktree at
`E:\Claude Code Projects\Personal\PC-PTY-Chat-codex` on
`codex/architecture-refactor`; do not edit the primary checkout.

The current uncommitted work has three intentional groups:

1. Quick Tasks retirement.
2. Remaining Phase 0 runtime truthfulness fixes.
3. Refactor documentation updates.

There are also two unrelated modified files that were already present during
the cleanup and should not be reverted unless the user asks:

- `apps/web/src/components/Shell.tsx`
- `apps/desktop/src/main.ts`

## What Was Completed

Quick Tasks was removed from live code:

- Deleted server route and seed files:
  - `apps/server/src/routes/quick-tasks-routes.ts`
  - `apps/server/src/services/quick-tasks-seed.ts`
  - quick-tasks seed tests
- Removed Quick Tasks boot seeding and route registration from `apps/server/src/index.ts`.
- Removed Quick Tasks MCP tools and inline handlers from `packages/mcp/src/server.ts`.
- Removed Quick Tasks catalog entries from `packages/domain/src/tool-catalog.ts`.
- Removed special runtime/project branching from `apps/server/src/services/project-runtime.ts`.
- Removed `Project.kind`, `ProjectKind`, and `isQuickTasksKind`.
- Removed `WorkItem.taggedProjectId` and DB/repo plumbing around tagged Quick Tasks work items.
- Removed `quick-tasks-pm` and Quick Tasks grants/prompts from stock pod content.
- Added `packages/db/drizzle/0029_remove_quick_tasks.sql`.

The earlier concern about refactor regression was resolved: Quick Tasks was not
accidentally reintroduced by old unmerged work. It was deliberately kept during
the safe tool-pruning recovery, so the old inline MCP handlers remained until
this cleanup removed them.

Remaining Phase 0 fixes completed:

- Added agent transcript backfill:
  - Server: `GET /api/projects/:projectId/agent-runs/:runId/events`
  - Runtime: `AgentRunJsonlTailer.drainAvailable()`
  - Web: `AgentTranscriptModal` backfills provider JSONL and merges it with
    live `agent-jsonl-event` WebSocket envelopes.
- Added a runtime input capability object:
  - `RuntimeInputCapabilities` in `apps/web/src/features/chat/runtimeState.ts`
  - `ChatSurface` now gates composer input, send, interrupt, terminal input,
    and terminal resize from one capability object.
  - Orchestrator raw terminal input is writable only when runtime health is
    `ready`.
  - Transient modal terminal input is writable only when session state is
    `ready`.

Docs updated:

- `docs/architecture-refactor-plan.md`
- `docs/phase-2-mcp-tool-split.md`
- `docs/unmerged-work-recovery-2026-05-28.md`

## Verification Already Passed

Run after the current changes:

```powershell
pnpm --filter @pc/server test
pnpm --filter @pc/runtime test
pnpm --filter @pc/domain test
pnpm --filter @pc/mcp test
pnpm --filter @pc/server typecheck
pnpm --filter @pc/web typecheck
pnpm --filter @pc/mcp typecheck
pnpm --filter @pc/db typecheck
pnpm --filter @pc/desktop typecheck
git diff --check
```

Observed counts:

- Server: 492 tests passed.
- Runtime: 252 tests passed.
- Domain: 208 tests passed.
- MCP: 31 tests passed.

## Fresh Session First Steps

Start in the Codex worktree with these commands:

```powershell
Set-Location "E:\Claude Code Projects\Personal\PC-PTY-Chat-codex"
git status --short --branch
rg -n "Quick Tasks|quick tasks|quick-tasks|quick_tasks|pc_create_quick_task|pc_list_quick_tasks|taggedProjectId|quick-tasks-pm|findQuickTasksProject|adoptProjectAsQuickTasks|isQuickTasksKind|ProjectKind" apps packages tests scripts docs
pnpm --filter @pc/web typecheck
```

Expected Quick Tasks search result: docs plus historical/new migrations only.
No live app/package/test references should remain.

Before starting the next refactor slice, commit or otherwise checkpoint the
current cleanup. A sensible split is:

1. `Retire Quick Tasks surface`
2. `Add agent transcript backfill and runtime input capabilities`
3. `Update refactor recovery docs`

Keep the unrelated `Shell.tsx` and desktop changes separate unless the user
confirms they belong in the same commit.

## Next Refactor Objective

Continue Phase 4: decompose `ChatSurface`.

Current `apps/web/src/components/ChatSurface.tsx` is about 180 lines. It is
already much smaller than the original audit because these pieces have been
extracted:

- `apps/web/src/features/chat/ChatSurfaceProps.ts`
- `apps/web/src/features/chat/ChatTimeline.tsx`
- `apps/web/src/features/chat/ChatComposer.tsx`
- `apps/web/src/features/chat/TerminalPane.tsx`
- `apps/web/src/features/chat/usePendingPrompts.ts`
- `apps/web/src/features/chat/useChatRenderItems.ts`
- `apps/web/src/features/chat/useChatTimelineRenderer.tsx`
- `apps/web/src/features/chat/useThinkingIndicatorState.ts`
- `apps/web/src/features/chat/useChatSurfaceMode.ts`
- `apps/web/src/features/chat/useChatComposerActions.ts`
- `apps/web/src/features/chat/useChatInputControls.ts`
- `apps/web/src/features/chat/useChatRuntimeThinking.ts`
- `apps/web/src/features/chat/normalizeJsonlEnvelope.ts`
- `apps/web/src/features/chat/toolGrouping.ts`
- `apps/web/src/features/chat/runtimeState.ts`
- `apps/web/src/features/chat/approvals.tsx`
- `apps/web/src/features/chat/EventBubbles.tsx`
- `apps/web/src/features/chat/SystemBubbles.tsx`
- `apps/web/src/features/chat/ToolBubbles.tsx`
- `apps/web/src/features/chat/AgentWorkflowBubbles.tsx`
- `apps/web/src/features/chat/ThinkingIndicator.tsx`

Still inside `ChatSurface.tsx`:

- pending prompt coordination
- terminal pane/composer/timeline composition

## Recommended Phase 4 Slices

Do the next work as small behavior-preserving moves with typecheck after each
slice. Good next slices:

1. Leave `ChatSurface` as the thin coordinator unless a clear reuse seam appears.
2. Continue Phase 3 contract cleanup inside feature clients.

## Phase 3 Client State

`apps/web/src/api/client.ts` is already a compatibility barrel over feature
clients, and no web source imports `@/api/client` directly.

Contract cleanup started with:

- `apps/web/src/features/work-items/types.ts`

Good next slices:

1. Move `features/agents/client.ts` contracts/errors to a nearby `types.ts`.
2. Move `features/workflows/client.ts` contracts to a nearby `types.ts`.
3. Keep each client module as HTTP methods plus compatibility re-exports.

## Guardrails

- Do not redesign rendering behavior while moving code.
- Preserve public props and visual output first; improve naming only when it
  lowers risk.
- Keep `ChatSurface` responsible for orchestration, not leaf rendering.
- Do not move transport hooks or API calls into renderer modules.
- Run `pnpm --filter @pc/web typecheck` after each extraction.
- Broader verification before closing the Phase 4 slice:

```powershell
pnpm --filter @pc/web typecheck
pnpm --filter @pc/server typecheck
git diff --check
```

## Fresh Session Starter Prompt

Use this prompt after clearing context if you want the older detailed starter:

```text
We are continuing the architecture refactor in E:\Claude Code Projects\Personal\PC-PTY-Chat-codex.
Use the Codex worktree only; do not edit or switch branches in the primary checkout at E:\Claude Code Projects\Personal\PC-PTY-Chat.
Read docs/refactor-session-handoff-2026-05-28.md and docs/architecture-refactor-plan.md.
First verify the current worktree and Quick Tasks residue exactly as the handoff says.
Do not revert apps/web/src/components/Shell.tsx or apps/desktop/src/main.ts; they are unrelated existing modifications.
Then continue Phase 4 by extracting the next safe ChatSurface slice, starting with ThinkingIndicator unless the code has changed.
Run focused typechecks after the extraction and summarize what remains.
```
