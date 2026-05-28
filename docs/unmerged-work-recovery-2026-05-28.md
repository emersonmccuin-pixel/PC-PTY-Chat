# Unmerged Work Recovery - 2026-05-28

Current base: local `dev` at `e8cdf86` (`Merge recovered MCP tool pruning`).

This document is the recovery map for all known work that is not currently in
`dev`. The important point: the work is not gone. It is scattered across local
branches, old-history worktrees, and stashes. Do not delete anything listed here
until it is either ported, explicitly abandoned, or backed up elsewhere.

## Safety Snapshot

Backup tags were created for every important unmerged tip:

- `backup/2026-05-28/section-33-account-profile`
- `backup/2026-05-28/finish-runtime-relocation`
- `backup/2026-05-28/fix-path-resolver-test`
- `backup/2026-05-28/codex-mcp-tool-split-rescue`
- `backup/2026-05-28/codex-phase4-chat-surface`
- `backup/2026-05-28/codex-phase4-chat-surface-decomp`
- `backup/2026-05-28/feature-terminal-mode`
- `backup/2026-05-28/wf-c2e792b-workflows-mcp-tools`
- `backup/2026-05-28/wf-5b5b70a-nav-directive`
- `backup/2026-05-28/wf-067e716-yaml-save-refetch`
- `backup/2026-05-28/wf-b4096a6-raw-yaml-tab`
- `backup/2026-05-28/wf-6627fb8-smoke-docs-dirty-worktree-base`
- `backup/2026-05-28/stash-section36-wip`
- `backup/2026-05-28/stash-abilities-tray`

These tags are non-destructive labels. They do not merge or modify app files.

## What Is Already In Dev

Merged into `dev`:

- Phase 1 route extraction.
- Phase 2 MCP split.
- MCP tool catalog drift hardening.
- Orchestrator now uses a curated tool allowlist rather than the broad
  `mcp__pc-rig__*` wildcard.
- Pod materialization renders tool docs from the final materialized allowlist.
- Phase 3/4 web refactor recovery:
  - split web API client by feature
  - decomposed `ChatSurface` core helpers
  - extracted `ChatSurface` timeline container
- Safe MCP/tool pruning recovery:
  - removed `pc_log`, MCP worktree tools, and `NotebookEdit` from the shared
    MCP/catalog surface
  - removed `pc_log` grants/prompts from stock pods
  - tightened the orchestrator tool surface so agent-edit and knowledge tools
    live in the Agents tab / agent-designer path
  - kept Quick Tasks intentionally
- Workflow product work that old branches still show as unmerged but current
  `dev` already contains in newer split modules:
  - `pc_fire_workflow` and `pc_complete_node`
  - workflow create/update/delete/get MCP tools
  - stage and field-schema replacement MCP tools
  - Raw YAML editor tab with save/refetch behavior
  - workflow cross-tab navigation reliability fix
  - inline workflow run detail
  - `move-work-item` workflow node, `$root.output` refs, and stage-triggered
    existing-card run roots
- Runtime/account work that old branches still show as unmerged but current
  `dev` already contains:
  - Claude account/profile override setting and effective-profile route
  - remote-control readiness detection
  - orchestrator runtime health snapshots
  - session-bundle runtime file relocation

## Unmerged Groups

### Recovered Refactor Branch

Branch:

- `recovery/phase3-client-split`

Recovered onto current `dev`:

- `0cb928b Split web API client by feature`
- `a4b838a Decompose ChatSurface core helpers`
- `3d81a68 Extract ChatSurface timeline container`

Plain English:

This branch recovers the next refactor slice on top of the clean `dev` base.
It keeps the useful refactor work and avoids reviving the unrelated desktop
updates / unread-project hook that was mixed into the old branch history.

Status:

- Merged into `dev`.

Verification:

- `pnpm --filter @pc/web typecheck` passed.
- `pnpm --filter @pc/web build` passed.
- `pnpm run ci` passed.

### 1. Small Ready Fix

Branch:

- `fix/path-resolver-test`
- also on `origin/fix/path-resolver-test` and `origin/main`

Plain English:

This is a tiny test expectation correction for runtime path encoding after path
scrubbing. It is likely safe to cherry-pick onto `dev`.

Status:

- Superseded / already present in current `dev`.
- `git cherry-pick a073917` produced an empty cherry-pick.
- Verified the expected strings are already in
  `packages/runtime/test/path-resolver.test.ts`.
- `pnpm --filter @pc/runtime test` passed: 252/252 tests.

Recommended action: no port needed; keep branch only until cleanup.

### 2. Refactor Work To Continue

Branches:

- `codex/phase4-chat-surface`
- `codex/refactor-phase3-client-split`
- `codex/phase4-chat-surface-decomp`

Plain English:

This is the next refactor thread after the route/MCP split. It includes:

- splitting the web API client by feature
- decomposing `ChatSurface` core helpers
- extracting the `ChatSurface` timeline container

Status:

- Recovered onto `recovery/phase3-client-split`.
- Do not merge the old branches directly.
- Candidate branch passed full CI.

Recommended action: keep old branches only as source references until cleanup.

### 3. MCP Tool Pruning / Quick Tasks Decision

Branch:

- `codex/mcp-tool-split-rescue`

Recovered safe subset:

- `recovery/tool-pruning`

Important commit:

- `7b9ba17 Remove Quick Tasks and prune MCP surface`

Plain English:

This branch contains one real missing tool-audit piece, but it also mixes in
product deletion. It:

- removes Quick Tasks routes, seed, schema, pod references, and MCP tools
- removes `pc_log`
- removes MCP worktree tools
- trims more orchestrator access to agent edit / knowledge tools
- also carries Focus / initiative work that the user indicated should be
  abandoned or restarted fresh

Recommended action: do not merge the branch. Decide separately:

- keep Quick Tasks and only prune the orchestrator/MCP tool surface, or
- fully remove Quick Tasks as that commit did.

Status:

- Safe tool pruning was ported onto `recovery/tool-pruning` and merged into
  `dev`.
- Quick Tasks was deliberately kept.
- Focus / initiative work from the old branch was not ported.
- Removed from shared MCP/catalog surface: `pc_log`, MCP worktree tools,
  and `NotebookEdit`.
- Removed from stock pods: `pc_log` prompts/tool grants.
- Removed from orchestrator: agent edit tools and knowledge-management tools.

Verification:

- `pnpm --filter @pc/mcp typecheck` passed.
- `pnpm --filter @pc/domain test` passed.
- `pnpm --filter @pc/runtime test` passed.
- `pnpm --filter @pc/server test` passed.
- `pnpm --filter @pc/web typecheck` passed.

Remaining decision: whether Quick Tasks should be deleted as a product surface.
That should be a separate explicit change if desired.

### 4. Old-History Workflow Product Work

Branches/worktrees:

- 35 duplicate branches at `c2e792b`, all titled
  `feat(workflows): add pc_fire_workflow + pc_complete_node MCP tools`
- `wf-2BYS9WR2` and `wf-XD1X9C6H`: nav directive fix
- `wf-90BA02AH`: YAML save triggers list refetch
- `wf-2XGBCZNV`: Raw YAML tab editor
- `wf-DKSQTERZ`: D39 agent-node smoke closeout docs, plus dirty local deletes

Plain English:

This looks alarming because many branches are still unmerged, but the main
feature work has already reached current `dev` in newer split modules. Git
still calls the old branches "unmerged" because they came from unrelated/old
history and were not merged by identical commit ids.

Audited as present in current `dev`:

- `pc_fire_workflow` and `pc_complete_node` in
  `packages/mcp/src/tools/workflows.ts`.
- Workflow MCP tool tests in `packages/mcp/test/workflows-tools.test.ts`.
- Orchestrator prompt/allowlist references to `pc_fire_workflow` and
  `pc_complete_node`.
- Raw YAML tab, save refetch, and nav-directive race fix in
  `apps/web/src/components/WorkflowsList.tsx`.
- Workflow authoring tools, stage/field-schema replacement tools, and catalog
  drift coverage.
- `move-work-item`, `$root.output`, and existing-card stage-trigger roots in
  workflow runtime/domain code.

Recommended action: do not port these old workflow branches. Treat them as
source-history backups only. Cleanup can happen after the user confirms no
documentation-only entries from those branches matter.

### 5. Runtime / Desktop / Account Work

Branches:

- `finish/runtime-relocation`
- `section-33-account-profile`

Plain English:

This is a huge old-history line. The important product work has mostly already
reached current `dev` in newer/refactored form. The branch still appears
unmerged because its history is not connected cleanly to `dev`.

Audited as present in current `dev`:

- Claude account/profile override setting, UI, and effective-profile route.
- Remote-control readiness detection and tests.
- Runtime health snapshots and tests.
- Session-bundle relocation support.
- Workflow "agentic build" runtime pieces: workspace-shaping MCP tools,
  `move-work-item`, `$root.output`, and stage-triggered existing-card roots.

Recommended action: do not merge these branches wholesale. Preserve as backups
until branch cleanup. If desktop packaging docs/CI are still desired, audit
those separately as a narrow documentation/CI task.

### 6. Stashed Work

Stashes:

- `stash@{0}` / `backup/2026-05-28/stash-section36-wip`
- `stash@{1}` / `backup/2026-05-28/stash-abilities-tray`

Plain English:

`stash@{0}` is Section 36 WIP around caisson/data-driven agent identity. It
touches pod routes, orchestrator pod content, stock pod seeding, usage caps,
domain exports, and tests.

`stash@{1}` is dormant abilities-tray scaffolding. It only touches three files
and should stay parked unless that idea becomes active again.

Status:

- `stash@{0}` is superseded by current `dev`: stock identity now lives on
  `agents.origin`, Caisson is a stock pod, reset-to-default uses `origin`, and
  usage cap reset parsing already accepts epoch-seconds.
- The useful code piece from `stash@{1}` has been recovered: App Settings and
  MCP detail panel state now use the existing Zustand stores, so the
  already-present ability hooks target the real UI state.
- The remaining `stash@{1}` docs are dormant Abilities planning notes, not
  required app code.

Recommended action: keep both stashes until final cleanup, but do not port
them wholesale.

### 7. Dirty Worktrees / Loose Files

Main worktree:

- untracked `docs/app-structure-overview.html`

Workflow worktree:

- `wf-DKSQTERZ` has uncommitted deletions of old workflow demo YAML files.

Recommended action:

- leave `docs/app-structure-overview.html` alone until the user decides whether
  it is useful documentation.
- inspect the `wf-DKSQTERZ` deletes before removing that worktree.

## Recovery Order

1. Stabilize and keep current `dev` as the new base.
2. Cherry-pick the tiny path resolver test fix. Done: already present.
3. Port the Phase 3/4 refactor work onto a fresh branch from current `dev`.
   Done and merged: `recovery/phase3-client-split`.
4. Make a product decision on Quick Tasks, then port the chosen MCP/tool pruning.
   Done and merged: `recovery/tool-pruning`; Quick Tasks deletion remains a
   separate product decision.
5. Workflow product work audit: current `dev` already contains the important
   code. Do not port old workflow branches.
6. Runtime/account audit: current `dev` already contains the important runtime
   and account code. Only desktop packaging docs/CI remain worth a narrow check.
7. Only after recovery decisions are made, delete duplicate worktree branches.

## Branches Not Safe To Merge Wholesale

These are useful as source material only:

- `codex/mcp-tool-split-rescue`
- `codex/phase4-chat-surface`
- `codex/refactor-phase3-client-split`
- `codex/phase4-chat-surface-decomp`
- `finish/runtime-relocation`
- `section-33-account-profile`
- all `wf-*` workflow branches
