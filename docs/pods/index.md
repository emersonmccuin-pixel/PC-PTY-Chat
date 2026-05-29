# Audit Pods

Status owner: Codex.

Worktree: `E:\Claude Code Projects\Personal\PC-PTY-Chat-phase5`.

Branch: `codex/phase-5-hardening`.

Base: `dev` at `44980f1`.

## Status Key

- `not-started`: no pod-specific inventory yet.
- `mapped`: ownership and entry points have been documented.
- `auditing`: active trace and gap analysis is in progress.
- `cleanup-ready`: audit found a scoped cleanup with named verification.
- `complete`: cleanup and verification are recorded.

## Pods

| Pod | Status | Owner | Worktree/branch | Audit file | Notes |
|---|---|---|---|---|---|
| Chat/runtime/WebSocket | `complete` | Codex | `PC-PTY-Chat-phase5` / `codex/phase-5-hardening` | `docs/pods/chat-runtime-websocket.md` | Source audit and cleanup slices recorded. Browser smoke blocked by unavailable Browser backend. |
| Project lifecycle | `complete` | Codex | `PC-PTY-Chat-phase5` / `codex/phase-5-hardening` | `docs/pods/project-lifecycle.md` | Source audit and cleanup slice recorded. Browser smoke blocked by unavailable Browser backend. |
| Terminal/PTY | `complete` | Codex | `PC-PTY-Chat-phase5` / `codex/phase-5-hardening` | `docs/pods/terminal-pty.md` | Source audit and cleanup slice recorded. Browser smoke blocked by unavailable Browser backend. |
| Transient sessions | `complete` | Codex | `PC-PTY-Chat-phase5` / `codex/phase-5-hardening` | `docs/pods/transient-sessions.md` | Source audit and cleanup slice recorded. Browser smoke blocked by unavailable Browser backend. |
| Agents/pods/catalog/MCP | `complete` | Codex | `PC-PTY-Chat-phase5` / `codex/phase-5-hardening` | `docs/pods/agents-pods-catalog-mcp.md` | Source audit and cleanup slice recorded. Browser smoke not run; no frontend behavior changed. |
| Agent runs/transcripts | `complete` | Codex | `PC-PTY-Chat-phase5` / `codex/phase-5-hardening` | `docs/pods/agent-runs-transcripts.md` | Source audit and cleanup slices recorded. Browser smoke blocked by unavailable Browser backend. |
| Work items/stages/fields | `complete` | Codex | `PC-PTY-Chat-phase5` / `codex/phase-5-hardening` | `docs/pods/work-items-stages-fields.md` | Source audit and cleanup slice recorded. Browser smoke not run; status helper/type drift only. |
| Workflows/builder/visualizer | `complete` | Codex | `PC-PTY-Chat-phase5` / `codex/phase-5-hardening` | `docs/pods/workflows-builder-visualizer.md` | Source audit and cleanup slice recorded. Browser smoke not run; type-only fire response contract drift. |
| Files/project context/settings | `complete` | Codex | `PC-PTY-Chat-phase5` / `codex/phase-5-hardening` | `docs/pods/files-project-context-settings.md` | Source audit and cleanup slice recorded. Browser smoke not run; settings/auth type drift only. |
| Desktop/dev controls | `not-started` | unassigned | none | pending | Electron shell, dev status, reload/restart controls, dogfood assumptions. |

## Parallel Safety

- One active pod per worktree.
- Chat/runtime/WebSocket is owned here until this audit is handed off or completed.
- Do not edit overlapping runtime, WebSocket, chat reducer, or ChatSurface files from another pod without coordination.
- Do not restart dev servers, Vite, channel server, dogfood app, or the desktop app.
