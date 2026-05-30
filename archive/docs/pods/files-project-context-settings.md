# Files Project Context Settings Pod Audit

Status: complete.

Owner: Codex.

Worktree: `E:\Claude Code Projects\Personal\PC-PTY-Chat-phase5`.

Branch: `codex/phase-5-hardening`.

## Ownership

Server route modules:

- `apps/server/src/features/files/routes.ts`: filesystem browse, drive list, mkdir, folder probe, project file tree, and project file preview routes.
- `apps/server/src/features/project-context/routes.ts`: custom commands, scoped memory file read/write, `CLAUDE.md` status/write, and `project-claude-md-changed` broadcast.
- `apps/server/src/features/settings-onboarding/routes.ts`: global settings read/patch, Claude profile, preflight, installer actions, and onboarding auth routes.
- `apps/server/src/features/projects/routes.ts`: project file cleanup endpoint is adjacent to this pod but owned by project lifecycle for row lifecycle.

Server services:

- `apps/server/src/services/files-tree.ts`: project-root tree walk, hard skip dirs, root `.gitignore`, preview classification, binary sniffing, image data URI generation, and path containment.
- `apps/server/src/services/fs-browse.ts`: unrestricted or root-gated folder browser, mkdir, home expansion, parent calculation, and drive enumeration.
- `apps/server/src/services/fs-probe.ts`: create-project folder probe for existing/git/scaffold state.
- `apps/server/src/services/custom-commands.ts`: project/user `.claude/commands/*.md` discovery and shadowing.
- `apps/server/src/services/memory-files.ts`: user/project/workspace `CLAUDE.md` pathing and read/write.
- `apps/server/src/services/preflight.ts`: Claude/git/node/bash/python dependency and auth preflight.
- `apps/server/src/services/onboarding-install.ts`: explicit installer actions for Claude Code and git.
- `apps/server/src/services/onboarding-auth.ts`: long-running `claude auth login` process and login-state capture.
- `apps/server/src/services/claude-runtime-bundle.ts`: settings/profile paths used by runtime spawns.

Packages:

- `packages/domain/src/settings.ts`: global settings contract, defaults, clamps, retention normalization, and Claude config dir env resolution.
- `packages/db/src/repos/settings.ts`: singleton settings row read/write.
- `packages/runtime/src/claude-resolver.ts`: Claude binary resolution and configured override state.
- `packages/domain/src/agent-file.ts`: agent file metadata contract adjacent to context surfaces.

Web modules:

- `apps/web/src/features/files/client.ts` and `types.ts`: browse/probe/tree/preview clients and duplicated file contracts.
- `apps/web/src/features/project-context/client.ts` and `types.ts`: custom command, memory, and `CLAUDE.md` clients/contracts.
- `apps/web/src/features/settings/client.ts` and `types.ts`: settings, preflight, installer, auth, and Claude profile clients/contracts.
- `apps/web/src/components/FilesRail.tsx`: project file tree rail, hidden-file toggle, and file selection.
- `apps/web/src/components/FilesViewer.tsx`: markdown/html/image/text/binary/oversized preview surface.
- `apps/web/src/components/RichLinkPreviewCard.tsx`: hover preview for `pc://file` rich links.
- `apps/web/src/components/MemoryDrawer.tsx`: `/memory` drawer for user/project/workspace `CLAUDE.md`.
- `apps/web/src/components/AbilitiesTray.tsx`: custom command discovery and tray merge.
- `apps/web/src/components/AppSettingsModal.tsx`: app settings tabs, font preview/save, storage save, Claude profile display, usage, and specialists tab.
- `apps/web/src/components/onboarding/OnboardingWizard.tsx`: first-run preflight/install/auth/projects flow.
- `apps/web/src/components/ProjectSettingsPanel.tsx`: project metadata/settings shell and setup wizard nag.
- `apps/web/src/store/viewing-file.ts`, `memory-drawer.ts`, `app-settings-modal.ts`, `rich-link-preview.ts`: local UI state for this pod.

## Public Entry Points

HTTP:

- `GET /api/fs/browse`
- `GET /api/fs/drives`
- `POST /api/fs/mkdir`
- `POST /api/fs/probe`
- `GET /api/projects/:projectId/files/tree`
- `GET /api/projects/:projectId/files/preview`
- `GET /api/projects/:projectId/commands`
- `GET /api/projects/:projectId/memory/:scope`
- `PUT /api/projects/:projectId/memory/:scope`
- `GET /api/projects/:projectId/claude-md-status`
- `PUT /api/projects/:projectId/claude-md`
- `GET /api/settings`
- `PATCH /api/settings`
- `GET /api/settings/claude-profile`
- `GET /api/preflight`
- `POST /api/onboarding/install/claude`
- `POST /api/onboarding/install/git`
- `POST /api/onboarding/auth/login`
- `GET /api/onboarding/auth/state`
- `POST /api/onboarding/auth/cancel`

WebSocket outbound:

- `project-claude-md-changed`

Persisted data:

- SQLite `settings_global` singleton row.
- Filesystem reads/writes under project folders, `~/.claude/commands`, `~/.claude/CLAUDE.md`, project `CLAUDE.md`, workspace `CLAUDE.md`, and selected data/config dirs.

## User Workflows

Files tab:

1. `FilesRail` fetches `/files/tree` for the active project.
2. Server walks the project root, skips noisy dirs, applies root `.gitignore`, and returns a recursive tree.
3. Selecting a file stores the relative path in `useViewingFile`.
4. `FilesViewer` fetches `/files/preview?path=...`.
5. Server bounds-checks the path and classifies content as markdown, html, image, text, binary, or oversized.

Folder picker and project creation:

1. Folder pickers call `/api/fs/browse`, `/api/fs/drives`, `/api/fs/mkdir`, and `/api/fs/probe`.
2. Browse may be unrestricted or gated to a configured root.
3. Probe classifies existing folder/git/scaffold state for create-mode decisions.

Project context:

1. Abilities tray fetches `/commands` when opened.
2. Project command files shadow user-global command files by command name.
3. `/memory` drawer reads/writes user/project/workspace `CLAUDE.md`.
4. Setup wizard nag checks `claude-md-status`; MCP `pc_write_claude_md` writes through `PUT /claude-md` and triggers `project-claude-md-changed`.

Settings and onboarding:

1. App boot fetches `/api/settings` and gates onboarding if needed.
2. Settings modal patches global settings; server merges/clamps defaults and applies Claude runtime overrides.
3. Preflight checks Claude Code, auth, git, and workflow soft deps.
4. Installer actions only run on explicit onboarding clicks and rerun preflight afterward.
5. Auth login starts a detached `claude auth login`; wizard polls auth state and can cancel.

## Dependency Map

Imports into the pod:

- Project lifecycle provides active project rows, folder paths, and setup wizard launch points.
- Runtime uses settings for Claude binary/profile resolution and session file placement.
- Chat uses custom commands and memory drawer state.
- Rich-link parsing and previews consume file preview routes.
- MCP project-config tools write `CLAUDE.md` through project context routes.

Imports out of the pod:

- Project create/update workflows use folder browse/probe.
- Agent/pod spawning uses Claude profile/runtime settings and generated config files.
- JSONL retention and usage surfaces read settings but live in runtime/statusline pods.
- Project delete file cleanup is lifecycle-owned but shares filesystem containment concerns.

Cross-pod calls that should stay explicit:

- File preview is read-only; work item attachments own inline DB content.
- Memory files intentionally read/write outside the active project for user/workspace scopes.
- Settings patch may report `restartRequired`, but app/server restart stays user-owned.
- Installer/auth routes are explicit user actions and must not run automatically.

## Dead Code And Drift

- Resolved during cleanup: web `GlobalSettings` now includes server/domain fields `claudeExe`, `agentDispatch`, and `jsonl`.
- Resolved during cleanup: web `getOnboardingAuthState` now types the `auth` object returned by the server.
- File, project-context, and settings contracts are duplicated in web rather than imported from domain/server-safe packages; this keeps bundles isolated but creates drift risk.
- `files-tree.ts` only loads the project-root `.gitignore`; nested `.gitignore` files are not applied.
- HTML preview is source-audited as sandboxed iframe content, but no browser smoke was run.
- No safe deletes were proven during this initial pass.

## Tests And Gaps

Existing focused tests:

- `apps/server/test/file-routes.test.ts`: browse/mkdir/drives/probe, project tree, preview, containment, unknown project, and error envelopes.
- `apps/server/test/fs-browse.test.ts`: folder creation, traversal rejection, gate enforcement, and existing-path rejection.
- `apps/server/test/project-context-routes.test.ts`: custom commands, memory scopes, `CLAUDE.md` status/write, validation, and broadcast envelopes.
- `apps/server/test/settings-onboarding-routes.test.ts`: settings patch normalization, Claude profile, preflight, install, auth login/state/cancel envelopes.
- `apps/server/test/data-dir-contract.test.ts`: data-dir contract around settings/runtime pathing.
- `apps/server/test/path-containment.test.ts`: static/project file containment and `.claude` ownership guard.
- `packages/domain/test/settings.test.ts`: settings defaults, profile override env resolution, and orchestrator surface normalization.
- `packages/runtime/test/claude-resolver.test.ts`: Claude binary resolution order and override behavior.
- `tests/playwright/onboarding-wizard.spec.ts`: browser-level onboarding flow coverage when a dev server is available.

Missing tests or trace evidence:

- No focused web test pins settings client types against domain/server settings keys.
- No browser smoke verified Files tab tree/preview, Memory drawer save, App Settings save, folder picker, custom commands tray, or onboarding wizard in this session.
- No test covers nested `.gitignore` behavior.
- `getOnboardingAuthState` web type is aligned with the server `auth` envelope and covered by web typecheck, but no runtime contract test pins it.

## Cleanup Completed

Do not change installer/auth side effects, settings persistence semantics, memory scope pathing, project file containment, or preview rendering without a failing trace.

Completed cleanup:

- Added web `AgentDispatchSettings` and `JsonlSettings` contracts.
- Added missing web `GlobalSettings.claudeExe`, `GlobalSettings.agentDispatch`, and `GlobalSettings.jsonl` fields.
- Added web `AuthProbe` and `OnboardingAuthState` contracts.
- Updated `settingsApi.getOnboardingAuthState` to type the returned `auth` envelope.

Deferred:

- Focused web/server contract test for settings type coverage if a dependency-light pattern emerges.
- Nested `.gitignore` behavior until product intent is clear.

Verification commands used for this pod:

- `pnpm --filter @pc/server exec tsx --test test/file-routes.test.ts test/fs-browse.test.ts test/project-context-routes.test.ts test/settings-onboarding-routes.test.ts test/data-dir-contract.test.ts test/path-containment.test.ts`
- `pnpm --filter @pc/domain exec tsx --test test/settings.test.ts`
- `pnpm --filter @pc/runtime exec tsx --test test/claude-resolver.test.ts`
- `pnpm --filter @pc/server typecheck`
- `pnpm --filter @pc/web typecheck`
- `git diff --check`

## Completion Criteria

Kickoff status:

- This pod audit file exists and maps ownership, workflows, dependencies, drift, tests, and cleanup candidates.
- Runtime behavior has not been changed; cleanup was web type-contract only.
- No app, dev server, dogfood app, Vite server, channel server, or restart endpoint has been touched.

Commands run so far:

- `git status --short --branch`
- `rg --files` and `rg -n` for files, fs, preview, project context, settings, commands, memory, Claude, onboarding, preflight, install, and auth surfaces.
- `Get-Content` for file/project-context/settings routes, filesystem/context/settings services, domain settings, runtime Claude resolver, web clients/types/components, and focused tests.
- `pnpm --filter @pc/server exec tsx --test test/file-routes.test.ts test/fs-browse.test.ts test/project-context-routes.test.ts test/settings-onboarding-routes.test.ts test/data-dir-contract.test.ts test/path-containment.test.ts`
- `pnpm --filter @pc/domain exec tsx --test test/settings.test.ts`
- `pnpm --filter @pc/runtime exec tsx --test test/claude-resolver.test.ts`
- `pnpm --filter @pc/server typecheck`
- `pnpm --filter @pc/web typecheck`
- `git diff --check`

Verification results:

- PASS: server file/context/settings audit tests, 23 tests, before cleanup.
- PASS: domain settings tests, 11 tests, before cleanup.
- PASS: runtime Claude resolver tests, 9 tests, before cleanup.
- PASS: server file/context/settings audit tests, 23 tests, after cleanup.
- PASS: domain settings tests, 11 tests, after cleanup.
- PASS: runtime Claude resolver tests, 9 tests, after cleanup.
- PASS: server typecheck after cleanup.
- PASS: web typecheck after cleanup.
- PASS: `git diff --check`.

Manual workflow checks run:

- None. Browser smoke has not been attempted for this pod.

Open risks:

- Files, settings, memory, and onboarding UI behavior remains source-audited only.
- Installer/auth flows are high side-effect surfaces and remain route-test-only here.
