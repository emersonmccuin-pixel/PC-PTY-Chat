# PC-PTY-Chat

Standalone PTY-driven chat for `claude.exe`. Learning rig for Project Companion v2 Phase 9-B.

Single web chat → backend spawns `claude.exe` via `node-pty` → all Claude usage bills as interactive subscription.

## Why this exists

Three prior attempts to fold a PTY transport into the PC app broke things. This rig proves the path in isolation, then we port lessons back into `packages/runtime/`.

## Build plan + tracker

See [`BUILDOUT.md`](./BUILDOUT.md) for the full slice-by-slice plan and current progress. Cold-readable after `/clear`.

## Prereqs

- Node ≥ 20.10
- `claude.exe` installed locally. Default path: `C:\Users\<user>\.local\bin\claude.exe`. Override via `CLAUDE_EXE` env var.
- Windows (ConPTY). Mac validation deferred.

## Run

```powershell
pnpm install   # or npm install
pnpm dev       # tsx watch src/server.ts
```

Open <http://127.0.0.1:4040>.

## Layout

```
src/
  server.ts         Hono HTTP + ws upgrade. Owns one PtySession.
  pty-session.ts    node-pty wrapper. ANSI strip. Stop-marker watcher.
  public/
    index.html      Minimal chat page.
    app.js          WS client + DOM.
workspace/
  .claude/
    settings.json   Permissions preset + Stop hook config.
    hooks/stop.cjs  Writes timestamp to data/stop-markers.txt.
data/
  stop-markers.txt  Stop hook output. Watched by server for turn-end.
  transcript.log    Raw PTY output, for debugging.
```

## What's in / out

- IN: single session, plain chat, Stop-hook turn detection, ANSI-stripped stream.
- OUT: Channels MCP, multi-session, subagents, auto-fire pipelines. Those land in PC after this proves.
