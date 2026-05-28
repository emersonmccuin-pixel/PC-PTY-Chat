# Caisson — Dev vs. Dogfood Setup

Machine-specific runbook (Windows, user `emers`). Hand this to any agent working on the app.

## What the app is
Electron desktop app (`apps/desktop`) rendering a local **web UI** (`apps/web`, React) served by an **in-process Hono server** (`apps/server`). Not a browser app — a native Electron window pointed at localhost. Monorepo with `packages/*` (db, domain, mcp, etc.).

The Electron shell has **two run modes** (`apps/desktop/src/main.ts`):
- **DEV-RUN** (`PC_DESKTOP_DEV=1`): the window points at the already-running Vite dev server. Electron does *not* host the server (keeps native-module ABI undisturbed).
- **PACKAGED** (`app.isPackaged`): Electron boots the bundled Hono server *in-process* (Electron-ABI natives rebuilt at package time) and loads its static bundle on `127.0.0.1:PORT`. **This is the "dogfood" app.**

## Two completely separate environments

| | **Dev stack** | **Dogfood (packaged) app** |
|---|---|---|
| What | live-reloading dev workflow | frozen daily-driver build of the app |
| Launch | `pnpm dev` (root) | `C:\Users\emers\Run-Caisson-Dogfood.bat` |
| Server | `tsx` under a supervisor | bundled server inside `Caisson.exe` |
| Ports | server **:4040**, Vite **:5173**, channel **:8788** | **:4060** / **:8798** |
| Data dir | repo-local | `C:\Users\emers\Caisson-Dogfood-Data` ← **real projects, never touch** |
| Get new code in | automatic (HMR / restart) | **only** via a full rebuild |

- Root `pnpm dev` = `pnpm --filter @pc/server --filter @pc/mcp --parallel dev`. The server's dev script is `node scripts/dev-supervisor.mjs` (see below). Vite (`@pc/web`) is run separately.
- **Dogfood rebuild** = the `/promote-to-dogfood` skill: `pnpm --filter @pc/desktop dist:dir` → builds web+server+mcp, rebuilds native modules into `apps/desktop/staging`, packages to `apps/desktop/release/win-unpacked/Caisson.exe`, then relaunches via the `.bat`. Data is preserved (DB auto-migrates on boot).
- The dev stack and dogfood **never collide** — different ports, different data dirs. Leave one alone while touching the other.

## Dev-supervisor + in-app restart/reload (commit `ad9294d`, DEV-ONLY)
- `apps/server/scripts/dev-supervisor.mjs` spawns `tsx src/index.ts` and **respawns it when it exits with code 75**. Non-75 exits are *not* respawned (no crash-loop).
- A floating bottom-right widget (`DevControls.tsx`) with two buttons:
  - **restart** → `POST /api/dev/restart` → graceful shutdown + `exit(75)` → supervisor respawns → **backend hot-reloads** picking up BE source changes. Guarded: returns `409` if agents are active unless `force:true` (UI arms a `⚠ force?` confirm).
  - **reload** → `window.location.reload()` for the FE.
- Gated to dev only: server routes register only when `PC_ROOT` is unset (packaged Electron always sets `PC_ROOT`); the FE component is tree-shaken out of prod via `import.meta.env.DEV`. **None of this exists in the dogfood app.**
- Gotcha: the restart button only works if the dev server was launched **through the supervisor** (`pnpm dev`), not a raw `tsx` started before commit `ad9294d`. A pre-supervisor server hit with restart just dies and never respawns → FE stuck "reconnecting."

## CRITICAL RULE — do not restart anything unasked
Codified in `CLAUDE.md` and `AGENTS.md`: **never restart/kill/relaunch the dev servers, the dogfood app, or `POST /api/dev/restart` unless the user explicitly asks in that moment.** Restarts wipe active sessions + orchestrator/agent state and disrupt the user's live work. Making a code edit is *not* permission to restart to apply it — make the edit and let the user restart. Prior permission does not carry forward.

## Codex worktree rule
- Primary checkout: `E:\Claude Code Projects\Personal\PC-PTY-Chat` (may be in use by Claude/the user).
- Codex checkout: `E:\Claude Code Projects\Personal\PC-PTY-Chat-codex`.
- Codex edits, commits, verification, and merges happen in the Codex worktree.
- Do not branch-switch, reset, clean, or edit files in the primary checkout.
- Details: `docs/codex-worktree-workflow.md`.

## Quick reference
- Built dogfood exe: `apps/desktop/release/win-unpacked/Caisson.exe`
- Dogfood launcher: `C:\Users\emers\Run-Caisson-Dogfood.bat` (sets `PORT=4060`, `CHANNEL_PORT=8798`, `PC_DATA_DIR=C:\Users\emers\Caisson-Dogfood-Data`)
- Dogfood data (never touch): `C:\Users\emers\Caisson-Dogfood-Data`
- Rebuild dogfood: `/promote-to-dogfood` (or `pnpm --filter @pc/desktop dist:dir`)
- Real installer (only if asked): `pnpm --filter @pc/desktop dist:win`
