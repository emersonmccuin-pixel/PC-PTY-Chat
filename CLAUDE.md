# PC-PTY-Chat (Caisson)

Electron desktop app rendering a local web UI over an in-process Hono server.
- **Dev stack:** server `:4040`, Vite `:5173`, channel `:8788`. Launch: `pnpm dev` (server runs under `apps/server/scripts/dev-supervisor.mjs`).
- **Dogfood (packaged) app:** `:4060` / `:8798`, data at `C:\Users\emers\Caisson-Dogfood-Data` (real projects — never touch). Rebuild via `/promote-to-dogfood`.

## CRITICAL — Codex worktree isolation

- Primary checkout: `E:\Claude Code Projects\Personal\PC-PTY-Chat`.
- Codex worktree: `E:\Claude Code Projects\Personal\PC-PTY-Chat-codex`.
- Codex edits must happen in the Codex worktree, normally on `codex/architecture-refactor`.
- Treat the primary checkout as owned by Claude/the user.
- Do not switch branches, merge, rebase, reset, clean, or edit files in the primary checkout.
- Setup/runbook: `docs/codex-worktree-workflow.md`.

## CRITICAL — never restart servers or the app unless expressly asked

The user is continuously using the live dev stack and the dogfood app. **Restarts destroy in-flight work** (active sessions, orchestrator/agent state, unsaved context). Treat any restart as destructive.

- Do NOT, unless the user explicitly asks *in that moment*: kill/relaunch the dev servers, `Stop-Process Caisson`, kill `node`/`tsx`/`vite`, run `pnpm dev`, rebuild/relaunch the dogfood app, or `POST /api/dev/restart`.
- Making a code change is **not** permission to restart to apply it. Make the edit and let the user restart when they choose.
- Prior permission to restart does **not** carry forward — ask again every time.
- If a change only takes effect after a restart, say so and stop; let the user trigger it (the in-app `restart`/`reload` dev buttons exist for exactly this).

## Style

Terse. One line per idea. Bullets over paragraphs. No preamble/recap. (Inherits workspace `../../CLAUDE.md`.)
