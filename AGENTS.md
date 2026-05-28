# AGENTS.md — PC-PTY-Chat (Caisson)

Guidance for Codex / coding agents working in this repo. See `CLAUDE.md` for the same rules.

## CRITICAL — never restart servers or the app unless expressly asked

The user is continuously using the live dev stack and the packaged "dogfood" app. **Restarts destroy in-flight work** (active sessions, orchestrator/agent state, unsaved context). Treat any restart as destructive and off-limits by default.

Do NOT, unless the user explicitly asks *in that moment*:
- kill or relaunch the dev servers (`pnpm dev`, server/Vite/channel)
- `Stop-Process Caisson` / kill `node` / `tsx` / `vite`
- rebuild or relaunch the dogfood app (`/promote-to-dogfood`, `electron-builder`, the launcher `.bat`)
- `POST /api/dev/restart` (the in-app dev restart endpoint)

Rules:
- Making a code change is **not** permission to restart to apply it. Make the edit; let the user restart when they choose.
- Prior permission to restart does **not** carry forward — ask again every time.
- If a change only takes effect after a restart, say so and stop. The in-app `restart`/`reload` dev buttons are the user's to press.

## Layout / ports
- Electron shell: `apps/desktop`. Web UI: `apps/web`. Server (Hono): `apps/server`. Shared: `packages/*`.
- Dev: server `:4040`, Vite `:5173`, channel `:8788`. Dogfood: `:4060` / `:8798`.

## Style
Terse. One line per idea. Bullets over paragraphs. No preamble/recap.
