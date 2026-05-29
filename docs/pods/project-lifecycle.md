# Project Lifecycle Pod Audit

Status: auditing.

Owner: Codex.

Worktree: `E:\Claude Code Projects\Personal\PC-PTY-Chat-phase5`.

Branch: `codex/phase-5-hardening`.

## Ownership

Server route modules:

- `apps/server/src/features/projects/routes.ts`: project list, create, reorder, patch, soft-delete, scaffold file cleanup, detail lookup, and reveal-in-file-explorer.
- `apps/server/src/features/project-worktrees/routes.ts`: project-scoped worktree cached list, create, and destroy routes.
- `apps/server/src/features/files/routes.ts`: folder probe and gated folder picker routes used by create-project.

Server services:

- `apps/server/src/services/project-create.ts`: validated create flow, git init/adopt, scaffold commits, default stages, DB insert, runtime registry registration.
- `apps/server/src/services/project-scaffold.ts`: `.project-companion/workflows` and README scaffold writer plus token rendering.
- `apps/server/src/services/project-registry.ts`: project runtime cache, boot hydration, register/refresh/remove, slug cache.
- `apps/server/src/services/project-runtime.ts`: per-project runtime owner, worktree base directory, one-shot scaffold refresh, workflow import bootstrap, runtime shutdown on soft-delete.
- `apps/server/src/services/worktree.ts`: project-scoped worktree service, cache, DB reconciliation, scratch directory lifecycle.

Shared and DB modules:

- `packages/db/src/repos/projects.ts`: project persistence, soft-delete, metadata patch, reorder, settings defaults.
- `packages/db/src/repos/worktrees.ts`: active/destroyed worktree rows.
- `packages/runtime/src/worktree.ts`: low-level `git worktree` list/create/destroy/prune/attach primitives.
- `packages/domain/src/project.ts` and `packages/domain/src/worktree.ts`: shared project/worktree contracts.

Web modules:

- `apps/web/src/features/projects/client.ts`: project HTTP client and compatibility type re-export.
- `apps/web/src/features/projects/types.ts`: web project and create mode contracts.
- `apps/web/src/App.tsx`: project list load, active project reconciliation, create modal wiring, project updates/deletes/reorder.
- `apps/web/src/store/active-project.ts`: persisted active project slug.
- `apps/web/src/components/CreateProjectModal.tsx`: folder probe, create mode derivation, project create submit.
- `apps/web/src/components/ProjectRail.tsx`: active selection, filter, drag reorder, reveal, danger actions, new session shortcut.
- `apps/web/src/components/ProjectSettingsPanel.tsx`: project metadata edit, stages/fields link-out, danger zone, setup wizard nag.
- `apps/web/src/components/ProjectDangerModals.tsx`: typed-confirm archive and PC-file deletion flows.
- `apps/web/src/components/Shell.tsx`: active project fanout into project settings, files, chat, agents, workflows, and work items.

Templates and persisted files:

- `templates/.project-companion/workflows/*.yaml`: project scaffold and refresh seed workflows.
- `templates/.project-companion/setup-wizard-prompt.md`: setup wizard prompt refreshed into projects.
- `templates/README.template.md`: new-project README scaffold.
- `<dataDir>/worktrees/<projectSlug>/<name>`: project-scoped git worktree location.
- `<projectFolder>/.project-companion/*`: durable PC project scaffold.

## User Workflows

Create project:

1. App loads projects and settings.
2. CreateProjectModal opens only with a configured Projects folder for the folder picker.
3. FolderBrowserModal and files probe classify the selected folder as empty, in-place, existing git repo, or invalid.
4. Web sends `{ name, folder_path, mode }` to `POST /api/projects`.
5. Server creates/adopts the git repo, writes scaffold files, commits the scaffold, inserts the project row, and registers the runtime.
6. App appends the returned project and sets the active slug.

List and select project:

1. App calls `GET /api/projects`.
2. `useActiveProject` restores the last active slug from local storage.
3. App reconciles a missing active slug to the first live project.
4. Shell fans the active project into the WebSocket, center views, rails, and activity panel.

Edit project metadata:

1. ProjectSettingsPanel trims the display name and git remote.
2. Web sends `PATCH /api/projects/:projectId`.
3. Server updates name/git remote only; slug and folder path remain locked.
4. Registry refreshes the cached runtime and web replaces the row in local state.

Archive and delete PC files:

1. ProjectRail or ProjectSettings opens typed-confirm danger modals.
2. Archive calls `DELETE /api/projects/:projectId`, flips `deletedAt`, removes runtime from registry, and removes the row from active UI state.
3. PC-file deletion calls `DELETE /api/projects/:projectId/files`, removes `.project-companion`, and removes `.claude` only if `.claude/.pc-managed` exists.
4. Project source files, `.git`, README, and `.mcp.json` are intentionally untouched.

Reveal project folder:

1. ProjectRail context menu calls `POST /api/projects/:projectId/reveal`.
2. Server validates that the project exists, including soft-deleted rows, and that the folder exists on disk.
3. Server launches the platform opener through an injectable reveal function in tests.

Worktrees:

1. ProjectRuntime lazily constructs `WorktreeService` with project folder as git cwd and data-dir worktree base.
2. Worktree routes expose cached list/create/destroy.
3. Workflow DAG execution uses `ensureWorktree` for `wf-*` worktrees and scratch cleanup helpers.
4. Current web source has no feature client or visible UI for `/worktrees` routes.

## Dependency Map

Imports into the pod:

- Project routes import DB project repos and injected registry/create/reveal collaborators.
- Project create imports DB project creation, id generation, git via `execFile`, and scaffold writer.
- Worktree service imports runtime git primitives and DB worktree tracking.
- Web project views import project client, file probe client, runtime start-new-session client, and settings/project-context clients for adjacent workflows.

Imports out of the pod:

- App and Shell pass active project into chat, files, work items, workflows, agents, settings, and activity panel.
- ProjectRuntime supplies project-scoped services to workflow, work item, transient session, and agent-run pods.
- MCP tools rely on project id context, but this pod does not own MCP tool behavior.

Cross-pod calls that should stay explicit:

- Files/project context/settings owns filesystem browsing and setup wizard details; project lifecycle consumes folder probe only for create classification.
- Work items/stages/fields owns stages and field schema editors shown inside ProjectSettingsPanel.
- Workflows owns DAG worktree usage; project lifecycle owns generic worktree service and path policy.
- Desktop/dev controls owns restart/reload; project lifecycle must not invoke restart.

Duplicate adapters or protocol translations:

- Project contracts exist in both `packages/domain` and `apps/web/src/features/projects/types.ts`.
- Worktree registry shape is duplicated in `features/project-worktrees/routes.ts` and `services/worktree.ts`.
- Danger actions are reachable from both ProjectRail and ProjectSettingsPanel but share modal components.
- Create-project mode derivation is local to `CreateProjectModal.tsx` while server validates the same mode enum separately.
- Route-level create error classification uses message regexes around `ProjectCreate` errors.

## Dead Code And Drift

- `ProjectScaffold` no longer writes `.claude/*` or `.mcp.json`; those template files are still live for session-local runtime bundling, not project scaffold.
- `GET/POST /api/projects/:projectId/worktrees*` routes are present but have no web client usage in the current source.
- Slug migration on rename is intentionally deferred; project name can change while slug/worktree base remains stable.
- Project create route tests mock `ProjectCreate`; the real git/scaffold create flow has no focused test in `apps/server/test`.
- No safe deletes were proven during this initial pass.

## Tests And Gaps

Existing focused tests:

- `apps/server/test/project-routes.test.ts`: create route validation/delegation, list/patch/detail/soft-delete, file cleanup, reveal delegation.
- `apps/server/test/worktree-routes.test.ts`: worktree cached list/create/destroy route envelopes and service errors.
- `apps/server/test/worktree-scratch.test.ts`: scratch dir ensure/wipe/sweep behavior.
- `apps/server/test/project-runtime-move-v2.test.ts`: project runtime stage move behavior.
- `apps/server/test/project-runtime-session-resume.test.ts`: project runtime session resume behavior.
- `packages/db/test/work-items.test.ts` and related DB tests indirectly cover project creation as a dependency.

Missing tests or trace evidence:

- No focused test covers `ProjectCreate` default stages, slug uniqueness, scaffold write mode, or git commit staging behavior.
- No focused test covers `ProjectScaffold.buildTokens`, README rendering, or workflow seed copy behavior.
- No focused web helper test covers create mode derivation from folder probe results.
- No browser smoke verifies create modal, rail reorder, reveal, archive, or PC-file deletion flows.
- No route test covers project reorder validation and canonical order after partial/stale ids.

## Cleanup Plan

Do not change project filesystem or git behavior without a failing trace.

Small cleanup candidates:

- Extract create-project mode derivation from `CreateProjectModal.tsx` into a pure web helper with focused tests.
- Add focused `ProjectScaffold` tests for token rendering, README skip behavior, and workflow seed copy.
- Add a project reorder route/repo test for stale ids and live-row ordering.
- Decide later whether worktree registry contracts should be shared between route/service; defer unless active code starts using the worktree route from web.

Verification commands to use before any cleanup patch:

- `pnpm --filter @pc/server exec tsx --test test/project-routes.test.ts test/worktree-routes.test.ts test/worktree-scratch.test.ts`
- `pnpm --filter @pc/server typecheck`
- `pnpm --filter @pc/web typecheck`
- `git diff --check`

## Completion Criteria

Kickoff status:

- This pod audit file exists and maps ownership, workflows, dependencies, drift, tests, and cleanup candidates.
- No runtime behavior has been changed.
- No app, dev server, dogfood app, Vite server, channel server, or restart endpoint has been touched.

Commands run so far:

- `rg -n` for project lifecycle, project CRUD, worktree, scaffold, reveal, and create-project surfaces.
- `Get-Content` for project routes, worktree routes, project create/scaffold/registry/worktree services, web project client/types, App, CreateProjectModal, ProjectRail, ProjectSettingsPanel, ProjectDangerModals, and existing tests.
- `pnpm --filter @pc/server exec tsx --test test/project-routes.test.ts test/worktree-routes.test.ts test/worktree-scratch.test.ts`
- `git diff --check`

Verification results:

- Focused project lifecycle tests: 15 passed, 0 failed.
- Diff whitespace check: passed.

Manual workflow checks run:

- None.

Open risks:

- Project create and worktree filesystem behavior remain source-audited only.
- Browser-level project lifecycle workflows are unverified in this session.
