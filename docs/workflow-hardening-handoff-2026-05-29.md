# Session Handoff — Workflow System Hardening + Dogfood Flow Setup (2026-05-29)

## What this session was
Set up the project for a proper dogfood dev flow, then discovered the v2 workflow system is largely non-functional and began hardening it. Tracked under **EPIC: Improve Workflows** (`pc-pty-chat-82`).

## Dogfood dev-flow model we settled on (keep this)
- **This folder (`E:/Claude Code Projects/Personal/PC-PTY-Chat`) = the `dev` worktree.** It runs the dev app and is the live-test + integration checkout. Treat it as **merge-only / careful-edit-only** — never branch-switch it out from under the running server.
- **Parallel tracks each get their own worktree** (share one `.git`): CODEX is in `../PC-PTY-Chat-codex` (`codex/architecture-refactor`) and `../PC-PTY-Chat-phase5` (`codex/phase-5-hardening`). One directory = one branch; work reaches `dev` only via merge.
- **Workflow agents run in auto-worktrees** (`data/worktrees/...`) and must NOT touch the main `dev` checkout — that's the isolation requirement (see CRITICAL below).
- **Branching:** work on `dev`, push to `origin/dev` (local `dev` is ~67+ commits ahead of remote — big first push pending).
- **Project-scoped agents:** per user, projects (UI + workflows) must only see/use project-scoped pods. Enforced this session (global *user-created* pods filtered; stock globals kept for the orchestrator — non-destructive).

## How to edit workflows (no UI round-trip needed)
The orchestrator has no workflow-authoring tool, but the server exposes a validated `PUT /api/workflows/:id` that takes raw `{ yaml }` and recomputes hash/parsed-def. Use it instead of raw SQL:
```
PUT http://127.0.0.1:4040/api/workflows/<id>  body {"yaml": "...", "reason": "..."}
```
Work items: `PATCH /api/projects/:projectId/work-items/:wiId` accepts `{ parentId, version }` (needs current `version`). Used it to parent cards under the epic.

## DONE & verified this session
- **#1 isolation** — path-guard wired to activate on `PC_WORKFLOW_RUN_ID` (committed). **Inconsistent — see CRITICAL.**
- **#2 agent visibility** — workflow agents now write `agent_runs` rows → show in Running Agents rail. ✅ confirmed.
- **#3 expected_output** — added `agents.expected_output` column (migration 0030) + resolution caller→pod-row→stock→throw. ✅ migration applies on boot.
- **initialInput echo-timeout regression** — shortened the workflow `initialInput` to a single line (long/multiline broke the spawn echo-ack handshake → `echo-timeout`). ✅ committed `72c400c6`.
- **Project-scoped-agent enforcement** — committed `05f9e92b`. Migrated project-scoped `coder`/`planner`/`qa-tester` into project `01KS1358GYAQFG8BW9ERSB2J7C`.

## ⚠️ CRITICAL OPEN THREAD — isolation is INCONSISTENT (top priority next session)
Worktree isolation works *sometimes*:
- **canary-3 PASSED** — coder committed to its worktree branch only (`2f096f9d`), `dev` untouched.
- **canary-4 FAILED** — coder committed canary-4 **directly to `dev`** (commit `8f1aec18`), worktree `wf-SWE9JE3M` left empty.

And this is the puzzle: the wiring is all **present** in the committed code:
- `PC_WORKFLOW_RUN_ID` + `PC_WORKFLOW_WORKTREE` injected at `apps/server/src/services/dag-run-service.ts:299-300`
- `path-guard.cjs` activates on it (`isWorkflowAgent = !!process.env.PC_WORKFLOW_RUN_ID`, line 127) and enforces `PC_WORKFLOW_WORKTREE` as the root (line 147-148)
- `low-level-spawn.ts` passes `env` through

So the guard SHOULD fire but didn't for canary-4. Hypotheses to chase:
1. The project-scoped `coder` pod (cloned) may materialize hooks/settings differently than the global one → path-guard hook not registered for it. (canary-3 used the GLOBAL coder pre-enforcement; canary-4 used the PROJECT-SCOPED clone.)
2. Heavy parallel churn on the spawn/supervisor files (`low-level-spawn.ts`, `dev-supervisor.mjs`, `index.ts`, new `diagnostics.ts`) between runs may have altered env/hook propagation.
3. The `PreToolUse` hook may not be registered in the materialized `.claude/settings` for the worktree spawn, so `enforce()` never runs.
**Next step:** dispatch a canary, then while the coder runs, inspect its materialized `.claude/settings.json` + confirm the `PreToolUse` path-guard hook is registered AND `PC_WORKFLOW_RUN_ID` is in its process env. That tells you which of the three it is.

## Remaining backlog (children of pc-pty-chat-82, priority order)
- `pc-pty-chat-81` (#1 isolation) — REOPEN effectively; inconsistent, see above.
- `pc-pty-chat-86` (#5) — diffstat uses `HEAD~15..HEAD`; should diff run branch base.
- `pc-pty-chat-87` (#6) — worktrees never torn down (leak; see leftovers below).
- `pc-pty-chat-84` (#4/#8) — Human Review UI: nothing consumes `workflow-v2-review-pending`; review only resolvable via orchestrator chat + `pc_complete_node`.
- `pc-pty-chat-88` (#7) — push-to-dev only moves the kanban card; never pushes branch/PR.
- `pc-pty-chat-83` (#9/#10) — running-workflow card doesn't show current node; runs hook drops `dagState`.
- `pc-pty-chat-89` (#11) — duplicate `qa-tester` rows.
- `pc-pty-chat-90` (#12) — dispatch doesn't pass work-item context to agent prompt.
- `pc-pty-chat-91` (#13) — `node.timeout` = idle for agents, wall-clock for bash (footgun).
- Full audit with file:line: agent work item `01KSR95MJVEWAC3K5P6VTJ4QS6`.

## Cleanup done + leftovers
- Removed worktrees `wf-SWE9JE3M`, `wf-55X352M1` (+ branches). Cancelled canary cards `pc-pty-chat-79/92/93/94`. Removed my scratch files.
- **LEFTOVER:** `data/worktrees/pc-pty-chat/wf-DMY8HNVS/` directory resisted deletion ("directory not empty") — branch/registration gone, but the loose dir remains. `rm -rf` it manually next session.
- **dev marker pollution:** canary test markers from `8ed52f7` / `8f1aec18` were removed in the post-Phase-5 Codex cleanup branch. No live app/server restart was used.

## Parallel-work awareness
`dev` had heavy active parallel committing all session (crash diagnostics `7236e7eb`, supervisor port-wait `2a8b99e0`, chat-lag `86ff636b`, etc.) plus a `codex/phase-5-hardening` worktree. Before any runtime edits, check `git status` + recent log — don't collide with whoever's on the spawn/runtime files.

## Crash note
Several agent runs died to server crashes/restarts mid-run. The node-pty heap-corruption trigger was reportedly fixed via the short initialInput (matches `72c400c6`). If agents keep dying to `server-restart` / idle-timeout, that's still live.
