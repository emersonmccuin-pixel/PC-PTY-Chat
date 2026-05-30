---
name: promote-to-dogfood
description: Rebuild the packaged Caisson dogfood app from the current repo and relaunch it, so the user's daily-driver app picks up the latest changes. Use when the user types `/promote-to-dogfood` or says "promote to dogfood", "update the dogfood app", "rebuild the dogfood", "ship to dogfood", "push my changes to the dogfood app", or "get these changes into the dogfood". This is the deliberate "ship to myself" step in the dev → dogfood loop (see memory project-dev-vs-dogfood-setup).
---

# promote-to-dogfood

Rebuilds the packaged Caisson app from the current source and relaunches the dogfood instance on its own ports/data. The dogfood app runs a frozen bundle, so this is the ONLY way new code reaches it. The dev stack (`pnpm dev` + Vite on 4040/5173/8788) is never touched.

## Fixed facts (this machine)

- **Repo:** `E:\Claude Code Projects\Personal\PC-PTY-Chat`
- **Built app:** `apps/desktop/release/win-unpacked/Caisson.exe`
- **Launcher:** `C:\Users\emers\Run-Caisson-Dogfood.bat` (sets `PORT=4060`, `CHANNEL_PORT=8798`, `PC_DATA_DIR=C:\Users\emers\Caisson-Dogfood-Data`)
- **Dogfood data:** `C:\Users\emers\Caisson-Dogfood-Data` — **never touch it**; it holds the user's real projects/chats and is preserved across rebuilds (the relaunched app auto-migrates the DB on boot).
- **Dogfood ports:** 4060 / 8798. **Dev ports:** 4040 / 5173 / 8788 — leave dev alone.

## Procedure

1. **Show what's being promoted.** Run `git log --oneline -3` and `git status --short` from the repo. State in one line what the dogfood will contain. The build uses the **working tree**, so any uncommitted changes are included — if the tree is dirty, say so and let the user commit first if they want a clean-main build; otherwise proceed. Don't gate further — this skill is "just do it."

2. **Stop the running dogfood app** (frees ports + unlocks the exe so the build can overwrite it):
   ```
   powershell -NoProfile -Command "Get-Process Caisson -ErrorAction SilentlyContinue | Stop-Process -Force"
   ```
   `Caisson.exe` is ONLY the dogfood app — safe. **Never** kill `node.exe` (dev stack) or `claude.exe` (live sessions).

3. **Rebuild** from the repo root (long step, several minutes — run in background and poll its output):
   ```
   pnpm --filter @pc/desktop dist:dir
   ```
   The native `better-sqlite3` rebuild is sandboxed to `apps/desktop/staging`, so it does NOT disturb the dev stack's Node-ABI build — dev can keep running throughout. If the build fails on a locked `Caisson.exe`, step 2 didn't fully kill it; retry the kill.

4. **Relaunch detached** (survives this session). First make sure NO `Caisson` process is alive (Electron's single-instance lock will leave the new server unbound on 4060 if a stale instance lingers — step 2 should have handled this, but re-confirm `Get-Process Caisson` returns 0 before launching):
   ```
   powershell -NoProfile -Command "Start-Process -FilePath 'C:\Users\emers\Run-Caisson-Dogfood.bat'"
   ```
   Use `Start-Process` (not a foreground `cmd /c` or a tracked background task — those get killed when the command/turn ends; `Start-Process` truly detaches).

5. **Verify.** Poll until the dogfood server answers on its own port:
   ```
   curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4060/api/projects
   ```
   Expect `200` within ~30s. Confirm dev is still independent (`curl … http://127.0.0.1:4040/api/projects` → 200). If 4060 never comes up, tell the user to double-click `Run-Caisson-Dogfood.bat` themselves (a manual double-click always launches it cleanly).

6. **Report**: which commit/changes were promoted, that the rebuild succeeded, that the dogfood is back up on 4060 with its data intact, and that dev was untouched.

## Notes

- If the user changed **MCP tools** or **pod prompts/allowlists**, remind them those reach the dogfood orchestrator only after this rebuild AND a `+ New session` in the app (and MCP tool changes also need `pnpm --filter @pc/mcp build`, which `dist:dir` runs as part of the server build).
- To produce a real installer instead of the run-from-folder build, use `pnpm --filter @pc/desktop dist:win` (NSIS `Caisson Setup.exe`) — only if the user asks.
