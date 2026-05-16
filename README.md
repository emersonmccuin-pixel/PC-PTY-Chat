# Project Companion

A local-first work-item + workflow companion where AI agents do the work — not just track it. YAML DAG workflows fire on stage transitions or via the orchestrator, run subagents inside isolated git worktrees, and pause at human-review gates before continuing.

**Status:** alpha — personal project, actively rebuilding. v2 trunk promoted from a PTY learning rig on 2026-05-16. Slice 9 (DAG workflow runtime) shipped clean. Chassis work next: sqlite persistence → React UI → multi-tenant. v1 preserved as read-only reference at a sibling path.

## What works today

- **Persistent Orchestrator chat** per project. One `claude.exe` session spawned via `node-pty` (interactive billing — no per-token costs). Survives restarts. Read / Grep / Glob on the bound repo plus the PC MCP toolset.
- **DAG workflows.** YAML files under `.project-companion/workflows/`. 7 node types: `subagent`, `bash`, `script`, `approval`, `cancel`, `workflow` (nested), `loop`. Hand-rolled validator + scheduler. Live state per run.
- **Stage-triggered + callable workflows.** Move a work item into a stage with `on_enter` wired and the workflow fires automatically. `pc_run_workflow` MCP tool fires callable workflows from chat.
- **Worktree isolation.** Each work item or callable run gets its own git worktree. A path-guard hook blocks out-of-worktree writes from subagents. `pc_create_worktree` / `pc_list_worktrees` / `pc_destroy_worktree` for manual control.
- **Approval nodes** surface in chat AND a Workflows pane simultaneously. Either side resolves the other.
- **Channel events.** External POSTs wake the orchestrator mid-idle. Powers auto-fire and async event injection.
- **MCP server** (in-process) exposing 11 tools: `pc_log`, worktree tools, work-item move/update, node completion (`pc_complete_node` / `pc_node_failed`), `pc_run_workflow`.

Six seed workflows under `workspace/.project-companion/workflows/` cover every node type as concrete examples.

## What's pending

- **Persistence.** JSON files under `data/` today. Drizzle on better-sqlite3 next.
- **UI.** Vanilla HTML/JS/CSS at `apps/web/`. React 19 + Tailwind v4 + shadcn/ui (canary) on Vite 5 next.
- **Multi-tenant / multi-project.** Single-tenant today. Project picker + per-project routing under chassis work.
- **CI.** Not yet wired. Will port the v1 GitHub Actions workflow once the sqlite migration is past typecheck-clean.
- **Slice 9 followups.** `when: false` semantics, `run.outputs` population, `done_when` enforcement, async dispatchers inside loop bodies, `$inputs.<key>` substitution, terminated-workflow ping back to orchestrator. Tracked in `BUILDOUT.md` § Followups.

## Why

Linear, Trello, and Asana track work. PC also runs it. The chat-as-control-plane plus stage-bound DAG workflows means a single drag (once the UI lands) — or one orchestrator turn today — can spin up an agent, hand it the work-item body as the spec, isolate it in a worktree, and bring back a reviewable diff. Local-first, single-user, subscription-CLI auth — no per-token billing.

## Quickstart

Prereqs: Node ≥ 20.10, pnpm ≥ 9, the `claude` CLI installed locally. Default path: `C:\Users\<user>\.local\bin\claude.exe`. Override via `CLAUDE_EXE`. Windows (ConPTY) today; Mac validation deferred.

```powershell
pnpm install
pnpm dev    # tsx watch on apps/server
```

Open <http://127.0.0.1:4040>. The orchestrator chat panel + xterm panel + Workflows pane all live there.

Data lives at `data/` at repo root today; JSON files are transient state, do not check them in. Worktrees live at `worktrees/`; they regenerate as the runtime needs them.

## Stack

pnpm workspaces · Node 20 · TypeScript · Hono · ws · node-pty · `@modelcontextprotocol/sdk` · vanilla HTML/JS/CSS (transitional) · JSON files (transitional).

**Pending chassis migration:** Vite 5 · React 19 · Tailwind v4 · shadcn/ui · Drizzle on better-sqlite3 · Vitest.

## Layout

```
apps/
  server/         Hono HTTP + ws + workflow runtime + MCP wiring
  web/            Vanilla static UI (pending React rewrite)
packages/
  domain/         Work-item / workflow / run / project types
  runtime/        PtySession, hook scripts, worktree helpers
  workflows/      YAML validator + registry
  mcp/            MCP server (pc_* tools)
channel-server/   Webhook channel server (vendored shape)
workspace/        Dev fixture (gitignored — its own embedded git)
data/             Runtime JSON state (gitignored except .gitkeep)
worktrees/        Runtime git worktrees (gitignored)
BUILDOUT.md       Slice-by-slice plan + session logs. Cold-readable.
DESIGN-WORKFLOWS-V2.md  Live workflow architecture.
```

## License

MIT. See [`LICENSE`](./LICENSE).
