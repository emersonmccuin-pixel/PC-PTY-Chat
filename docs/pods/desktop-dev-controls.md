# Desktop Dev Controls Pod Audit

Status: auditing.

Owner: Codex.

Worktree: `E:\Claude Code Projects\Personal\PC-PTY-Chat-phase5`.

Branch: `codex/phase-5-hardening`.

## Ownership

Desktop shell:

- `apps/desktop/src/main.ts`: Electron main process, dev-vs-packaged mode split, packaged in-process server boot, renderer URL selection, reload accelerators, context menu, external link handling, and window lifecycle.
- `apps/desktop/src/preload.ts`: minimal `window.pcDesktop` bridge.
- `apps/desktop/esbuild.config.mjs`: bundles main/preload for Electron.
- `apps/desktop/package.json`: desktop dev/build/package scripts and electron-builder config.

Dev controls:

- `apps/server/src/features/dev-controls/routes.ts`: dev-only canary/status/restart routes.
- `apps/server/src/features/dev-controls/constants.ts`: sentinel restart exit code and dev-control gating.
- `apps/web/src/features/dev-controls/client.ts` and `types.ts`: web client contracts for `/api/dev/status` and `/api/dev/restart`.
- `apps/web/src/components/DevControls.tsx`: dev-only floating restart/reload widget.
- `apps/web/src/components/Shell.tsx`: renders `DevControls` behind `import.meta.env.DEV`.

Server and channel boot:

- `apps/server/src/index.ts`: root/data/port resolution, channel server construction/start, dev-control route registration, static fallback, HTTP listener, WebSocket registration, and graceful shutdown.
- `apps/server/scripts/dev-supervisor.mjs`: dev-only `tsx` supervisor that respawns only on exit code 75.
- `apps/server/src/services/channel-server.ts`: multiplexed channel HTTP/WS listener, registrant lifecycle, and shutdown.
- `apps/server/scripts/build.mjs`: packaged server bundle for desktop resources.

Packaging:

- `apps/desktop/scripts/stage-resources.mjs`: staged `pcserver` resource tree for packaged Electron.
- `apps/desktop/scripts/rebuild-native.mjs`: rebuilds Electron native externals.
- `apps/desktop/scripts/after-pack.cjs`: after-pack native module handling.
- `apps/desktop/scripts/gen-icon.mjs`: desktop icon generation.
- `docs/dev-dogfood-setup.md`: local runbook for dev stack vs dogfood app.
- `docs/desktop-build.md`: desktop build/package runbook.

## Public Entry Points

Dev-only HTTP:

- `GET /api/dev/canary`
- `GET /api/dev/status`
- `POST /api/dev/restart`

Desktop runtime:

- Dev-run Electron loads `PC_DESKTOP_URL` or `http://127.0.0.1:5173`.
- Packaged Electron imports `PC_ROOT/server.mjs` and loads `http://127.0.0.1:PORT`.
- Packaged server serves static web UI from `PC_ROOT/apps/web/dist`.

Channel server:

- HTTP listener on `127.0.0.1:CHANNEL_PORT`.
- `POST /channel/:slug/:source`
- `GET /health`
- WebSocket `/channel-register`.

Build commands:

- `pnpm --filter @pc/desktop dev`
- `pnpm --filter @pc/desktop dist:dir`
- `pnpm --filter @pc/desktop dist:win`
- `pnpm --filter @pc/desktop dist:mac`
- `pnpm --filter @pc/desktop dist:mac:dir`

## User Workflows

Dev stack:

1. Root `pnpm dev` starts server and MCP package dev scripts.
2. Server dev script runs `apps/server/scripts/dev-supervisor.mjs`.
3. Supervisor starts `tsx src/index.ts` and respawns only when the child exits with code 75.
4. Web Vite is separate; Electron dev-run points at Vite by default.
5. Floating `DevControls` can poll status, POST restart, and reload the page, but agents must not invoke those controls without an explicit user request in that moment.

Packaged dogfood:

1. Desktop main sets `PC_ROOT`, `PC_DATA_DIR`, `PORT`, and `CHANNEL_PORT` before importing the bundled server.
2. Server boot runs migrations/seeds, starts Hono, starts the channel server, and serves the static bundle.
3. Browser window loads the packaged server URL.
4. Dogfood ports and data dir are intentionally separate from the dev stack.

Reload affordances:

1. Electron removes the app menu.
2. Main process restores renderer reload through Ctrl+R/F5 and context-menu actions.
3. Web dev controls expose a frontend reload button only in Vite dev builds.

## Dependency Map

Imports into the pod:

- Runtime/project registry shutdown is called by server graceful shutdown.
- Agent active-run registry is read by dev restart guard.
- Project/channel runtimes register with channel server and depend on its shutdown behavior.
- Web Shell owns placement of the dev widget.

Imports out of the pod:

- Project/runtime/agent pods depend on channel server availability.
- Static fallback depends on web build output.
- Packaged server depends on staged migrations, templates, MCP bundle, web dist, channel bridge, and native externals.

Cross-pod calls that should stay explicit:

- `/api/dev/restart` is destructive and must stay a user-owned explicit action.
- Web reload is frontend-only and must not imply backend restart.
- Packaged dogfood rebuild/relaunch is outside ordinary source cleanup.
- Channel server shutdown is part of process shutdown, not a standalone agent action.

## Dead Code And Drift

- `GET /api/dev/canary` and `CANARY-1` UI text are labeled pipeline-test markers and appear safe to remove after confirming no references.
- `/api/dev/status` includes `marker: 'BE-RELOAD-TEST-1'`; web types and UI display the temporary marker.
- `DevControls` uses visible text buttons and temporary diagnostic text; this is dev-only but visually noisy.
- `docs/dev-dogfood-setup.md` still references the default Codex checkout rather than this Phase 5 worktree, but the repo-level AGENTS rule supersedes it for active work.
- No focused route test pins dev-control gating, active-agent 409 behavior, or sentinel restart scheduling.
- No package smoke was run, by design, because packaging/relaunch can affect the dogfood workflow.

## Tests And Gaps

Existing adjacent coverage:

- `apps/server` typecheck covers dev-control route and server boot typing.
- `apps/web` typecheck covers `DevControls` and dev-control client typing.
- `apps/desktop` typecheck covers Electron main/preload typing.
- `packages/runtime/test/node-launcher.test.ts` covers adjacent node launcher behavior from the terminal pod, not desktop boot.

Missing tests or trace evidence:

- No focused `dev-controls` route test.
- No test proves dev routes are disabled when `PC_ROOT` is set.
- No test proves restart returns 409 when agents are active.
- No browser smoke verified the dev widget.
- No packaged desktop smoke or dogfood launch was attempted.

## Cleanup Plan

Do not call `/api/dev/restart`, reload the frontend, restart any server/app, run packaging, or relaunch dogfood during this pod.

Small cleanup candidates:

- Remove the canary route/UI marker if no references depend on it.
- Remove the temporary backend reload marker from `/api/dev/status`, web type, and widget.
- Add focused route tests for dev-control gating and restart guard behavior if the active-agent registry can be controlled without side effects.
- Keep packaging and Electron behavior source-audited unless a failing trace appears.

Verification commands to use before any cleanup patch:

- `pnpm --filter @pc/server typecheck`
- `pnpm --filter @pc/web typecheck`
- `pnpm --filter @pc/desktop typecheck`
- `git diff --check`

## Completion Criteria

Kickoff status:

- This pod audit file exists and maps ownership, workflows, dependencies, drift, tests, and cleanup candidates.
- Runtime behavior has not been changed.
- No app, dev server, dogfood app, Vite server, channel server, packaging command, frontend reload, or restart endpoint has been touched.

Commands run so far:

- `git status --short --branch`
- `rg --files` and `rg -n` for desktop, dev controls, restart, reload, dogfood, Electron, Vite, channel server, ports, and packaging surfaces.
- `Get-Content` for dev-control routes/client/types/widget, Electron main/preload/build config, server index slices, supervisor, channel server, desktop package config, and runbook docs.
- `pnpm --filter @pc/server typecheck`
- `pnpm --filter @pc/web typecheck`
- `pnpm --filter @pc/desktop typecheck`
- `git diff --check`

Verification results:

- PASS: server typecheck.
- PASS: web typecheck.
- PASS: desktop typecheck.
- PASS: `git diff --check`.

Manual workflow checks run:

- None.

Open risks:

- Destructive controls remain source-audited only.
- Packaged dogfood behavior remains source-audited only.
- Channel server lifecycle is covered by typing and adjacent pod tests, not by an end-to-end desktop smoke here.
