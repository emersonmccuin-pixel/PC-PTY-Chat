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
| Project lifecycle | `auditing` | Codex | `PC-PTY-Chat-phase5` / `codex/phase-5-hardening` | `docs/pods/project-lifecycle.md` | Active audit after Terminal/PTY. Project create/list/update/delete, worktrees, reveal, scaffold cleanup. |
| Terminal/PTY | `complete` | Codex | `PC-PTY-Chat-phase5` / `codex/phase-5-hardening` | `docs/pods/terminal-pty.md` | Source audit and cleanup slice recorded. Browser smoke blocked by unavailable Browser backend. |
| Transient sessions | `not-started` | unassigned | none | pending | Agent designer, workflow builder, setup wizard shared adapter. |
| Agents/pods/catalog/MCP | `not-started` | unassigned | none | pending | Pod records, stock pods, MCP tools, catalog, allowlists. |
| Agent runs/transcripts | `complete` | Codex | `PC-PTY-Chat-phase5` / `codex/phase-5-hardening` | `docs/pods/agent-runs-transcripts.md` | Source audit and cleanup slices recorded. Browser smoke blocked by unavailable Browser backend. |
| Work items/stages/fields | `not-started` | unassigned | none | pending | Work item CRUD, Kanban, initiatives, stages, field schemas, attachments. |
| Workflows/builder/visualizer | `not-started` | unassigned | none | pending | Workflow rows, v2 compatibility, builder chat, graph UI, review. |
| Files/project context/settings | `not-started` | unassigned | none | pending | File browser, preview, memory, commands, settings, onboarding. |
| Desktop/dev controls | `not-started` | unassigned | none | pending | Electron shell, dev status, reload/restart controls, dogfood assumptions. |

## Parallel Safety

- One active pod per worktree.
- Chat/runtime/WebSocket is owned here until this audit is handed off or completed.
- Do not edit overlapping runtime, WebSocket, chat reducer, or ChatSurface files from another pod without coordination.
- Do not restart dev servers, Vite, channel server, dogfood app, or the desktop app.
