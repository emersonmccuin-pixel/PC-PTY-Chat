# PC-PTY-Chat Buildout Plan

Learning rig for Project Companion Phase 9. Goal: validate the full PC vision (orchestrator + subagents + worktrees + channels + workflows) inside this sandbox before porting to PC proper.

**Current session:** Session P closed 2026-05-17 — server-side multi-tenancy shipped + user test passed. P1–P15 all ticked (schema migration, templates dir, agent-library bootstrap, ProjectRuntime/Registry, multiplexed channel server, scoped worktrees, per-project scaffold renderer, full create endpoint w/ git init + commits, fs/probe + fs/browse, list/get/PATCH, soft-delete + danger-zone files, agent library + per-project agents, WS broadcast envelope, typecheck gate). Two defects caught during user test + fixed in `d25ecd0`: (1) Windows backslashes in path tokens broke `.mcp.json` JSON parse — normalize `PC_TRUNK_PATH` / `PROJECT_FOLDER` / `PROJECT_DATA_DIR` to forward slashes; (2) two direct `ws.send` paths on WS connect (state snapshot + events.jsonl replay) bypassed the broadcast envelope tag — patched inline. **Next: Session Q — UI vendor + multi-tenant shell** (14 milestones, vendors v1's React app over the new server). Read `MULTI-TENANCY-DESIGN.md` § "Per-project filesystem layout" + Session Q checklist below + the Session P log entry at the bottom. Slice 9 Followups (when:false, run.outputs, done_when, async loop bodies, $inputs.x, terminated-workflow ping, bundled channel-events rendering) still open — bundled-channel-events lands naturally in Session Q's chat panel reshape.

**Rig lives at:** `E:/Projects/Caisson/`. All paths in this doc are relative to that root.

**Cold-read order after `/clear`:** `MULTI-TENANCY-DESIGN.md` (still the source of truth for the multi-tenant contract; Session Q vendors the UI on top of it) → this doc (intro + `**Current session:**` line + the "Chassis — Multi-tenancy" section's Session Q checklist + Session P log entry at the bottom). For workflow-runtime work: `DESIGN-WORKFLOWS-V2.md` is still the active design (node catalog + execution model + Decisions/Deferred). `DESIGN-WORKFLOWS-AND-CONTRACTS.md` and `PLANNING-CONTRACTS-MODELS.md` are superseded; skip on cold reads.

## How to use this doc

- The doc is the source of truth. Read it cold after `/clear`.
- Tick checkboxes as work lands. Each tick goes in the same commit as the work.
- Stop at every `> **User test.**` marker. Surface the test steps, wait for the user, don't tick the test box on their behalf.
- Don't roll into the next session without an explicit go-ahead.
- Add findings to **Session log** at the bottom as sessions close.

## Why this rig exists

Three prior in-tree PTY integration attempts broke PC. Validate the full stack here in isolation, debrief, then port the lessons. PC's existing broken `packages/runtime/` artifacts are out of scope — Phase 9-B will land fresh from this rig's shape.

## Architecture parity

This rig is built to be **mechanically migratable** to PC, not rewritten at port time. Hard rules:

1. **Match PC's module boundaries.** runtime (PTY/hooks/channels) / mcp / domain / server / web stay separated. No mixed concerns.
2. **Match PC's interfaces.** PtySession class shape, event types, MCP tool names (`pc_*`) all named what PC will use.
3. **Match PC's deps.** Hono, ws, node-pty, `@modelcontextprotocol/sdk` for MCP. When DB lands, Drizzle on better-sqlite3 (PC's locked stack).
4. **Each slice declares its port destination.** Each spec below has a `Ports to:` line naming the destination PC file. Migration = copy + import-path rewrite, not re-derivation.

### Rig → PC mapping

| Rig | Ports to in PC |
|---|---|
| `packages/runtime/src/pty-session.ts` | `packages/runtime/src/pty-session.ts` |
| `packages/runtime/src/channel-server.ts` | `packages/runtime/src/channel-server.ts` |
| `packages/runtime/src/permission-preset.ts` | `packages/runtime/src/permission-preset.ts` |
| `packages/runtime/src/hook-scripts/*.cjs` | `packages/runtime/src/hook-scripts/*.cjs` |
| `packages/mcp/src/server.ts` | `packages/mcp/src/server.ts` |
| `packages/domain/src/workflow.ts` | `packages/domain/src/workflow.ts` |
| `apps/server/src/index.ts` | `apps/server/src/index.ts` |
| `apps/web/` (vanilla HTML/JS/CSS) | `apps/web/` (React + shadcn — only forced rewrite) |

### Tolerated rig-only deviations

- **UI is vanilla HTML/JS/CSS, not React.** Rewrite at port time. Cheap because the UI is small.
- **Cards/workflow state in JSON files, not sqlite.** PC will use Drizzle on better-sqlite3 per the locked stack. Rewrite at port time is mechanical (read JSON → INSERT rows).

Anything else that drifts from PC's architecture gets flagged here as it happens.

## Foundation (already shipped)

Done before this plan was written. Don't re-do.

- [x] PtySession spawning `claude.exe --dangerously-skip-permissions` via node-pty
- [x] Hooks wired: UserPromptSubmit, PreToolUse, PostToolUse, Stop
- [x] xterm.js panel (raw PTY stream) + chat panel (hook-driven bubbles)
- [x] Markdown rendering (gfm, tables wrapped scrollable, white borders)
- [x] AskUserQuestion intercept: PreToolUse hook → POSTs to /api/ask → chat picker → answer returned via deny-reason
- [x] EnterPlanMode + ExitPlanMode auto-deny (no plan mode in PC, ever)
- [x] TodoWrite + Task* (TaskCreate/TaskUpdate) → todos snapshot bubble; state in `data/tasks.json`, reset per PtySession
- [x] Stop hook payload → assistant bubble (uses `last_assistant_message` directly; transcript JSONL parse is fallback)
- [x] events.jsonl persists across PtySession respawns; replays to new browser connects

## Slice 0 — Reorganize rig to packages/ layout (pre-Session-A)

Goal: align rig file layout with PC's locked architecture before adding more code, so every slice from here on lands in the right place.

**Ports to:** N/A — this slice creates the layout that all future slices port from.

- [ ] Add `pnpm-workspace.yaml` listing `packages/*` and `apps/*`
- [ ] Create `packages/runtime/` with own `package.json` (name: `@pc/runtime`, deps: `node-pty`)
- [ ] Move `src/pty-session.ts` → `packages/runtime/src/pty-session.ts`
- [ ] Create `packages/runtime/src/hook-scripts/` and move `workspace/.claude/hooks/event-capture.cjs` + `ask-intercept.cjs` into it
- [ ] Update `workspace/.claude/settings.json` to point at the new hook paths
- [ ] Create `apps/server/` with own `package.json` (name: `@pc/server`, deps: `hono`, `@hono/node-server`, `ws`, `@pc/runtime`)
- [ ] Move `src/server.ts` → `apps/server/src/index.ts`. Update its import of pty-session to `@pc/runtime`
- [ ] Create `apps/web/` (no package.json — pure static assets)
- [ ] Move `src/public/*` → `apps/web/`
- [ ] Update `apps/server/src/index.ts` static file serving to read from `apps/web/`
- [ ] Root `package.json` drops to workspace-only (no app deps); rig-level scripts (`dev`, `typecheck`) delegate to `pnpm -r`
- [ ] Per-package `tsconfig.json`; root `tsconfig.json` becomes a project-references config
- [ ] Run `pnpm install` clean (pnpm not npm from this point on, per PC's locked stack)

> **User test.** `pnpm dev` boots; http://127.0.0.1:4040 opens; send "hello"; chat panel + xterm panel + Stop hook + assistant bubble all still work exactly as before. Pure refactor, zero behavior change.

- [x] User test passed

**Not in scope here:** changing PtySession's API, splitting ansi-strip/stop-watcher into their own files (defer until they're big enough to warrant), adding any new features.

## Session A — Subagent foundation

**Slice 1.** Subagent invocation visible in chat.

Goal: confirm a built-in CC subagent fires through the existing hook stream, and that the chat panel can render the delegate-and-return pattern cleanly.

**Ports to:**
- `packages/runtime/src/hook-scripts/event-capture.cjs` (Task-aware additions)
- `apps/web/` (chat rendering — vanilla in rig, React in PC)
- Per-project skeleton ships `workspace/.claude/agents/researcher.md` shape as the example agent file PC generates per project

- [x] Write `workspace/.claude/agents/researcher.md` — frontmatter `name`, `description`, `tools: Read, Glob, Grep`, `model: inherit`; body = short system prompt ("You're a read-only researcher; gather info, summarize, return.")
- [x] event-capture.cjs PreToolUse: if `tool_name === 'Task'`, append `{ kind: 'task-start', subagent: tool_input.subagent_type, description: tool_input.description, prompt: tool_input.prompt }` instead of (or in addition to) the generic tool-start
- [x] event-capture.cjs PostToolUse: if `tool_name === 'Task'`, append `{ kind: 'task-end', subagent: tool_input.subagent_type, result: tool_response }` (truncated)
- [x] Add `Task` to SUPPRESSED set in app.js tool-start (we render task-start bubble instead)
- [x] app.js renderEvent: handle `task-start` → indented "delegated to <subagent>" bubble with description
- [x] app.js renderEvent: handle `task-end` → "<subagent> returned" bubble with the result text
- [x] styles.css: `.bubble.task-delegate` styling (distinct from assistant — maybe a left border + agent name pill)

> **User test.** Reload. Send "Use the researcher subagent to find all .ts files under src and summarize what each does." Confirm chat shows: user prompt → delegation bubble naming `researcher` → (researcher works silently) → return bubble with researcher's summary → orchestrator's wrap-up bubble.

- [x] User test passed

**Not in scope here:** worktree binding, path containment, multiple subagents, sidechain transcript streaming. Those land in later slices.

## Session B — MCP foundation + Channels

**Slice 2.** Stand up a minimal MCP server the rig owns.

Goal: prove we can register a custom MCP tool that the orchestrator calls. Foundation for everything PC-specific.

**Ports to:**
- `packages/mcp/src/server.ts` (rig server becomes PC's MCP server — same name, same registration pattern)
- `workspace/.mcp.json` shape ships per-project from PC's runtime preset generator

- [x] New dir `mcp-server/` with own `package.json` + `server.js` (modelcontextprotocol/sdk) — landed at `packages/mcp/` instead, to match PC layout (Slice 0 already moved us into packages-shape)
- [x] One tool: `pc_log({ message: string })` — appends `{ts, message}` to `data/mcp-log.jsonl`
- [x] Add `workspace/.mcp.json` registering the server (stdio transport)
- [x] Add a UI status pill: "MCP: <tool count>" so we can see registration succeeded
- [ ] (optional) Tail mcp-log.jsonl into the chat as `kind: 'mcp-log'` events for visibility — skipped; orchestrator's tool-line is enough confirmation

> **User test.** Send "call pc_log with the message 'hello mcp'". Confirm `data/mcp-log.jsonl` contains one line with the message. Confirm chat shows the call as a tool-line or mcp-log bubble.

- [x] User test passed

**Slice 3.** Channels MCP (async event injection).

Goal: prove an external POST can wake the orchestrator mid-idle and trigger work. This is PC's auto-fire pipeline mechanism.

**Ports to:**
- `packages/runtime/src/channel-server.ts` (rig's channel-server vendor → PC's channel-server, one-to-one)
- `packages/runtime/src/pty-session.ts` (spawn-arg additions for `--dangerously-load-development-channels` + auto-confirm prompt handling)
- `apps/server/src/index.ts` ("send channel event" endpoint for the UI button)

- [x] Vendor `PC-Validation/shared/channel-server/server.js` into `channel-server/` at the rig root — added as a workspace package (`@pc/channel-server`) so pnpm install picks up its `@modelcontextprotocol/sdk` dep alongside the others
- [x] Update pty-session.ts spawn args: add `--dangerously-load-development-channels server:webhook`
- [x] Handle the dev-channels confirmation prompt that fires once at boot (the validated pattern from drive-t11.js — auto-press Enter)
- [x] Add a UI button "Send channel event" → opens a small text input → POSTs to `127.0.0.1:8788` — implemented as a header button + `window.prompt()` → POST `/api/channel-send` proxy (server adds the required `X-Sender: test` header)
- [x] Configure orchestrator (via `workspace/CLAUDE.md` instruction) to react to incoming channel messages by calling `pc_log` with the body

> **User test.** With orchestrator idle, click "Send channel event", type "ping", submit. Within 5–15s, orchestrator should wake, call pc_log("ping"), and reply in chat. Validates: idle wake, async injection, MCP round-trip.

- [x] User test passed

## Session C — Worktrees + subagent binding

**Slice 4.** Worktree primitive.

Goal: PC can create/destroy git worktrees as isolated workspaces.

**Ports to:**
- `packages/mcp/src/server.ts` (new tools: `pc_create_worktree`, `pc_list_worktrees`, `pc_destroy_worktree`)
- `apps/server/src/services/worktree.ts` (worktree state — JSON in rig, eventually a Drizzle table in PC)

- [x] `git init` in `workspace/` (first slice that needs a real repo) — initial commit `91ffd77` covers the baseline `.claude/`, `.gitignore`, `.mcp.json`, `CLAUDE.md`
- [x] MCP tool `pc_create_worktree({ branchName })` — runs `git worktree add ../worktrees/<name> -b <name>`, returns path — `name` field, not `branchName`, in the tool schema
- [x] MCP tool `pc_list_worktrees()` — `git worktree list --porcelain`, parsed
- [x] MCP tool `pc_destroy_worktree({ path })` — `git worktree remove` — tool field is `target`; accepts bare name or absolute path; `force: true` supported
- [x] UI: simple "Worktrees" sidebar panel listing current worktrees — left sidebar, 220px, polls `/api/worktrees` every 3s
- [x] Track active worktree assignments in `data/worktrees.json` — both the MCP tool process and the rig server refresh the file after every mutation; UI reads it via the cached GET

> **User test.** Click "Create worktree foo" (or have orchestrator do it). Confirm `git worktree list` shows it on disk, UI panel updates. Destroy it, confirm gone.

- [x] User test passed

**Slice 5.** Subagent with worktree binding + path containment.

Goal: a subagent can be scoped to a worktree, and the hook layer enforces the boundary.

**Ports to:**
- `packages/runtime/src/hook-scripts/path-guard.cjs` (new hook script, shipped per project by PC)
- `packages/runtime/src/permission-preset.ts` (adds path-guard hook registration to generated `.claude/settings.json`)
- `apps/server/src/services/task-binding.ts` (sidecar `current-task-binding.json` writer; eventually in-memory state in PC)

- [x] Add `worktreePath` placeholder convention in subagent system prompt body (`{{worktreePath}}`) — `researcher.md` body references it; actual substitution happens in the orchestrator's Task prompt via `[worktree: <path>]` token (single source of truth — the agent file's `{{worktreePath}}` is informational)
- [x] When orchestrator Tasks a subagent and specifies a worktree, the prompt template gets rendered with the path — done by the orchestrator per `workspace/CLAUDE.md` instructions; no host-side renderer needed
- [x] Sidecar `data/current-task-binding.json` written by a `Task` PreToolUse hook — records `tool_use_id → worktreePath`
- [x] New `PreToolUse` hook (matcher: `Read|Write|Edit|Bash|Glob|Grep|NotebookEdit`) — reads the current binding; if the call's path argument is outside the bound worktree, deny with reason "Out-of-worktree write blocked" — hook fires for both PC's `tool_name === Agent` and SDK-name `Task` (per Session A finding 1)
- [x] For Bash: simple substring check on the command for paths outside the worktree (acknowledged as best-effort; not a true sandbox)

> **User test.** Tell orchestrator: "Delegate to the researcher subagent bound to worktree foo, ask it to write a file to `<worktree>/hello.txt` AND try to write a file to `<project root>/escape.txt`". Confirm: hello.txt created in worktree; escape.txt write attempt blocked with the hook reason in chat.

- [x] User test passed

## Session D — Workflows + cards

**Slice 6.** End-to-end workflow loop.

Goal: a card moving between workflow nodes triggers a subagent. The full PC differentiator in miniature.

**Ports to:**
- `packages/domain/src/workflow.ts` + `packages/domain/src/card.ts` (types — directly reusable)
- `packages/mcp/src/server.ts` (new tools: `pc_move_card`, `pc_update_card`)
- `apps/server/src/services/workflow-runtime.ts` (on_enter dispatcher — JSON-backed in rig, sqlite-backed in PC)
- `apps/web/` (Cards panel — vanilla in rig, React in PC)

- [x] Card model: `data/cards.json` — `{ id, title, currentNode, fields, history }` — seeded by `WorkflowRuntime` constructor in apps/server (one card `card-1` at node `draft`)
- [x] Workflow model: `data/workflow.json` — list of nodes; each node has optional `on_enter: { subagent, prompt, worktree?: 'auto'|'none' }` — seeded with `draft` → `review-step` (researcher, worktree: auto) → `done`
- [x] MCP tool `pc_move_card({ id, toNode })` — thin HTTP shim that POSTs to apps/server's `/api/cards/move`; dispatch logic lives once in `WorkflowRuntime` to avoid duplicating between MCP and server processes
- [x] MCP tool `pc_update_card({ id, fields })` — HTTP shim to `/api/cards/update`
- [x] When `on_enter` fires: render prompt template, ensure worktree `card-<id>` (reuse if it already exists), POST a plain-text `Workflow event:` instruction to the channel — channel POST errors are caught and written into the card's history as a note so the UI shows them
- [x] Orchestrator reads the channel event, calls Task with the named subagent bound to the worktree, calls `pc_update_card` with the output — driven by an addition to `workspace/CLAUDE.md` ("Workflow channel events" section)
- [x] UI: a "Cards" panel below the worktrees list in the sidebar — title, current node pill, last result, last history meta line, polls /api/cards every 3s
- [x] UI button: per-card "→ <node>" buttons for every non-current node (covers "Move card 1 to review-step" plus the path back to `draft` / forward to `done`)

> **User test.** Define one card "Card 1" at node "draft". Workflow has node "review-step" with `on_enter: { subagent: researcher, prompt: 'Review code in {{worktreePath}}', worktree: 'auto' }`. Click "Move Card 1 to review-step". Within 10s, observe: worktree created → channel event posted → orchestrator wakes → delegates to researcher in the worktree → researcher writes back → card updated with the output → UI reflects.

- [x] User test passed — full loop closed on 2026-05-16 after fixing two bugs found in flight: (a) channel-server X-Sender allowlist required `test`, our POST sent `workflow-runtime` → 403; (b) orphan branch from first failed attempt left `card-1` undeletable, recovered by `git worktree prune` + retry without `-b`. Caveat: the researcher returned an inline summary instead of *writing* `findings.md` — the channel-prompt's "write a file" instruction got skipped. That's the gap the **completion contracts** followup addresses.

**Not in scope here:** workflow editor UI, multiple workflows, conditional edges, retry/timeout handling. Keep the model dirt-simple for the rig.

## Slice 6.5 — Completion contracts on current workflow shape

Goal: close the honor-system gap from Slice 6. Subagent must produce real output (files + fields) before the runtime accepts the workflow as done. Stays on the existing single-node "workflow lives on `on_enter`" shape — the full workflow definition format lands in Slice 8.

Spec: `DESIGN-WORKFLOWS-AND-CONTRACTS.md` (Slice 6.5 entry under "Implementation order").

**Ports to:**
- `packages/domain/src/workflow.ts` (extend `OnEnter` with `done_when`)
- `packages/domain/src/workflow-run.ts` (new — `WorkflowRun` type)
- `packages/domain/src/card.ts` (add `status` field)
- `apps/server/src/services/workflow-runtime.ts` (run tracking, predicate checks, safety net)
- `apps/server/src/index.ts` (new `/api/workflow/complete` endpoint; turn-end → safety net wiring)
- `packages/mcp/src/server.ts` (new `pc_complete_workflow` tool)
- `workspace/.claude/agents/researcher.md` (instruction to call `pc_complete_workflow` before returning + MCP allowlist entry)
- `workspace/CLAUDE.md` (workflow channel events — drop `pc_update_card`, pass `workflowRunId` to subagent)
- `data/workflow.json` seed (review-step gets a `done_when`)
- `apps/web/` (card status pill)

- [x] Domain: add `DoneWhen` interface + optional `done_when` on `OnEnter` (interim — moves to workflow root in Slice 8)
- [x] Domain: add `WorkflowRun` type + `status` field on `Card` (`pending | in-progress | blocked | complete | failed`, default `pending`)
- [x] Runtime: persist `WorkflowRun[]` to `data/workflow-runs.json`
- [x] Runtime: `dispatchOnEnter` creates a run, sets card `status: in-progress`, embeds `[workflowRunId: <id>]` in the channel body
- [x] Runtime: `completeWorkflow(runId, output)` — validate `files-non-empty` (worktree-relative globs, `>0` bytes) + `output-fields-non-empty` (nullish / trimmed empty / `[]` / `{}` rejected; `0` and `false` pass). On pass: shallow-merge `output` into `card.fields`, run `complete`, card back to `pending`. On fail: return `{ ok: false, missing: [...] }`.
- [x] Runtime: safety net — on turn-end, any in-progress run with `awaitingTurnEnd` flag set is marked `failed`, card `status: blocked` with reason "Subagent returned without completing the workflow."
- [x] apps/server: `POST /api/workflow/complete` → `WorkflowRuntime.completeWorkflow`; `session.on('turn-end', () => workflow.onTurnEnd())`
- [x] MCP: `pc_complete_workflow({ workflowRunId, output })` — HTTP shim to apps/server
- [x] workspace/CLAUDE.md: workflow channel events section pivots from `pc_update_card` to "delegate with the workflowRunId; subagent closes the loop"
- [x] researcher.md: tools allowlist adds `mcp__pc-rig__pc_complete_workflow`; system prompt: extract `[workflowRunId: ...]` from the prompt; before returning, call `pc_complete_workflow` with output `{ summary, ... }`
- [x] data/workflow.json (and DEFAULT_WORKFLOW): review-step `done_when: { files-non-empty: ["findings.md"], output-fields-non-empty: ["summary"] }`
- [x] apps/web: status pill on card item (in-progress = amber, blocked = red, complete/pending = neutral). Card-result line falls back to `fields.summary` if `fields.lastResult` is absent.

> **User test.** Reset `data/cards.json` and `data/workflow-runs.json` (or stop and delete them so seeds re-fire). `pnpm dev`. With orchestrator booted, click "→ review-step" on Card 1. Within ~15s: chat shows delegation → researcher writes `findings.md` in the worktree → researcher's `pc_complete_workflow` call lands → card status pill flips to "pending", summary populates, card-meta shows the completion. Then negative test: in `workspace/.claude/agents/researcher.md`, temporarily comment out the "call pc_complete_workflow" instruction; restart session; move card back to `draft` and then to `review-step` again. Within ~30s, card pill flips to "blocked" with reason "Subagent returned without completing the workflow." Restore researcher.md.

- [x] User test passed

**Not in scope here:** workflow definition format from the design doc (Slice 8), chaining (Slice 9), `pc_step_complete` progress reporting (Slice 8), retry count UI / rejection-loop give-up (Slice 8), card status state machine beyond the in-progress/blocked/pending arc (Slice 8).

## Slice 8a — Vocabulary rename to PC parity

Goal: align rig types, files, endpoints, MCP tools, and web layer with Project Companion's vocabulary. Pure parity — no behavior changes, no new features. Existing Slice 6.5 behavior continues to work under the new names. Sets the foundation for Slice 8b's workflow runtime to land on PC-shaped types.

Spec: this section. PC types we're matching live in `E:/Claude Code Projects/Personal/Project Companion/packages/domain/src/{work-item,project,workflow}.ts`.

**Renames:**

| Old (rig) | New (PC parity) |
|---|---|
| `Card`, `card-1`, `card.currentNode` | `WorkItem`, `wi-1`, `workItem.stageId` |
| `Workflow { nodes[] }` (kanban container) | `Project { stages[] }` |
| `WorkflowNode` (kanban column) | `Stage { id, name, order }` |
| `WorkflowRun.cardId`, `nodeId` | `workItemId`, `stageId` |
| `data/cards.json` | `data/work-items.json` |
| `data/workflow.json` | `data/project.json` |
| `worktrees/card-1/` | `worktrees/wi-1/` |
| `/api/cards*`, `/api/workflow` | `/api/work-items*`, `/api/project` |
| `pc_move_card`, `pc_update_card` | `pc_move_work_item`, `pc_update_work_item` |
| `.card-*` DOM classes | `.wi-*` (mirrors existing `.wt-*` worktree prefix) |

`Stage` keeps an inline `on_enter` block (with `subagent`, `prompt`, `worktree`, `done_when`) for 8a so the existing behavior carries forward unchanged. Slice 8b strips `on_enter` off `Stage` and replaces it with standalone workflow YAMLs triggered by `stage_id`.

**Ports to:**
- `packages/domain/src/work-item.ts` (renamed from card.ts)
- `packages/domain/src/project.ts` (new — replaces the kanban container half of workflow.ts)
- `packages/domain/src/workflow.ts` (kanban container removed; still holds `DoneWhen` + `OnEnter` for 8a; gets rewritten in 8b)
- `packages/domain/src/workflow-run.ts` (cardId → workItemId, nodeId → stageId)
- `packages/domain/src/index.ts` (re-exports updated)
- `apps/server/src/services/workflow-runtime.ts` (class method renames, seed shape, internal refs)
- `apps/server/src/index.ts` (endpoint paths)
- `packages/mcp/src/server.ts` (tool names + descriptions)
- `apps/web/{app.js, index.html, styles.css}` (DOM ids, classes, variables)
- `workspace/CLAUDE.md` (channel events: card→work item, node→stage)

- [ ] Domain: rename `Card` → `WorkItem` (with `stageId`, history entry type, status type) — file becomes `work-item.ts`
- [ ] Domain: introduce `Project { id, name, stages: Stage[] }` + `Stage { id, name, order, on_enter? }` in `project.ts`; keep `OnEnter` + `DoneWhen` exports in workflow.ts
- [ ] Domain: `WorkflowRun` field renames (`cardId` → `workItemId`, `nodeId` → `stageId`)
- [ ] Domain: update `index.ts` re-exports
- [ ] Runtime: rename methods + types in workflow-runtime.ts; rename `DEFAULT_WORKFLOW` → `DEFAULT_PROJECT`, `DEFAULT_CARDS` → `DEFAULT_WORK_ITEMS`; update seed shapes (project with stages, one WI at draft)
- [ ] Runtime: worktree naming `card-<id>` → `wi-<id>` throughout (`cardId` → `workItemId` in ensureWorktree + channel body)
- [ ] HTTP: endpoint rename (`/api/cards*` → `/api/work-items*`, `/api/workflow` → `/api/project`)
- [ ] MCP: tool rename (`pc_move_card` → `pc_move_work_item`, `pc_update_card` → `pc_update_work_item`) + tool description updates
- [ ] Web: DOM rename (`card-*` classes → `work-item-*`, `card.currentNode` → `workItem.stageId`, `cachedWorkflow.nodes` → `cachedProject.stages`, `pollCards` → `pollWorkItems`, etc.)
- [ ] Workspace: CLAUDE.md updates (channel events: replace "card"/"node" language)
- [ ] Reset: stop the server; delete `data/cards.json`, `data/workflow.json`, `data/workflow-runs.json`, `data/current-task-binding.json`; `git worktree remove` + `git branch -D` existing `card-*` worktrees; restart `pnpm dev` so seeds re-fire under the new names

> **User test.** Same flow as Slice 6.5 but on the renamed shape. With the orchestrator booted, click "→ review" on Work Item 1. Within ~15s: chat shows delegation → researcher writes `findings.md` in `worktrees/wi-1/` → `pc_complete_workflow` lands → status pill flips to pending, `fields.summary` populates, history shows the completion. Then the same negative test as Slice 6.5: comment out the "call pc_complete_workflow" line in `researcher.md`, restart, move WI back to draft then to review, ~30s, status flips to blocked. Restore researcher.md.

- [x] User test passed

**Not in scope here:** the new YAML workflow definition format, stage_id-based trigger model, `pc_step_complete`, input/output mappings on workflow. Those are Slice 8b. 8a is mechanical rename only.

## Slice 8b — New workflow definition format + execution

Goal: replace stage-bound `on_enter` configuration with standalone YAML workflows that trigger on `stage_id`. Implements the workflow definition format per the design doc with the 2026-05-16 decision shifts (stage_id trigger only, 1 workflow per stage, inputs/outputs on workflow, hand-rolled validator, `subagent:` as rig extension).

Spec: `DESIGN-WORKFLOWS-AND-CONTRACTS.md` "Workflow definition format" + "Predicate types" + "MCP tools" sections, read with the Decisions update applied.

**Ports to:**
- `packages/domain/src/workflow.ts` (full rewrite: `Workflow { name, subagent, triggers, inputs, outputs, nodes, done_when, chain_to }`, `WorkflowNode { id, instruction }`)
- `packages/domain/src/project.ts` (drop `on_enter` from `Stage`; Stage becomes pure `{ id, name, order }`)
- `packages/domain/src/workflow-run.ts` (add `workflowName`, `workflowYamlSnapshot`, `currentStepId`)
- `packages/workflows/` (new package — YAML loader + hand-rolled validator + registry; mirrors PC's package boundary)
- `apps/server/src/services/workflow-runtime.ts` (dispatch via stage_id → workflow lookup; render workflow into Task prompt with steps; output mapping per workflow's `outputs:`)
- `packages/mcp/src/server.ts` (new `pc_step_complete` tool)
- `workspace/.project-companion/workflows/review-research.yaml` (replaces the seed's stage-bound on_enter)
- `workspace/CLAUDE.md` (updated channel events: subagent calls pc_step_complete between steps, pc_complete_workflow at end)
- `workspace/.claude/agents/researcher.md` (allowlist adds pc_step_complete; system prompt adds "call pc_step_complete after each step")

- [x] Domain: rewrite Workflow type; introduce `WorkflowNode` (step) type
- [x] Domain: drop `on_enter` from `Stage`; Stage = `{ id, name, order }`
- [x] Domain: extend WorkflowRun with workflowId, workflowYamlSnapshot, currentStepId — `workflowId` not `workflowName` (BUILDOUT's original wording was loose; codebase convention is `id` on every other domain type)
- [x] New package: `packages/workflows/` with YAML loader (`js-yaml`), hand-rolled validator, registry — `WorkflowRegistry.findByStageEnter` distinguishes `none` (silent move) from `invalid` (reject) by extracting `partialStageId` from invalid YAMLs
- [x] Runtime: dispatch — `moveWorkItem` looks up destination stage_id, branches on registry match (`none` → silent move, `one` → fire, `many` → reject `ambiguous trigger`, `invalid` → reject `no valid workflow`)
- [x] Runtime: render workflow into Task prompt — steps list + rendered inputs from `inputs:` mapping + `{{worktreePath}}` + worktree/workflowRunId tokens
- [x] Runtime: `WorkflowRun` snapshots the workflow YAML at dispatch (`workflowYamlSnapshot`)
- [x] Runtime: `completeWorkflow` parses the YAML snapshot for `done_when` + `outputs:` mapping (dotted paths into the work item; falls back to shallow-merge when no `outputs:` declared)
- [x] MCP: new `pc_step_complete` tool — HTTP shim to apps/server, idempotent on stepId
- [x] apps/server: `POST /api/workflow/step-complete` endpoint (broadcasts `workflow-step` UI event); new `GET /api/workflows` endpoint; move endpoint returns 409 for `ambiguous trigger` / `no valid workflow`
- [x] Seed: project.json with 3 stages (draft, review, done) — no `on_enter`; work-items.json with 1 WI at draft; workspace/.project-companion/workflows/review-research.yaml seeds the only workflow
- [x] Workspace docs: CLAUDE.md (workflow channel events rewritten — orchestrator never calls pc_step_complete or pc_complete_workflow) + researcher.md (allowlist adds pc_step_complete; system prompt walks through step-complete + complete sequence)
- [x] Reset: data files wiped, wi-1 worktree + branch destroyed, dev server restarted clean

> **User test.** (1) **Positive:** with orchestrator booted, move Work Item 1 → review. Within ~15s: delegation → researcher writes `findings.md` → `pc_step_complete` fires per step (visible as step events) → `pc_complete_workflow` lands → status pill flips to pending, `summary` field populated per outputs mapping. (2) **Negative — invalid workflow:** in `review-research.yaml`, delete the `subagent:` line. Reload the workflows pane; YAML should be marked invalid. Move WI back to draft, then to review → move rejects with "no valid workflow for stage_id review". (3) **Ambiguity:** temporarily duplicate `review-research.yaml` to `review-research-2.yaml` (keep same `stage_id` trigger). Move WI → review → reject with "ambiguous trigger for stage_id review: 2 workflows match". Delete the duplicate, restore the original.

- [x] User test passed

**Not in scope here:** chaining (Slice 9), `pc_run_workflow` orchestrator-triggered invocation (Slice 9), workflow editing UI / workflow list UI (Slice 10), DAG node types beyond the simple step (deferred until a real workflow demands).

## Slice 9 — DAG workflow rework

Goal: rip out 8b's "one subagent runs a checklist" model and replace with a DAG-of-nodes runtime modelled on Archon's workflow engine. Seven node types — subagent, bash, script, approval, cancel, workflow (nested), loop — all land in this slice per the user's call. Each node is its own job; the runtime drives node-by-node. The orchestrator (long-lived CC instance) can fire any number of Tasks in one turn, which is the seam that makes the graph model work despite CC v2.1.140's nested-Task block on subagents.

Spec: `DESIGN-WORKFLOWS-V2.md` (top-to-bottom; supersedes `DESIGN-WORKFLOWS-AND-CONTRACTS.md`). Required reading before touching code.

**Ports to:**
- `packages/domain/src/workflow.ts` (full rewrite — `Workflow` + `DagNode` discriminated union, 7 variants)
- `packages/domain/src/workflow-run.ts` (states expand to include `paused` + `cancelled`)
- `packages/workflows/src/validator.ts` (full rewrite — hand-rolled, all 7 node types)
- `packages/workflows/src/registry.ts` (structurally unchanged; loads the new shape)
- `apps/server/src/services/workflow-runtime.ts` (full rewrite — DAG scheduler + per-node dispatch table)
- `apps/server/src/services/output-substitution.ts` (new — `$node.output` resolver + `when`/`until` expression evaluator)
- `apps/server/src/index.ts` (new endpoints: `/api/workflow/run`, `/api/approval/respond`, `/api/workflow/node-complete`, `/api/workflow/node-failed`)
- `packages/mcp/src/server.ts` (retire `pc_complete_workflow` + `pc_step_complete`; add `pc_complete_node` + `pc_node_failed` + `pc_run_workflow`)
- `workspace/.project-companion/workflows/review-research.yaml` (rewritten as 2-node DAG; add 2-3 example workflows exercising the other node types)
- `workspace/CLAUDE.md` (per-node channel events; approval surfacing)
- `workspace/.claude/agents/researcher.md` (drop step-complete references; switch to per-node completion; Bash-heredoc + Edit pattern for file creation)
- `apps/web/{app.js, index.html, styles.css}` (approval surface in chat + Workflows pane)

**Build order — 17 milestones.** Each is one logical commit's worth of work. Rig boots between milestones; from M2 onward, stage moves don't fire workflows until M7's subagent dispatch lands, then more node types come online incrementally.

- [x] 1. Open this BUILDOUT entry + update `**Current session:**` line + cold-read pointer to `DESIGN-WORKFLOWS-V2.md`
- [x] 2. Strip 8b workflow model — runtime, types, MCP tools, YAML. Worktrees / channels / work items / stages stay. Rig boots; stage moves do nothing until M7.
- [x] 3. Domain types: `Workflow` + `DagNode` union (7 variants) + `WorkflowRun` (states: pending / in-progress / paused / complete / failed / cancelled) + `NodeOutput`
- [x] 4. Validator: hand-rolled, all 7 node types, granular `{path, message}` errors
- [x] 5. Runtime scheduler skeleton: ready-set finder (`depends_on` + `trigger_rule` + `when`) + dispatch table stub per node type
- [x] 6. Output substitution: `$<node-id>.output[.field]` in prompts / bash / scripts / `when` / `until`; small hand-rolled expression evaluator (equality, comparison, boolean, dotted access)
- [x] 7. Subagent dispatch: channel event → orchestrator Tasks → `pc_complete_node` / `pc_node_failed` MCP tools + endpoints
- [x] 8. Bash dispatch: direct `execFile`, capture `{stdout, stderr, exitCode}`, honor `timeout`, run in worktree cwd if bound
- [x] 9. Script dispatch: node + python runtimes via runtime exec
- [x] 10. Approval dispatch: `paused` run state + chat surface + Workflows-pane card + `POST /api/approval/respond`; resume on response
- [x] 11. Cancel dispatch: terminate run with reason; downstream nodes don't fire
- [x] 12. Workflow-as-node dispatch: child run + cycle detection + depth cap (10) + output flow-through
- [x] 13. Loop dispatch: body sub-graph + `until` evaluator after each iteration + `max_iterations`
- [x] 14. Trigger paths: stage_id (work-item move), `pc_run_workflow` (orchestrator), parent workflow node — all converge on one run record. Same four-case rule for stage_id and name lookups (none / one / many / invalid).
- [x] 15. Seed workflows: rewrite `review-research.yaml` as 2-node DAG (explore → write-findings); add 2-3 example workflows exercising bash / approval / workflow-as-node / loop
- [x] 16. Workspace docs: `CLAUDE.md` per-node channel events; `researcher.md` per-node completion + Bash-heredoc + Edit pattern (Session H point 7)
- [x] 17. Reset data, restart dev server, surface user test plan

> **User test.** Multi-part — workflows are pre-seeded under `workspace/.project-companion/workflows/`. (1) **review-research** (DAG, stage-move): drag WI 1 → review; explore subagent fires first via Task, write-findings fires after, both visible in chat. (2) **approval-demo** (approval, callable): tell the orchestrator "run approval-demo via pc_run_workflow"; approval surfaces in chat AND Workflows pane; click approve OR reject — the bash report node fires either way and echoes your response. (3) **parent-flow / child-flow** (nested workflow, callable): tell the orchestrator "run parent-flow"; parent's bash → nested child run → parent's final bash. The `captured nested.output: {}` line in chat is expected — `run.outputs` computation is a Slice 9-followup. (4) **bash-loop** (loop, callable): tell the orchestrator "run bash-loop"; body bash fires once, `until: exitCode == 0` evaluates true, run completes. (Originally specced as critique→rewrite, redesigned bash-only because M13 doesn't support async dispatchers inside loop bodies — see Session L log.) (5) **cancel-on-flag** (cancel via when, callable): tell the orchestrator "run cancel-on-flag"; check bash emits "reject" → abort cancel fires → downstream bash never runs; run status = `cancelled`.

- [x] User test passed

**Not in scope here:** per-node retry, pre/post hooks, per-node sandbox, parallel-subagent cap, human-notification UI consolidation, workflow editor UI (Slice 10+). All flagged in `DESIGN-WORKFLOWS-V2.md` "Deferred" section.

## Chassis — React + Tailwind + shadcn UI rewrite

**Goal.** Replace vanilla HTML/JS/CSS in `apps/web/` with Vite + React 19 + Tailwind v4 + shadcn (canary). API surface stays unchanged; this is the locked-stack UI port called out in trunk `CLAUDE.md`.

**Ports to:** N/A — this IS the PC port for the UI layer.

**Stack additions:** vite 5, react 19, react-dom 19, tailwindcss v4 (`@tailwindcss/vite` plugin), shadcn canary, lucide-react (shadcn pulls it).

**Dev shape:** Vite on `5173` proxying `/api/*` + `/ws` → `127.0.0.1:4040`. Prod: Hono on `4040` serves `apps/web/dist/` with SPA index fallback.

### Session N — scaffold + first panel (2026-05-16)

Scope: stand up the React stack + port ONE panel end-to-end to prove the pattern. Remaining panels (chat, xterm terminal, worktrees, workflows, approvals) port in a follow-up session against the proven scaffold.

- [x] N1. `apps/web` becomes a Vite + React 19 package: `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src/App.tsx`
- [x] N2. Tailwind v4 wired (`@tailwindcss/vite`, `src/index.css` with `@import 'tailwindcss'`)
- [x] N3. shadcn canary init; add Button, Card, Badge
- [x] N4. Vite `server.proxy`: `/api/*` → `:4040`, `/ws` → `ws://127.0.0.1:4040`
- [x] N5. `WorkItemsList` panel: GET `/api/work-items` + `/api/project`, group by stage, create + stage-move actions hitting existing endpoints
- [x] N6. `apps/server/src/index.ts`: drop hardcoded `/`, `/app.js`, `/styles.css`; serve `apps/web/dist/` with SPA fallback; add root `pnpm build`
- [x] N7. `pnpm -r typecheck` green across all packages + apps/web + apps/server

> **User test.** Two runs.
> 1. **Dev mode.** `pnpm dev` (server on 4040) + `pnpm --filter @pc/web dev` (Vite on 5173). Open `http://127.0.0.1:5173/`. WorkItemsList renders, can create a new work item, can move it between stages. Network tab shows requests on `:5173` proxied to `:4040`.
> 2. **Prod mode.** `pnpm --filter @pc/web build` then `pnpm dev`. Open `http://127.0.0.1:4040/`. Same panel renders, same actions work, dist/ assets served from Hono.

- [x] User test passed (2026-05-16, both modes verified via playwright + visual)

**Out of scope for Session N:** chat panel, xterm terminal panel, worktrees panel, workflows panel, approvals panel, WS client, channel-event UI. The old vanilla `app.js` / `styles.css` were moved to `apps/web/legacy/` for reference; not served.

**Pivot during planning for next session:** xterm terminal panel is OUT entirely (dev-only, not a product feature). User confirmed multi-project + git-backed + folder-linked is CORE to the app, not deferred to a "chassis #3" later. That cascades through the next sessions' shape — see Session N log entry below.

## Chassis — Multi-tenancy

**Goal.** Server runs N projects in parallel without crosstalk; UI is a multi-project shell with full per-project workspace (chat, kanban, workflows, channel events, settings). Replaces the singleton rig fixture with the real PC contract.

**Spec.** `MULTI-TENANCY-DESIGN.md` is the source of truth — read top to bottom before touching server scaffolding or the project shell. 7 design questions locked in Session O (2026-05-16, planning-only).

**Headline locked decisions:** projects folder defaults `~/Projects/`; existing-folder-with-files asks once and inits in place by default with two commits (`Initial import` then `Add Project Companion scaffold`); single multiplexed channel server, path-routed by project slug; trunk-level worktrees at `<data_dir>/worktrees/<slug>/<name>/`; agents are a global library pool (`~/.project-companion/agents/`) with per-project copies that diverge on edit; first commit is always scaffold + README; rig project gets wiped on first multi-tenant boot.

**Supersedes:** the old "Session E — Multi-tenancy (optional) / Slice 7" placeholder (per-port-per-project + bundled workspace/data/.claude). Removed below.

### Session P — Server-side multi-tenancy

Scope: replace the singleton runtime with per-project runtimes, multiplex channels, scaffold the create-project flow, wire the agent library, drop the rig. No UI — Session Q vendors the shell. User test is curl / httpie + WS tail.

**Ports to:**
- `packages/db/src/schema/projects.ts` (add `folder_path`, `git_remote`, `created_at`, `deleted_at`)
- `apps/server/src/services/project-runtime.ts` (new — per-project PtySession + WorkflowRuntime + WorktreeService bundle)
- `apps/server/src/services/project-registry.ts` (new — `Map<ULID, ProjectRuntime>`, lifecycle)
- `apps/server/src/services/channel-server.ts` (rewrite — multiplexed, path-routed)
- `apps/server/src/services/worktree.ts` (scoped: `<data_dir>/worktrees/<slug>/<name>/`)
- `apps/server/src/services/workflow-runtime.ts` (per-project; registry watches `<folder>/.project-companion/workflows/`)
- `apps/server/src/services/agent-library.ts` (new — read `~/.project-companion/agents/`, write per-project copies)
- `apps/server/src/services/fs-probe.ts` (new — folder existence / git-state probe)
- `apps/server/src/services/fs-browse.ts` (new — folder listing for picker)
- `apps/server/src/services/project-create.ts` (new — git init + scaffold writes + first commit(s))
- `apps/server/src/index.ts` (drop singletons; wire registry; add `/api/projects`, `/api/fs/*`, `/api/agents` endpoints)
- `packages/mcp/src/server.ts` (per-project routing via `X-PC-Project` header from per-project `.mcp.json`)
- `templates/.claude/{agents,hooks}/`, `templates/.project-companion/{workflows,CLAUDE.md}`, `templates/.mcp.template.json`, `templates/README.template.md` (new — checked in)

**Build order — 15 milestones.** Each is one logical commit's worth of work. Server boots between milestones; from P4 onward the singleton rig path is gone — first multi-tenant boot opens with zero projects.

- [x] P1. Schema migration: `projects` gets `folder_path`, `git_remote` (nullable), `created_at` (epoch ms per v1 #15), `deleted_at` (nullable, soft-delete per v1 #16). Drizzle migration file.
- [x] P2. `templates/` dir at trunk root: canonical agents, hooks, seed workflows, `CLAUDE.md`, `.mcp.template.json`, `README.template.md`. Check in. (Trunk-level template source — distinct from per-project copies users edit.)
- [x] P3. Agent library bootstrap: on server start, if `~/.project-companion/agents/` is empty / missing, copy from `templates/.claude/agents/`. `AgentLibrary.list()` reads the dir; `AgentLibrary.write(name, body)` writes a new file. No DB row — files-on-disk are the registry (same shape as workflows).
- [x] P4. `ProjectRuntime` + `ProjectRegistry` abstractions. Drop singleton `WorkflowRuntime` / `PtySession`. Bootstrap rewrite removes the hardcoded `rig` seed. PtySession cwd = `project.folder_path`. `--mcp-config` points at `<folder>/.mcp.json`.
- [x] P5. Channel server rewrite: one server on `:8788`, path-routed `POST /channel/<slug>/<source>`. WS broadcast envelope adds `projectId`. `pc_log` MCP tool reads projectId from the request context (per-project MCP config injects `X-PC-Project` header).
- [x] P6. `WorktreeService` scoped per-project. Path key: `<data_dir>/worktrees/<slug>/<name>/`. Run-triggered worktrees: `<data_dir>/worktrees/<slug>/run-<short>/`. Slug cache: `projectId → slug` lookup at registry boot; refresh on rename.
- [x] P7. Per-project `.mcp.json` generated at create time from `templates/.mcp.template.json` with project id + PC's MCP URL substituted. Same pattern for `.claude/settings.json` from `templates/.claude/settings.template.json`.
- [x] P8. `POST /api/projects` endpoint: `{ name, folder_path, mode: 'init-empty' | 'init-in-place' }`. `init-empty` → git init + write scaffold + one commit (`Initial commit`). `init-in-place` → git init + commit existing files (`Initial import`) + write scaffold + commit (`Add Project Companion scaffold`). Returns the created project row. Slug derived from name, uniqued.
- [x] P9. `POST /api/fs/probe` endpoint: `{ path }` → `{ exists, isDirectory, hasFiles, fileCount, isGitRepo }`. Drives the create-project UI's folder-state preview.
- [x] P10. `GET /api/fs/browse?path=...` endpoint: dir listing for the folder picker. Defaults to `~/`; allows anywhere under the user's home; explicit allow-path config for outside-home paths.
- [x] P11. Project list / get / update endpoints: `GET /api/projects` (excludes soft-deleted by default; `?include_deleted=1` opt-in), `GET /api/projects/:id`, `PATCH /api/projects/:id` (rename + git remote — slug stays locked per design's "deferred" section).
- [x] P12. Project soft-delete: `DELETE /api/projects/:id` flips `deleted_at`; filesystem untouched. Separate `DELETE /api/projects/:id/files` (danger-zone) removes `.project-companion/` + `.claude/` only — user's own files stay.
- [x] P13. Agent library endpoints: `GET /api/agents` (library list), `POST /api/agents` (write new library agent), `GET /api/projects/:id/agents` (per-project copies), `POST /api/projects/:id/agents` (add-from-library — copy a library agent into `<folder>/.claude/agents/`), `PATCH /api/projects/:id/agents/:name` (edit project copy — library untouched).
- [x] P14. WS broadcast envelope: every event (chat, channel, work-item mutation, status) carries `projectId`. Server already broadcasts most of these; just tag them.
- [x] P15. `pnpm -r typecheck` green across all 5 packages + `@pc/web`.

> **Session break.** Get to clean state (tree clean, P1-P15 ticked, work committed) before crossing into the user test. The test is the gate for Session Q.

> **User test.** No UI yet. Run via httpie / curl + a WS tail script.
> 1. Boot fresh DB. `GET /api/projects` returns `[]`.
> 2. Create project A at a fresh empty folder (`POST /api/projects` mode `init-empty`). Expect: git repo initialized, `.claude/`, `.project-companion/`, `README.md` written, one commit titled `Initial commit`. `GET /api/projects` lists it.
> 3. Create project B at an existing folder with files (mode `init-in-place`). Expect: two commits — `Initial import` then `Add Project Companion scaffold`. Pre-existing files survive.
> 4. Confirm worktrees, agent copies, `.mcp.json` all landed under each project's folder. Library at `~/.project-companion/agents/` is untouched.
> 5. WS tail: every event carries `projectId`.
> 6. Send a channel POST to `/channel/<slug-A>/test`. Only project A's WS subscribers see it; B's are silent.
> 7. Trigger a workflow in A (via `pc_run_workflow` from A's orchestrator) and B in parallel. Confirm runs don't bleed: A's worktree dir is under `<data_dir>/worktrees/<slug-A>/`, B's under `<data_dir>/worktrees/<slug-B>/`.
> 8. Soft-delete project A. `GET /api/projects` filters it out. Folder + files untouched on disk.
> 9. Add a library agent via `POST /api/agents`. `GET /api/agents` lists it. Add it to project B via `POST /api/projects/<id>/agents`. Confirm copy lands in B's `.claude/agents/` and library version is unchanged.
> 10. Edit B's copy via `PATCH /api/projects/<id>/agents/<name>`. Confirm library version still untouched.

- [x] User test passed

**Not in scope here:** UI shell (Session Q), project rename → slug migration, agent "push to library" affordance, per-project concurrency caps, isolation environments, file attachments, vault. All flagged in `MULTI-TENANCY-DESIGN.md` "Open / deferred."

### Session Q — UI vendor + multi-tenant shell

Scope: vendor v1's React UI components onto the multi-tenant server. Vellum re-skin. WS-first reshape of Orchestrator chat (v1 polled). Workflow builder deferred to a later session (currently sketched as Session R).

**Reference source:** `E:/Claude Code Projects/Personal/Project Companion/apps/web/src/` (~50 components — Shell 174 LOC, ProjectRail 191, Orchestrator chat 1295, KanbanBoard 280, Tabs 72, AppSettingsModal, FolderPicker, FolderBrowserModal, ProjectSettingsPanel, work-items/* 12 files, workflows/* 26 files mostly builder-only, activity/ActivityPanel). Stack additions: zustand, react-resizable-panels, react-markdown + remark-gfm, @dnd-kit/core + @dnd-kit/sortable. lucide-react already installed via shadcn.

**Ports to:** N/A — this IS the UI port. v1's `apps/web/src/` files are the vendor source; per-file vendor headers per trunk `CLAUDE.md` rule.

**Build order — 14 milestones.**

- [x] Q1. Add deps: zustand, react-resizable-panels, react-markdown, remark-gfm, @dnd-kit/core, @dnd-kit/sortable. `pnpm install`.
- [x] Q2. Vellum re-skin: replace shadcn slate-oklch tokens in `apps/web/src/index.css` with vellum hex (background `#080604`, foreground `#f0e4c4`, primary `#f0d080`, etc.). `--radius: 0`. JetBrains Mono via `@fontsource/jetbrains-mono`. Existing shadcn Button / Card / Badge inherit the new palette.
- [ ] Q3. Vendor Shell (3-col layout, react-resizable-panels). Header + left ProjectRail + center workspace + right ActivityPanel (stub here, filled in Q12).
- [ ] Q4. Vendor ProjectRail. Lists projects from `GET /api/projects`. Active-project state in zustand. "Create project" button surfaces the create-project modal.
- [ ] Q5. Create-project flow: vendor FolderPicker + FolderBrowserModal. Wire to `GET /api/fs/browse` (drill into dirs) + `POST /api/fs/probe` (show the folder-state preview: "12 files, no .git — we'll init here and commit them as `Initial import`. Proceed?"). On confirm, `POST /api/projects` with mode derived from the probe.
- [ ] Q6. Active-project plumbing: zustand store holds `activeProjectId`. WS hook filters events by `projectId === activeProjectId` (with an opt-in "all projects" mode for ActivityPanel per v1 §7). All API calls scope to the active project.
- [ ] Q7. Vendor Tabs strip + WorkItems → KanbanBoard. Replaces N5's simple WorkItemsList. Live updates via WS. @dnd-kit/core for drag-between-stages. Retire `apps/web/src/components/work-items-list.tsx`.
- [ ] Q8. Vendor Orchestrator chat panel. WS-first reshape: drop v1's polling, subscribe to per-project chat events. Markdown via react-markdown + remark-gfm. Approval cards inline. Ask cards: stacked descriptions + Cancel button per Session M point 3. Bundled `<channel>` blocks: parse out and render one bubble per block (closes the Session M Followup).
- [ ] Q9. Workflows tab (read-only). Vendor a minimal `WorkflowList` showing `<project>/.project-companion/workflows/*.yaml` from `GET /api/workflows`. Read-only YAML view + run history + pending-approval cards. Builder deferred to Session R.
- [ ] Q10. Vendor AppSettingsModal. Gear icon → modal. `PATCH /api/settings` (envelope from Session N close-out planning). `projectsFolder` global override editable here.
- [ ] Q11. Vendor ProjectSettingsPanel. Per-project tab. Rename, edit git remote, agent library picker (add agent from library — `POST /api/projects/:id/agents`), "Save as new library agent" when editing a project's agent (`POST /api/agents` with the project copy's body), project soft-delete + danger-zone "Also delete files on disk".
- [ ] Q12. Vendor ActivityPanel. WS event log scoped to active project (default) or all projects (toggle, per v1 §7). Persist toggle in `settings_global.activity_panel`.
- [ ] Q13. WS client hardening: port the Session F point 4 wins from legacy `app.js` (exponential backoff 2 → 5 → 15 → 30s cap, single banner per disconnect, event-timestamp dedup against server replay). Land as a zustand-friendly hook.
- [ ] Q14. `pnpm -r typecheck` green; `pnpm build` produces a clean `apps/web/dist/`.

> **Session break.** Tree clean before user test.

> **User test.** All via the UI on `http://127.0.0.1:5173/` (Vite dev → Hono `:4040`) — also verify prod (`pnpm build` + `http://127.0.0.1:4040/`).
> 1. Empty state: project rail shows "no projects." Click "Create project."
> 2. Folder picker drills under `~/`. Pick an empty subfolder; preview reads "empty folder — will git init here." Confirm. Project A lands in the rail; switching to it shows empty kanban + empty chat.
> 3. Create project B at an existing folder with files. Preview reads "12 files, no .git — will commit as Initial import then add scaffold." Confirm. Two commits land; B's kanban + chat are empty.
> 4. Switch between A and B in the rail. Workspace fully re-keys: chat, kanban, workflows, channel events all scope to the active project. Zero crosstalk.
> 5. Drag a work item between stages in A (kanban DnD). Live update via WS. Concurrently move one in B. Both update; neither bleeds.
> 6. Send a channel POST to `/channel/<slug-A>/webhook`. Only A's chat panel shows the event (assuming A is active or the user has opt-in "all projects" toggled in ActivityPanel).
> 7. Project settings → add an agent from the library to B. Edit B's copy. Confirm library version untouched (verify via `GET /api/agents` returning the unmodified original).
> 8. App settings → change `projectsFolder` global. Restart-required prompt? (No — projectsFolder is hot-reloadable; only `data_dir` requires restart per v1 #24.)
> 9. Soft-delete A from project settings → A disappears from rail. Files untouched on disk (verify in OS file browser).

- [ ] User test passed

**Not in scope here:** workflow builder UI (Session R), isolation environments UI, file attachments UI, vault / secrets UI, agent "push to library" sync, project rename → slug migration.

## When this whole plan is done

We have empirical proof of: orchestrator chat (Slice 0 already), subagent delegation, MCP integration, channel-driven async events, worktree isolation, hook-enforced path containment, end-to-end workflow firing, multi-project tenancy. That's the full PC v2 differentiator, validated.

Folded back into PC: Phase 9-B (PTY transport for chat) → 9-C (PTY for workflow exec) → optional Path 5 work. The rig stays as a regression bed.

## Session log

Append findings, surprises, and decisions here as sessions close. Cold-readable artifact for the next session.

### Session P — server-side multi-tenancy (2026-05-16 → 2026-05-17)

All 15 milestones shipped + user test passed. Server is now fully multi-tenant: per-project `ProjectRuntime` (PtySession + WorkflowRuntime + WorktreeService bundle), `ProjectRegistry` map, multiplexed channel server, scoped worktrees, full create-project HTTP API, fs probe + browse for the picker, list/get/PATCH/soft-delete, danger-zone file removal, library + per-project agent endpoints, projectId tagging on every WS broadcast envelope. The rig fixture is gone (migration `0002_drop_rig_fixture.sql`); fresh boots open with zero projects.

**Shape that landed (highlights):**
- `slug` exposed on the domain `Project` type (already in DB; needed for path policy + cache).
- `@pc/runtime` worktree primitives (`createWorktree` / `attachWorktree` / `destroyWorktree`) now take an explicit absolute `wtPath`. Path policy is the service's job — `WorktreeService(workspaceDir, baseDir)` composes `<baseDir>/<name>` from `<data_dir>/worktrees/<slug>/`. Keeps the user's repo clean (no `<workspace>/../worktrees/`).
- `ProjectRegistry.slugById` cache populated at `loadAll`/`register`/`remove`; `ProjectRegistry.refresh(updated)` is the rename-friendly seam (slug change invalidates the cached `WorktreeService` on the runtime so the next access rebuilds against the new baseDir — rename → slug migration itself is still a deferred followup).
- `ProjectScaffold` renders the full per-project scaffold from `templates/`: configs (rendered), hooks (rendered — they carry `PROJECT_DATA_DIR` etc.), workflow YAMLs (plain copy), `CLAUDE.md` (rendered), `README.md` (rendered). Path tokens are forward-slash-normalized so they're JSON-safe (see defect #1 below).
- `ProjectCreate` orchestrates: validate → uniqueSlug against DB → mint ULID up-front → `git init -b main` → optionally `Initial import` for in-place mode → scaffold + library-agent copy → `Initial commit` or `Add Project Companion scaffold` → DB insert with pre-minted id → `registry.register`. Default stages: `draft` / `review` / `done`.
- `createProject` in `@pc/db` gained an optional `id` so the scaffold pass and the DB row share an identity.
- HTTP surface added in Session P: `POST/GET/PATCH/DELETE /api/projects`, `DELETE /api/projects/:id/files` (danger zone), `POST /api/fs/probe`, `GET /api/fs/browse`, `GET/POST /api/agents`, `GET/POST /api/projects/:id/agents`, `PATCH /api/projects/:id/agents/:name`.

**Defects caught + fixed during user test (commit `d25ecd0`):**
1. `ProjectScaffold` token substitution embedded Windows-resolved paths (with backslashes) into the JSON templates → `.mcp.json` failed `JSON.parse` with "Bad escaped character". Normalized `PC_TRUNK_PATH`, `PROJECT_FOLDER`, `PROJECT_DATA_DIR` to forward slashes via a `posixPath()` helper. Node + git both accept forward slashes on Windows natively; the existing template already used forward slashes for the `/packages/mcp/src/server.ts` segment, so the trunk-author's expectation was forward-slash all along.
2. P14's broadcast envelope tagging missed two direct `ws.send` paths in `apps/server/src/index.ts`'s WS-connect handler: the initial state snapshot and the events.jsonl replay. Tagged both inline so every envelope a client sees carries `projectId`. The pattern to watch for going forward: `broadcastTo(...)` is the only fan-out path; direct sends on a specific socket must self-tag.

**Other findings worth carrying forward:**
- `tsx watch` doesn't release the channel-server port (`:8788`) cleanly between reloads — on a code change to a file the channel-server transitively imports, the reload hits `EADDRINUSE` and the process dies. Workaround during dev: `taskkill /F /PID <pid>` and restart manually. Real fix is a graceful-shutdown hook on `process.on('SIGTERM')`/etc. that calls `channelServer.shutdown()` before the new process starts. Filing as a Session Q-or-later followup; doesn't affect production binding behavior, just dev ergonomics.
- The worktrees table has a unique constraint on `(name)` where `status='active'`. Multiple projects launching workflows with overlapping `run-<short>` names (`runId.slice(0, 8)` = 32 bits) could collide across projects. Low risk for a single-user app but worth noting — a `project_id` column on `worktrees` + scoped unique constraint is the proper fix when collisions matter.
- v1's `apps/web/src/` is the vendor source for Session Q's UI port (~50 components, full inventory in the Session Q intro block above).

**Files touched (12 commits in Session P):**
- New services: `apps/server/src/services/project-runtime.ts`, `project-registry.ts`, `project-scaffold.ts`, `project-create.ts`, `project-agents.ts`, `fs-probe.ts`, `fs-browse.ts`.
- Rewritten: `apps/server/src/services/worktree.ts` (per-project baseDir), `packages/runtime/src/worktree.ts` (path policy moved out), `apps/server/src/services/channel-server.ts` (multiplexed; landed earlier in P5).
- DB: `packages/db/src/repos/projects.ts` (slug on domain, optional id, list-with-deleted, updateProjectMeta, softDeleteProject), schema migration `0002_drop_rig_fixture.sql` (landed earlier in P4).
- Trunk templates: `templates/` populated in P2.
- WS envelope tagging: `apps/server/src/index.ts`.

**Cold-read recovery for Session Q:** Open `MULTI-TENANCY-DESIGN.md` § "Per-project filesystem layout" + § "ProjectRuntime abstraction" + § "Channel server" so you have the runtime shape in your head, then this Session P log entry, then the Session Q checklist above. Vendor source lives at `E:/Claude Code Projects/Personal/Project Companion/apps/web/src/` — read-only. Stack adds for Q1: zustand, react-resizable-panels, react-markdown + remark-gfm, @dnd-kit/core + @dnd-kit/sortable.

### Session O — multi-tenancy planning (2026-05-16)

Planning-only session. No code. Walked the 7 open design questions from the Session N log with the user, locked answers, wrote `MULTI-TENANCY-DESIGN.md`, drafted BUILDOUT entries for Sessions P + Q under a new "Chassis — Multi-tenancy" section, removed the old "Session E — Multi-tenancy (optional) / Slice 7" placeholder.

**Locked answers (rationale in `MULTI-TENANCY-DESIGN.md`):**
1. Default projects folder: `~/Projects/`, settable as `projectsFolder` global. Rejected `~/.project-companion/projects/` (conflates user repos with PC's data dir).
2. Existing folder with files but no `.git`: ask once at create-time, init-in-place as the default action. Show file count + plan. Two commits: `Initial import` then `Add Project Companion scaffold`. Rejected silent init (destructive-feeling) and refusal (unhelpful).
3. Channel server: multiplexed, one server on `:8788`, path-routed `POST /channel/<slug>/<source>`. WS events tag `projectId`. Rejected per-port-per-project (operational drag for negligible isolation upside on local-first single-user).
4. Worktrees: trunk-level `<data_dir>/worktrees/<slug>/<name>/`. Matches v1 architecture §4. Keeps user's repo clean.
5. Agents: hybrid — global library pool at `~/.project-companion/agents/` (seeded from trunk `templates/.claude/agents/` on first run) + per-project copies that diverge on edit. UI: "Add from library" per-project + "Save as new library agent" when authoring in-project. Library version stays put when project copy diverges. Rejected single-source-of-truth (one breaking edit nukes all projects' agents).
6. First commit: always seed scaffold + README. Fresh folder = one commit; existing folder = two commits. Rejected empty repo (unborn HEAD → fragile worktrees) and scaffold-without-commit (surprises users).
7. Rig project on first multi-tenant boot: wipe. Rig was Session A-N scaffolding; multi-tenancy is a new contract. Migration code is complexity for a one-user state recreatable in 30s. Rejected migrate-in-place and parallel-systems.

**Cross-cutting decisions reaffirmed (from Session N close-out):**
- Multi-project is core, not deferred. Project picker functional day one.
- Every project is git-backed (mandatory). Every project is folder-linked (PC stores absolute `folder_path`). Optional git remote at create, editable in project settings.
- Per-project everything: PtySession (cwd = `folder_path`), workflow registry (`<folder>/.project-companion/workflows/`), channel routes, `.claude/agents/` copies, worktree namespace, settings.
- WS-first for live updates; no polling. Each panel snapshot-on-mount, then subscribe.
- Workflow builder deferred to its own session (sketched as Session R).
- Skip on UI for first cut: isolation environments, file attachments, vault. (Future work.)

**Cross-cutting Q5 nuance worth highlighting:** The user pushed back on the binary "copied vs shared" framing and asked for a library pool + per-project copies. Followup clarification confirmed: library = template pool (not source-of-truth), edits in projects diverge from the library, optional "save as new library agent" affordance closes the back-flow loop without forcing auto-sync. Concrete shape locked in design doc §5.

**Implementation shape that fell out (highlights — full detail in `MULTI-TENANCY-DESIGN.md`):**
- `projects` table gets `folder_path`, `git_remote` (nullable), `created_at` (epoch ms per v1 #15), `deleted_at` (soft-delete per v1 #16).
- `templates/` dir lands at trunk root with canonical agents / hooks / workflows / `CLAUDE.md` / `.mcp.template.json` / `README.template.md`. Checked in. Distinct from per-project copies users edit.
- `ProjectRuntime` (PtySession + WorkflowRuntime + WorktreeService bundle) + `ProjectRegistry` (`Map<ULID, ProjectRuntime>`) replace the server's singletons.
- Per-project `.mcp.json` injects `X-PC-Project: <ulid>` header so the in-process MCP server can scope tools to the calling project.
- Soft-delete leaves filesystem untouched. Separate danger-zone "Also delete files on disk" only nukes `.project-companion/` + `.claude/` — user's own files always stay.

**Deferred (in design doc § "Open / deferred"):**
- Project rename → slug migration (worktree dirs + channel URLs embed slug). First cut: name renamable, slug locked at create.
- "Push project edits to library" affordance for agents (the Q5 back-flow).
- Per-project concurrency caps (defer until concurrency caps exist in PC v2 at all).
- Isolation environments, file attachments, vault — flagged as "first-cut skip" in Session N log.
- Activity panel scope toggle (active vs all projects per v1 §7) — backend has the data; UI lands in Session Q12.

**Files touched (planning only):**
- New: `MULTI-TENANCY-DESIGN.md` at trunk root.
- Modified: `BUILDOUT.md` — `**Current session:**` line, cold-read order pointer, removed old "Session E — Multi-tenancy (optional) / Slice 7" section, added "Chassis — Multi-tenancy" section with Session P (15 milestones) + Session Q (14 milestones).

**Cold-read recovery for Session P:** Open `MULTI-TENANCY-DESIGN.md` end-to-end, then the "Chassis — Multi-tenancy" section in this doc, then this Session O log entry. Then start ticking the P1-P15 checklist. The session ends at the user-test gate (P15 → session break); user runs the curl/WS-tail test; Session Q only starts after that passes.

### Session N — React/Tailwind/shadcn scaffold + first panel + planning pivot (2026-05-16)

Stood up the React UI rewrite chassis in `apps/web`. 9 commits. Then a long
planning conversation at session close shifted the next sessions' shape: xterm
is out (dev tool, not a product feature), and multi-project + git-backed +
folder-linked is core to the app rather than a deferred chassis item.

**What shipped (9 commits, `2eeae6a` → `53732a0`):**
- **N1+N4** (`666e24f`): `apps/web` becomes `@pc/web`, a Vite 5 + React 19 + TS 5.7 package. tsconfig project-references (`tsconfig.app.json` for DOM, `tsconfig.node.json` for vite.config). `server.proxy` maps `/api/*` → `:4040` and `/ws` → `ws://:4040`. Old vanilla files moved to `apps/web/legacy/` as reference; not served.
- **N2** (`3f80c62`): Tailwind v4 via `@tailwindcss/vite`. CSS-first config (no `tailwind.config.js`, no postcss). `vite-env.d.ts` for `noUncheckedSideEffectImports`.
- **N3** (`c09e72d`): shadcn new-york style installed manually (canary CLI is greenfield-focused, fights existing Vite apps). `components.json`, `lib/utils.ts` (cn helper), shadcn v4 oklch slate theme in `index.css`, Button/Card/Badge components. Will be RE-SKINNED in next sessions: vellum tokens replace slate-oklch, `--radius: 0`, JetBrains Mono — see decisions below.
- **N5** (`b18f573`): `WorkItemsList` panel against existing API. Kanban-style grid grouped by stage, shadcn Card per item, inline create form, per-item stage-move via native select. Manual Refresh button (no WS yet).
- **N6+N7** (`00e737c`): Hono drops the three hardcoded handlers (`/`, `/app.js`, `/styles.css`), replaces with a catch-all GET that serves `apps/web/dist/` by MIME with SPA fallback. Path-traversal guard. Helpful 503 when dist/ missing. Root `pnpm build`.
- **User-test fallout** (`7ea5bca`): two bugs surfaced by playwright. (1) `/api/work-items` returns `{ workItems: [...] }`, not bare array — `api/client.ts` wraps with `.then(r => r.workItems)`. Legacy app.js knew this; I missed it during the port. (2) Vite defaults to IPv6-only bind on Windows (`[::1]:5173`); added `server.host: '127.0.0.1'` for consistency with the rest of the stack.
- **Cleanup** (`53732a0`): removed accidentally-committed debug PNGs, added `scripts/*.png` to .gitignore, kept `scripts/pw-debug.py` (headless load + console/error dump + screenshot) and `scripts/pw-smoke.py` (create + move + reload-verify) as long-term debugging tools.

**User test (2026-05-16):**
- Dev mode `:5173` (Vite proxying to Hono `:4040`): WorkItemsList renders both seed work items in Draft, create+move actions work, 0 console errors, 0 page errors via playwright headless run.
- Prod mode `:4040` (Hono serving Vite dist): same DOM, same behavior, 0 errors.
- End-to-end smoke: create timestamped work item via form → move to Review → reload → confirms in Review. PASS.

**Decisions worth carrying (locked during Session N + close-out planning):**
- **Keep shadcn** as the component foundation, but **swap palette to vellum** from v1. shadcn references CSS vars; replacing the oklch slate tokens with vellum hex (background `#080604`, foreground `#f0e4c4`, primary `#f0d080`, etc.) + `--radius: 0` + JetBrains Mono override gives the v1 aesthetic over a Radix-backed component skeleton. v1's hand-rolled components (Shell, Orchestrator, KanbanBoard, etc.) use the same Tailwind utility classes against the same CSS vars, so they coexist cleanly.
- **WS-first for everything, no polling.** Each panel fetches one snapshot on mount, then subscribes to the WS event stream for live updates. Trunk server already broadcasts the events we need (chat, channel, work-items mutations, status). Polling fallback nowhere. This is more correct than v1's polling shape — we're not bound by v1's choice.
- **Multi-tenancy is core, not chassis #3.** Project picker fully functional from day one. Each project is git-backed (mandatory), linked to a folder on the user's machine (existing or new), optional git remote at creation editable in project settings.
- **Per-project everything:** PtySession, workflow registry (`<project-folder>/.project-companion/workflows/`), channel server (open question: per-port or multiplexed), worktrees layout (open question), `.claude/agents/` (open question).
- **Workflow builder deferred** to its own planning session (Session R) → build sessions (S+). For Session Q the workflows tab is a read-only `WorkflowList` against the file registry.
- **Settings envelope endpoint** added server-side (small): `GET /api/settings` returns `{ values, activeDataDir, restartRequired }`, `PATCH /api/settings` writes to `settings_global` row. v1's components depend on this shape; cheaper to stub server-side than patch every consumer.
- **Skip on UI for first cut**: isolation environments, file attachments. Not in the multi-project + git + folder core; come back later.
- **xterm is OUT** of the product entirely. Was useful as dev tooling for Sessions A-M; not part of the React UI going forward. `legacy/` files still have it if anyone needs the raw PTY stream for debugging.

**Open design questions for Session O to lock down (7):**
1. Default projects-folder location. v1 has `projectsFolder` global setting. Default suggestion: `~/Projects/` (familiar) vs `~/.project-companion/projects/` (self-contained) vs always-user-picks (no default).
2. Existing folder w/ files but no `.git` — refuse, init in place, or ask user?
3. Channel server topology: one multiplexed channel with per-project event tags, OR one channel server per project on its own port (8788, 8789, …, per Slice 7 design). Multiplexed is simpler if WS events are already tagged with `projectId`.
4. Worktrees layout: trunk-level `worktrees/<project-slug>/wi-X/`, OR per-project-folder `<project-folder>/.worktrees/wi-X/`. Per-project keeps everything in one place; trunk-level keeps the user's actual repo cleaner.
5. Per-project `.claude/agents/` — each project gets its own subagent definitions copied from a template at creation? Or one shared trunk-level template?
6. First commit on project create — empty repo (no commits, no files), OR seed with `.project-companion/` scaffold + README and commit it?
7. The existing seeded 'rig' project: migrate it into the new multi-tenant shape (preserves Session M's work items), or wipe and start fresh on first multi-tenant boot?

**Files touched at trunk level:**
- New: `apps/web/package.json`, `apps/web/vite.config.ts`, `apps/web/tsconfig{,.app,.node}.json`, `apps/web/index.html`, `apps/web/components.json`, `apps/web/src/{main.tsx, App.tsx, index.css, vite-env.d.ts}`, `apps/web/src/lib/utils.ts`, `apps/web/src/components/ui/{button,card,badge}.tsx`, `apps/web/src/api/client.ts`, `apps/web/src/components/work-items-list.tsx`, `scripts/{pw-debug.py, pw-smoke.py}`.
- Moved: `apps/web/{index.html, app.js, styles.css}` → `apps/web/legacy/`.
- Modified: `apps/server/src/index.ts` (static handler rewrite), root `package.json` (build script), `.gitignore` (scripts/*.png).

**Cold-read recovery:** next session is **Session O — multi-tenancy planning, no code**. Open this entry + the `**Current session:**` line at the top. Then read v1's `E:/Claude Code Projects/Personal/Project Companion/docs/architecture.md` §2 (24 locked decisions) for multi-tenancy answers v1 already worked through — don't re-derive what's already decided there. Then walk the 7 open questions above with the user. Output of Session O: a `MULTI-TENANCY-DESIGN.md` doc capturing the locked answers, and BUILDOUT entries for Sessions P (server multi-tenancy build) + Q (vendor v1 UI). Do not write code in Session O.

**Important reference**: v1's `apps/web/src/` is the vendor source for Session Q. ~50 components covering Shell (174 LOC), ProjectRail (191), Orchestrator chat (1295), KanbanBoard (280), Tabs (72), AppSettingsModal, FolderPicker, FolderBrowserModal, ProjectSettingsPanel, work-items/* (12 files), workflows/* (26 files — most will be deferred until the builder session), activity/ActivityPanel. Stack: React 19, Vite 5, Tailwind v4 (same as ours), zustand (state mgmt — we'll add it), react-resizable-panels (3-column shell), react-markdown + remark-gfm (chat markdown), @dnd-kit/core (kanban DnD), lucide-react (already installed via shadcn). xyflow + dagre are workflow-builder only, defer. v1 has NO WebSocket plumbing — it polls. We do WS-first, so the Orchestrator chat in particular needs adaptation when vendored.

### Session M — v2 trunk promotion + sqlite migration + UX fixes (2026-05-16)

Single long session that took the repo from learning-rig shape to PC v2 trunk. 14 commits, three logical chunks. Old PC repo at `E:/Claude Code Projects/Personal/Project Companion/` stays as read-only v1 reference.

**Identity (5 commits, `1a5fc2d` → `470bcee`).** `git init` fresh at the rig root (no fork of v1's history). `.gitignore` excludes `node_modules/`, `data/*`, `worktrees/`, `workspace/` (dev fixture with its own embedded git), build output, editor noise. `.gitattributes` pins LF endings. Baseline commit on `main`. Then: rename root package `pc-pty-chat → project-companion`, add `LICENSE` (MIT — PC v1 stated it but never shipped the file), new trunk-level `CLAUDE.md` modeled on v1's working-rhythm + style + what-NOT-to-do sections, full README rewrite (lifted v1's "Why" pitch, rewrote "What works today" / "What's pending" / "Quickstart" against current reality — no kanban UI yet, no Codex, JSON persistence transitional).

**Sqlite migration (5 commits, `22fa4c6` → `470e62f`).** New `@pc/utils` with `getDataDir()` (walks up for `pnpm-workspace.yaml` to be robust to `pnpm --filter` cwd churn — found that bug during smoke test). New domain types: branded `ULID`, `OrchestratorSession`, `GlobalSettings`, `Worktree` row. New `@pc/db` package: drizzle on better-sqlite3, `0000_init.sql` with 7 tables (`projects`, `work_items`, `workflows` scaffold, `workflow_runs`, `worktrees`, `orchestrator_sessions` scaffold, `settings_global`); repos cover the runtime's read/write needs (list/get/create/move/updateFields/updateStatus + `applyRunOutcome` for the atomic-unlock case + `persistRun` for tick writes). Then the JSON-rip in `apps/server`: bootstrap runs `runMigrations()` and seeds the default `rig` project (slug + ULID) if absent; `WorkflowRuntime` constructor now takes `projectId: ULID` and all reads/writes go through repos; `WorktreeService` keeps an in-memory cache for UI polls + upserts DB rows on each git op. Per the user's wipe choice, no seed work items; first boot opens an empty DB. Existing `WorkItem` / `WorkflowRun` domain types kept rig-shape (ISO timestamps, string ids); repos cast `as ULID` at boundaries and convert epoch-ms↔ISO at hydration time. Only `Project.id` widened to `ULID` (the runtime needed it for the bootstrap-pass-projectId path). Dead JSON files (`data/{project,work-items,workflow-runs,worktrees}.json`) deleted on disk; `data/pc.sqlite` lives there now alongside the runtime files we didn't touch (events.jsonl, transcript.log, hook-debug.jsonl, stop-markers.txt, tasks.json, current-task-binding.json, mcp-log.jsonl, mcp-status.json).

**Four UX fixes (4 commits, `ce8c417` → `1ee5e04`)** surfaced during user-test:
1. **`pc_create_work_item` wired** — runtime method + `POST /api/work-items/create` + MCP tool. After the wipe, orchestrator had no create path (only move/update); first user attempt to create a card failed.
2. **MCP scoped to `workspace/.mcp.json` only** — added `--mcp-config .mcp.json --strict-mcp-config` to the `claude.exe` spawn args in `pty-session.ts`. Without these, the orchestrator merged user-level MCPs (WCP, archon, Gmail, etc.) and tried to use them. Belt-and-suspenders: added a "Tool surface" section to `workspace/CLAUDE.md` naming the exact tool prefixes (`mcp__pc-rig__*`) and explicitly forbidding WCP/archon/etc.
3. **Ask card UX** — option descriptions were `btn.title` (tooltip on hover only); now rendered inline below each button. No way to dismiss; added a muted "Cancel" button bottom-right that sends `__cancelled__` sentinel; `ask-intercept.cjs` maps it to "User declined to answer (X). Choose a different approach or ask differently." so the orchestrator switches tack instead of looping.
4. **Dead `worktrees.json` writes** removed from `@pc/mcp/src/server.ts` — was recreating a file no consumer reads.

**User test results (2026-05-16):**
- Endpoint sweep (6 GETs): all 200, fresh sqlite seeded with default project (ULID `01KRSE...`), 3 stages, 0 work items, 6 valid workflows from the file registry.
- Created `wi-01KRSEMY...` "sqlite smoke test" via the new endpoint → showed up in `/api/work-items` → survived a server restart (persistence confirmed).
- Created a second work item via orchestrator → moved both into `review` stage almost simultaneously → both `review-research` runs fired in parallel (run 1 at 18:39:53, run 2 at 18:39:54.9), both ran 2-node DAG (explore → write-findings), both completed clean in ~80s each, both unlocked work items back to `pending`. All 4 expected subagent Tasks fired (visible in events.jsonl).

**Decisions worth carrying:**
- **ULIDs for primary keys** on Project, WorkItem, WorkflowRun, OrchestratorSession, Worktree row. Stage.id stays slug (workflow YAML readability). Workflow.id stays slug (file basename). `newId()` in `@pc/db` uses `ulid.monotonicFactory` for in-millisecond ordering.
- **`nodeOutputs` as JSON blob** column on `workflow_runs` (not a separate table). Matches in-memory map shape; runtime writes the whole map atomically on each tick. No current feature needs cross-run per-node queries.
- **`getDataDir()` walks up to find `pnpm-workspace.yaml`** rather than trusting `process.cwd()` — `pnpm --filter @pc/server dev` changes cwd to the filtered package, which would have split sqlite (`apps/server/data/`) from the rig's other state (`data/` at repo root). Caught during first smoke test.
- **Domain shapes mostly kept rig-side; repos translate at boundaries.** Widening `WorkItem`/`WorkflowRun` would have cascaded into ~80 lines of mechanical fixes in `workflow-runtime.ts`. Repos cast `as ULID` for ids and convert ISO↔epoch-ms inside `toDomain()` / `persistRun`. Only `Project.id` widened (needed for the bootstrap path).
- **`workspace/` stays gitignored at trunk level.** The `workspace/CLAUDE.md` "Tool surface" guard lives in the workspace's own inner git only. Default project templates will land under `templates/` at trunk level when chassis work needs them — not today.
- **Worktree MCP tools stay calling git directly** (not HTTP shims through `apps/server`). Minor inconsistency vs work-item tools which DO shim through HTTP, but the work-item shim was needed because `WorktreeService`'s in-memory cache lives in `apps/server`. Followup: route worktree tools through HTTP too so the cache + DB stay consistent without waiting for `list()` refresh.

**Files touched at trunk level** (highlights — see `git log` for full diff):
- New: `LICENSE`, `CLAUDE.md`, `.gitignore`, `.gitattributes`, `packages/utils/`, `packages/db/` (full package + drizzle migration + meta).
- Domain: `packages/domain/src/{ulid,orchestrator,settings,worktree}.ts` new; `project.ts` widened (id → ULID); `workflow-run.ts` added `WorkflowRunTrigger`.
- Server: `apps/server/src/index.ts` (DB bootstrap + create-work-item endpoint), `apps/server/src/services/workflow-runtime.ts` (rewrote to use repos), `apps/server/src/services/worktree.ts` (in-memory cache + DB tracking).
- MCP / runtime: `packages/mcp/src/server.ts` (pc_create_work_item tool + dropped worktrees.json writes), `packages/runtime/src/pty-session.ts` (spawn args), `packages/runtime/src/hook-scripts/ask-intercept.cjs` (cancel sentinel).
- Web: `apps/web/app.js` (ask-card stacking + cancel button), `apps/web/styles.css` (option / cancel styles).
- Root: `package.json` rename + `pnpm.onlyBuiltDependencies` adds `better-sqlite3`.

**Cold-read recovery:** trunk-root `CLAUDE.md` is the new starting doc (it points back here for build status). This entry + the `**Current session:**` line at the top of this doc are the live status. Next session = chassis #3 (React + Tailwind + shadcn UI rewrite). All Slice 9 followups (open and new) live in the Followups section below.

### Session L — Slice 9 M15 + M16 + M17 done (2026-05-16)

Pushed straight through after M14. M15 wrote six seed workflows, M16 rewrote the workspace docs for per-node DAG dispatch, M17 reset transient data and booted the dev server. Whole stack now ready for the multi-part user test.

What's done:
- **M15.** Six workflows authored under `workspace/.project-companion/workflows/`:
  - `review-research.yaml` — fires on entry to stage `review`; two subagent nodes (explore → write-findings). `write-findings` consumes `$explore.output` in its prompt.
  - `approval-demo.yaml` — callable; approval + bash; bash references `$confirm.output.approved` / `$confirm.output.response` so the user sees the answer reflected back.
  - `parent-flow.yaml` + `child-flow.yaml` — callable parent (bash → workflow → bash) firing a one-bash child. Validates nested-workflow dispatch.
  - `bash-loop.yaml` — callable; one loop node with a single-bash body; `until: $tick.output.exitCode == 0`; `max_iterations: 3`. Terminates after iteration 1.
  - `cancel-on-flag.yaml` — callable; bash prints "reject" → cancel fires on `$check.output.stdout == 'reject'` → downstream never runs.
  - Registry confirms all 6 valid, zero invalid. Expression evaluator sanity-checked end-to-end (cancel `when:` is true on "reject"; bash-loop `until:` is true on exitCode 0).
- **M16.** `workspace/CLAUDE.md` got a new "Workflow event (per-node dispatch)" section explaining the channel-event shape and the orchestrator's role: fire `Task` against the named subagent with the prompt body verbatim, do NOT call `pc_complete_node` yourself, after Task returns go idle. The plain-text path stayed unchanged. `workspace/.claude/agents/researcher.md` rewritten for per-node contracts: `pc_complete_node` / `pc_node_failed` are the close-out tools; Bash heredoc for file CREATION; Edit for MUTATION; Write dropped from the allowlist entirely. Added `mcp__pc-rig__pc_complete_node` + `mcp__pc-rig__pc_node_failed` + `mcp__pc-rig__pc_log` to the agent's tools list.
- **M17.** Reset transient data: removed `events.jsonl`, `transcript.log`, `stop-markers.txt`, `tasks.json`, `current-task-binding.json`. Kept the seeded `work-items.json` (wi-1 at draft) and `project.json`. `worktree-runs.json` doesn't exist; runtime will create on first write. Killed two stale node processes (PID 33092 = tsx watch on 4040; PID 15660 = channel server on 8788) — both started 4:58 PM today but the cold-read handoff said "dev server not running", so they were orphans from a prior tab/process tree. Booted fresh dev server via `pnpm dev`; confirmed `/api/work-items` → 200 + `/api/workflows` lists all 6 workflows.

Design decisions worth carrying:
- **The user-test gate's part-4 phrasing ("critique→rewrite loop terminates on `$critique.output.approved == true`") doesn't match what M13 implements.** M13 loop dispatch fails any subagent / approval / nested-workflow node inside a body with the error "async dispatch inside a loop body is not supported in this slice". A realistic critique→rewrite shape is async-heavy. Substituted a bash-only `bash-loop.yaml` for the test; the literal critique→rewrite shape becomes a Slice 9-followup once the loop body supports async dispatchers. Test surfaces the limit clearly rather than fabricating a half-working shape.
- **None of the seed workflows use `when: false` branching.** The current scheduler doesn't mark `when:false`-but-deps-satisfied nodes as anything — they stay `pending`, which leaves the run forever `in-progress` because `recomputeRunStatus` treats any pending node as not-terminal. The cancel-on-flag workflow uses `when:` where the condition evaluates TRUE (cancel fires, run cancels), which sidesteps the issue. **Adding "true-or-pending → not-applicable" semantics for `when:` is a real Slice 9 gap** — flagged in Followups below.
- **`run.outputs` is never populated.** Each workflow can declare an `outputs:` block (documented in domain types) but the runtime doesn't compute it at terminal time. Nested-workflow dispatch passes `child.outputs ?? {}` as the parent's nested-node output, so `$nested.output` is always `{}`. `parent-flow.yaml` references `$nested.output` to demonstrate the wiring; the user will see `captured nested.output: {}`. Flagged in Followups.
- **`done_when` is documented in node types but not enforced anywhere.** Subagents calling `pc_complete_node` succeed regardless of whether files exist / fields are populated. Seed workflows skip `done_when` entirely; subagent prompts carry the contract explicitly in plain English. Slice 9-followup to wire enforcement at `nodeComplete` time.

Caveats picked up while building:
- **Worktree `wi-1` was pre-existing from earlier sessions** when the rig data was reset. `ensureWorktree` detects this (path-match branch) and reuses it without invoking the orphan-recovery fallback. Good — but the "branch already exists, attach orphan" fallback hasn't been smoke-tested live yet. It'll exercise the first time a fresh wi-N moves through a workflow after a worktree dir was manually deleted.
- **`run-<short>` worktrees accumulate across runs.** Every `pc_run_workflow` call creates a new one. Five orchestrator-triggered tests = five new worktree dirs sitting in `worktrees/`. Cleanup is manual today (`pc_destroy_worktree`). Worth a "prune `run-*` worktrees older than N hours" hook eventually.
- **Subagent prompts include literal `$<id>.output` tokens** that get substituted at dispatch time. If a subagent's prompt embeds large/complex outputs (e.g. `$explore.output` for `write-findings`), the substituted text can be sizeable. No problem for the seed workflows but worth watching once real workflows ship.

Files touched:
- `workspace/.project-companion/workflows/*.yaml` (6 new files).
- `workspace/CLAUDE.md` — new "Workflow event" channel handler section.
- `workspace/.claude/agents/researcher.md` — full rewrite for per-node contract + Bash heredoc pattern; allowlist drops Write, adds pc_complete_node / pc_node_failed / pc_log.
- `BUILDOUT.md` — M15/M16/M17 ticked, Session L log entry.
- `data/*.json` and `data/events.jsonl` — transient state cleared (no source-controlled change).

**Test results (2026-05-16):**

- **Test 1 (review-research, stage-move DAG).** First run hit the worktree-name double-prefix bug: `moveWorkItem` called `ensureWorktree(\`wi-${id}\`)` and `id` already carried the `wi-` prefix, so worktree dir came out as `wi-wi-1` instead of `wi-1`. Functionally PASS — explore and write-findings both Task'd correctly in sequence, `findings.md` landed (1163 bytes) — but in the wrong worktree. Fixed by passing `id` directly to `ensureWorktree`. Cleaned up the `wi-wi-1` branch/worktree, reset wi-1 to draft, user re-ran: PASS with `findings.md` at `worktrees/wi-1/findings.md` (1296 bytes), `ensureWorktree` exercised its no-op-on-match branch on the pre-existing `wi-1` dir.
- **Test 2 (approval-demo, callable).** Surfaced the `worktree: none` ignored bug: `runWorkflow` unconditionally created `worktrees/run-7b02a42c` even though the YAML declared `worktree: none`. Functionally PASS — approval surfaced in chat + Workflows pane; user approved; bash report ran and echoed `approved=true response=`; run terminated `complete`. Fixed `runWorkflow` AND `moveWorkItem` to read `workflow.worktree` and skip `ensureWorktree` when `'none'`. Verified by test 4 and 5 (both `worktree: none`, both ran with `worktreePath: null`).
- **Test 3 (parent-flow / child-flow, nested workflow).** PASS first try. parent-flow ran in `run-00a0d801` worktree; child-flow ran with `parentRunId=00a0d801` in the SAME worktree (inheritance per design). parent-end bash echoed `captured nested.output: {}` — the expected empty object from the `run.outputs` not-populated gap. propagateToParent fired cleanly; parent's nested node went to `complete`; parent's terminal tick fired the final bash.
- **Test 4 (bash-loop, loop).** PASS first try (with the worktree:none fix from test 2). `worktreePath: null`, loop terminated after 1 iteration, output `{ iterations: 1, last: { tick: { stdout: 'ran\n', stderr: '', exitCode: 0 } } }`.
- **Test 5 (cancel-on-flag, cancel via when).** PASS first try. `check` bash printed "reject" (printf, no newline); `abort.when` evaluated true via strict-equality string match; cancel dispatcher returned `{ kind: 'cancel' }`; tick broke the loop with `run.status = 'cancelled'`, `lastReason = 'Scope check rejected; aborting run.'`. `downstream` node stayed `pending` (never made it into a tick's ready set). `worktreePath: null`.

UX gaps observed (not blocking, see Followups):

- **Orchestrator's chat goes stale after announcing a run.** When the orchestrator calls `pc_run_workflow`, it announces the run in chat and goes idle. Subsequent state changes (approval resolved, bash node fired, run terminated) all happen server-side via WS + tick — none of it round-trips through the orchestrator. So the chat bubble "First node is an approval — waiting on your response" sits there forever even after the user approves and the run completes. The Workflows pane is the source of truth for terminal state. Fix would be a "workflow terminated" channel event ping back to the orchestrator after the unlock hook; not in Slice 9 scope but worth picking up next.
- **`run.outputs` not populated.** Already flagged in M15 design decisions; visible in test 3 as `captured nested.output: {}`. Pre-existing Followup.

Files touched during test gates (over and above M14-M17 commit set):

- `apps/server/src/services/workflow-runtime.ts` — `moveWorkItem` worktree name bug fix; `runWorkflow` + `moveWorkItem` honor `workflow.worktree === 'none'`.

Cold-read recovery: this Session L entry plus all 17 Slice 9 boxes + "User test passed" ticked. Slice 9 is done. Optional next slice is Slice 7 (multi-tenancy); otherwise the rig is ready to port lessons back to PC's Phase 9-B/C. The 5 valid + 1 stage-triggered workflows live under `workspace/.project-companion/workflows/`; the workspace docs (`CLAUDE.md` + `researcher.md`) are the canonical orchestrator + researcher contracts. Dev server may still be running on 4040 — kill before next session if not needed.

### Session K — Slice 9 M14 done (2026-05-16)

Finished the trigger-paths convergence. All seven items from Session J's "What's left for M14" list landed; typecheck green across all 5 packages.

What's done:
- `WorktreeService` plumbed into `WorkflowRuntimeOptions`. Service got an `ensureWorktree(name)` method implementing the 8b orphan-recovery pattern: `git worktree prune` → list → return on match → `create` (with `-b`) → on "branch already exists" / "already used by worktree" / "already checked out", fall back to the new `attachWorktree` helper (`git worktree add <path> <name>`, no `-b`).
- New low-level helpers in `@pc/runtime/worktree.ts`: `pruneWorktrees(workspaceDir)` + `attachWorktree(workspaceDir, name)`. Exported from package root.
- `WorkflowRuntime.ensureWorktree(name)` private wrapper just calls `this.worktrees.ensureWorktree(name)` and returns the path. Throws "workflow runtime not configured with a WorktreeService" if the option was omitted — a setup bug, not a recoverable runtime error.
- `WorkflowRuntime.moveWorkItem` became async. New shape: validate stage → load work item → lock check → `registry.findByStageEnter(toStage)` → `many`/`invalid` throw BEFORE applying any state change (so the work item stays put on rejection) → apply move → if `one`, ensure `wi-<id>` worktree, lock work item to `in-progress`, persist, `createRun` + `void this.tick(run.id)` fire-and-forget. `none` falls through to the pure-move path that existed pre-M14.
- `createRun` gained optional `id` arg. Default still `randomUUID()`; only `runWorkflow` passes a pre-generated one (needed because `run-<short>` worktree name has to be derivable before persistence).
- `WorkflowRuntime.runWorkflow(name, inputs?)` new method. Reloads registry, applies four-case rule on workflow id (none / one / many / invalid — same shape as `findByStageEnter` but on `workflow.id`). Checks `triggers.callable === true` — throws "workflow X is not callable" if not. Pre-generates `runId`, derives `run-<short>` worktree name from the first 8 chars, ensures the worktree, `createRun` with that id, then `setImmediate(() => tick(run.id))` to park past the current orchestrator turn's Stop. **The setImmediate is the M7 safety-net dodge** — without it, the first subagent node's channel POST would land before Stop fires and `onTurnEnd` would false-fail it.
- `pc_run_workflow({ name, input })` MCP tool added in `@pc/mcp`. Thin HTTP shim posting to `/api/workflow/run`.
- `POST /api/workflow/run` endpoint added in `apps/server/src/index.ts`. Maps `ambiguous trigger` / `no valid workflow` / `unknown workflow` / `is not callable` errors to HTTP 409 (same convention as the move endpoint, so the UI's existing 409→red-system-notice path handles them).
- `POST /api/work-items/move` endpoint now `await`s the async runtime call and maps the same 409 cases. `is locked: workflow in progress` also returns 409 now (was 500 in M2).
- End-of-tick work-item unlock hook added inside `tick`. Runs after `persistRun` and before `propagateToParent`. Guard: `TERMINAL_RUN_STATUSES.has(run.status) && run.workItemId && !run.parentRunId` — the `!parentRunId` guard keeps nested-workflow children from touching the parent's bound work item; the parent's own terminal tick handles it. Helper `unlockWorkItem(run)`: complete → `status='pending'` + drop `statusReason`; everything else (failed / cancelled) → `status='blocked'` + `statusReason = run.lastReason ?? "workflow run X <status>"`. Appends an `update`-kind history entry with a `workflow <id> <status>` note.
- Dead code dropped: `notImplemented` helper removed (only M5 stubs used it; M8–M13 replaced all of them).

Decisions worth carrying:
- **HTTP 409 for all four lookup-failure shapes** (`many` / `invalid` / `unknown` / `not callable`). Conceptually `unknown workflow` and `not callable` are closer to 400, but reusing 409 keeps the UI's existing red-system-notice path single. Worth revisiting if a future workflow author surface needs to distinguish.
- **`setImmediate`, not `queueMicrotask`, for the runWorkflow tick deferral.** Microtasks fire before the next I/O turn — they wouldn't dodge the safety net. `setImmediate` parks past the current Stop, which is what we need.
- **Cancelled runs unlock to `blocked`, not `pending`.** A `cancel:` node firing means the workflow chose to stop — the user needs to see what stopped it, manually unblock, and decide whether to re-trigger. Same treatment as failed.

Caveats picked up while building:
- **`runWorkflow` cycle/depth protection is implicit, not explicit.** The nested-workflow dispatcher (M12) walks the ancestry chain to detect cycles, but `runWorkflow` itself doesn't — an orchestrator could in principle call `pc_run_workflow("foo")` from inside a workflow that already has foo running. The work-item lock catches one case (same work item → 409); a callable orchestrator-triggered workflow with no `workItemId` could still spawn a parallel duplicate. Not a real problem until someone abuses it; defer.
- **No `$inputs.<key>` substitution yet.** `runWorkflow` accepts `inputs` and stores them in `run.inputs`, but the substitution layer can't reference them. M15 example workflows that need parametrization will either need it added (small evaluator + regex extension) or work around it by encoding values into subagent prompts directly.
- **`run.lastReason` is sometimes empty on failed runs.** The cancel path sets it cleanly. Pure subagent-failure paths (safety net or pc_node_failed) set `nodeOutput.error` but don't always promote a reason up to `run.lastReason`. The unlock hook's `?? "workflow run X failed"` fallback covers it, but the statusReason in the UI will be generic. Worth tightening if it bites.

Files touched:
- `packages/runtime/src/worktree.ts` — `pruneWorktrees` + `attachWorktree` added.
- `packages/runtime/src/index.ts` — re-exports.
- `apps/server/src/services/worktree.ts` — `ensureWorktree(name)` method + local `normalize` helper.
- `apps/server/src/services/workflow-runtime.ts` — `WorkflowRuntimeOptions.worktrees`, `WorkflowRuntime.worktrees` field, `ensureWorktree(name)` private wrapper, `runWorkflow(name, inputs)` public method, `createRun({ id? })`, `moveWorkItem` async + dispatch, unlock hook in `tick`, `unlockWorkItem` private helper, `notImplemented` removed.
- `apps/server/src/index.ts` — wire `worktrees` into runtime constructor; await async `moveWorkItem`; map 409 cases; `POST /api/workflow/run` endpoint.
- `packages/mcp/src/server.ts` — `pc_run_workflow` tool definition + case handler.

Cold-read recovery: this Session K entry plus M14 ticked. Next is M15 (seed YAML — review-research as a 2-node DAG + 2–3 example workflows covering bash / approval / workflow-as-node / loop / cancel). Avoid subagent / approval / nested-workflow inside `loop:` bodies — M13's sync-body-only limitation will fail those.

### Session J — Slice 9 M2–M13 + M14 partial (2026-05-16)

Landed the full DAG-runtime build minus the trigger-paths convergence. Each milestone = one logical change; typecheck stays green across all 5 packages between every step.

What's done:
- M2: 8b model stripped; files in tree gutted to stubs; `review-research.yaml` + `data/workflow-runs.json` deleted; `data/work-items.json` reset; pure-move endpoint retained but inert.
- M3: `Workflow` + 7-variant `DagNode` union + `WorkflowRun` (states `pending` / `in-progress` / `paused` / `complete` / `failed` / `cancelled`) + `NodeOutput`. `kind` discriminator is post-parse (not in YAML).
- M4: Hand-rolled validator covers all 7 node types, recurses into loop bodies, detects duplicate ids + dependency cycles via three-color DFS.
- M5: Stateless scheduler — `findReadyNodes`, `isBlocked`, `recomputeRunStatus`. Dispatch table stubbed per kind. `EvaluateBoolean` / `SubstituteOutputs` injected.
- M6: `output-substitution.ts` — `$<node-id>.output[.path]` resolver + hand-rolled recursive-descent expression evaluator (`==`, `!=`, `<`, `>`, `<=`, `>=`, `&&`, `||`, `!`, parens, literals). `==`/`!=` are STRICT, not JS-loose.
- M7: Subagent dispatch via channel POST. `pc_complete_node` + `pc_node_failed` MCP tools + `/api/workflow/node-complete` + `/api/workflow/node-failed` endpoints. Turn-end safety net marks orphaned subagent nodes failed (caveat: mid-orchestrator-turn dispatch — `pc_run_workflow` — will need M14 to queue past the current Stop; documented in code).
- M8: Bash dispatch — `execFile bash -c …`, captures `{stdout, stderr, exitCode}`, honors `timeout`, cwd = worktree or workspace root.
- M9: Script dispatch — temp-file + `execFile` for `node` / `python`. Same output capture + cleanup-on-finally.
- M10: Approval dispatch — `paused` is derived (no longer sticky); recompute detects "any approval node still running" → paused. `respondToApproval` runtime method + `/api/approvals` + `/api/approval/respond` endpoints. UI: chat bubble (event-driven) + Workflows-pane card (polled every 3s). Resolving in chat clears card and vice versa.
- M11: Cancel dispatch — new `{ kind: 'cancel'; reason }` DispatchResult variant. Tick handles cancel by flipping run.status='cancelled' + breaking the loop.
- M12: Nested workflow dispatch. Registry's file-scan + `findByName` restored (M4 made it possible). `parentNodeId` field added to `WorkflowRun`. Fire-and-forget child tick + `propagateToParent` at end of tick when terminal. Cycle detection via ancestry chain + depth cap of 10. `inputs:` mapping currently flattens to strings via `substituteOutputs`; richer `$inputs.x` substitution is deferred.
- M13: Loop dispatch — inline scheduler over the body sub-graph, evaluates `until` after each iteration. **Sync-body only** in this slice: subagent / approval / nested-workflow inside a loop body fail the body node with a clear error. `$loop.last.<id>` is NOT supported (deferred); each iteration starts fresh against the parent run's outputs.
- M14 partial: Registry got `findByStageEnter` back (same four-case rule as 8b: none / one / many / invalid) and exports `StageMatch`. Runtime hasn't started consuming it yet.

What's left for M14:
- Add `worktrees?: WorktreeService` to `WorkflowRuntimeOptions`; restore `ensureWorktree(name)` private method (8b pattern: prune → list → create → reattach fallback).
- `moveWorkItem` becomes async; calls `registry.findByStageEnter(toStage)`; if `one`, ensures `wi-<workItemId>` worktree, locks work item (`status='in-progress'`), `createRun({ workflow, yamlText, workItemId, stageId, worktreePath })`, `void tick(run.id)`. Handle `many` / `invalid` via thrown errors that the server endpoint maps to HTTP 409.
- Update `createRun` to accept an optional `id` so worktree dir name can be derived before persistence.
- New runtime method `runWorkflow(name, inputs)` — looks up by name, checks `triggers.callable: true`, ensures `run-<shortRunId>` worktree, `createRun + tick`. Throw if workflow not callable.
- New MCP tool `pc_run_workflow({ name, input })` that POSTs `/api/workflow/run`.
- New server endpoint `POST /api/workflow/run` that calls `workflow.runWorkflow`.
- Hook at end of `tick`: if `run.status` is terminal AND `run.workItemId` set AND no `parentRunId`, unlock the work item (`status='pending'` on success, `status='blocked' + statusReason` on failure). Pre-existing `propagateToParent` path is unaffected.

Caveats picked up while building:
- `pc_run_workflow` is called mid-orchestrator-turn. The turn-end safety net (M7) will mark its subagent nodes failed at the first Stop unless we delay the channel POST. M14's `runWorkflow` should either (a) queue the run's tick until after the current Stop, or (b) leave the immediate-tick path and document the corner. Easiest workable approach: have `runWorkflow` schedule tick via `setImmediate` so the current orchestrator turn ends first and the safety net's "look at running subagent nodes" runs against an empty set; the channel event arrives during the next turn. Not perfect but functional.
- Loop body's async-node-not-supported limitation is going to bite if anyone authors a workflow with a subagent inside a loop. M15 example workflows should AVOID that pattern, with a TODO note for future expansion.
- `$inputs.<key>` substitution would unlock more interesting nested-workflow patterns. Easy regex + evaluator extension, but not load-bearing for M17. Add when needed.

Files touched (live state, by milestone):
- `packages/domain/src/workflow.ts` — DagNode union (M3).
- `packages/domain/src/workflow-run.ts` — WorkflowRun + NodeOutput + paused/cancelled (M3); `parentNodeId` (M12).
- `packages/domain/src/index.ts` — re-exports (M3, M14).
- `packages/workflows/src/validator.ts` — hand-rolled validator (M4).
- `packages/workflows/src/registry.ts` — file-scan restored (M12) + findByStageEnter (M14).
- `packages/workflows/src/index.ts` — re-exports (M4, M12, M14).
- `apps/server/src/services/workflow-runtime.ts` — scheduler + 7 dispatchers + nodeComplete/nodeFailed/respondToApproval/listPendingApprovals/onTurnEnd/propagateToParent (M5–M13).
- `apps/server/src/services/output-substitution.ts` — new (M6).
- `apps/server/src/index.ts` — endpoints, broadcast, runtime wiring (M5–M12).
- `packages/mcp/src/server.ts` — pc_complete_node + pc_node_failed tools (M7).
- `apps/web/{app.js, index.html, styles.css}` — approval chat bubble + Workflows-pane card (M10).
- `workspace/.claude/agents/researcher.md` + `workspace/CLAUDE.md` — workflow obligations stripped (M2). M16 will re-flesh.

Cold-read recovery: this Session log entry + the BUILDOUT M2–M14 checkbox state are enough to pick up. The handoff is "finish M14 runtime convergence per the bulleted list above". Do not redo M2–M13; check the box ticks first.

- **Session A — 2026-05-15.** Subagent delegation visible in chat. Two surprises worth porting to PC:
  1. CC's hook layer sees the delegation tool as `tool_name: "Agent"`, not `Task` (the SDK-facing name). PC's event-capture must branch on either spelling.
  2. CC tags every PreToolUse / PostToolUse made *inside* a subagent's turn with `payload.agent_type: "<name>"`. Suppressing emission when that field is present is the clean way to get "researcher works silently" — no need to track tool_use_id nesting.

- **Session C — 2026-05-15.** Worktrees + path-guard binding both green. Notes for porting:
  1. The `{{worktreePath}}` placeholder in the agent file isn't substituted by a renderer — there's no host hook into CC's agent loading. Instead the orchestrator includes a `[worktree: <abs path>]` token in the Task prompt; the `path-guard.cjs bind` hook parses it from `tool_input.prompt`. The agent file's `{{worktreePath}}` is purely documentation telling the subagent "look in the prompt for your worktree".
  2. The bind hook keys on `tool_use_id`. In the rig only one subagent runs at a time, so "most-recently-written binding wins" is fine for enforce. PC will need to handle concurrent subagents — pass the binding's `tool_use_id` through to the enforce hook via the matching subagent's tool_use_id chain (CC's `payload.agent_type` tells you you're inside a subagent but not WHICH active Task you belong to). Worth a focused validation test before porting.
  3. The matcher-less PreToolUse hook (event-capture catch-all) fires alongside the new path-guard hooks — CC runs every hook whose matcher applies, so multiple PreToolUse entries don't replace each other. Good. PC's per-project settings generator must compose these correctly: ask-intercept (interactive tools) + path-guard bind/enforce + event-capture catch-all, in that priority order.
  4. The cleanest deny payload format is the dual-schema shape from `ask-intercept.cjs`: `{ decision: 'block', reason, hookSpecificOutput: { hookEventName, permissionDecision: 'deny', permissionDecisionReason } }`. Both old- and new-style hook contracts accept this; using only one risks falling out of CC contract drift.
  5. Bash path-containment is best-effort regex. For Windows it catches drive-letter absolute paths in the command string. Doesn't catch relative-but-out-of-tree, shell expansions, or piped paths. Adequate for the rig's "researcher with Bash" tool; PC may want a stricter sandbox if Bash subagents become common.

- **Session B — 2026-05-15.** MCP foundation + Channels both green. Notes for porting:
  1. The webhook channel server is just another entry in `workspace/.mcp.json` (alongside `pc-rig`). CC spawns it via stdio at session start when `--dangerously-load-development-channels server:webhook` is passed. No separate process to babysit from the host.
  2. Auto-confirm prompt has to live inside `PtySession` (one-shot flag, fires on first stripped-buffer match for `local development` / `Loading development channels` / `Enter to confirm` / `I am using this`). Drive-t11.js gated this with a 2s settle after the keypress; we don't need the settle because the banner-ready detection that follows handles the timing.
  3. The UI button is `window.prompt()` for now — fine in the rig, will get replaced with a real React input at PC port time. The server-side `/api/channel-send` proxy is what's worth porting verbatim: it adds the `X-Sender: test` header (the channel server's allowlist gate) so the UI doesn't have to know about it.
  4. Orchestrator behavior on incoming `<channel source="webhook">…</channel>` is shaped entirely by `workspace/CLAUDE.md` — no special wiring required. PC's per-project CLAUDE.md template should include the same "call pc_log + brief ack" pattern as the baseline reaction.

- **Session I — 2026-05-16.** Slice 9 redesign session. 8b's "workflow = one subagent runs a checklist of steps" model rejected by the user as wrong shape: a workflow was always meant to be a DAG of nodes where each node can be its own subagent, bash, script, approval, cancel, nested workflow, or loop. The intended model mirrors Archon's workflow engine (`E:/Claude Code Projects/Personal/Archon-upstream/packages/workflows/`), swapping SDK / `-p` invocation for CC subagent invocations through the long-lived orchestrator. The orchestrator can fire multiple Tasks in a single turn, which is the seam that makes the graph model work despite CC v2.1.140's nested-Task block on subagents. New design lives at `DESIGN-WORKFLOWS-V2.md`. Slice 9 scope rewritten end-to-end: 17 milestones, all 7 node types in one slice per the user's call. The original Slice 9 plan (workflow chaining at completion + `pc_run_workflow`) is subsumed — chaining becomes the `workflow:` node type, orchestrator-triggered runs become the `pc_run_workflow` MCP tool, both converge on the same DAG runtime. No code touched this session. Decisions locked: loop `until` evaluated after each iteration; approval surfaces both in chat AND Workflows pane (human-notification UI consolidation deferred); per-node retry / hooks / sandbox / parallel cap all deferred. `DESIGN-WORKFLOWS-AND-CONTRACTS.md` and `PLANNING-CONTRACTS-MODELS.md` are superseded but kept on disk as journey context.

- **Session H — 2026-05-16.** Slice 8b shipped — new workflow definition format (YAML workflows under `workspace/.project-companion/workflows/`, triggered on `stage_id`, inputs+outputs+steps+done_when on the workflow itself) + new `@pc/workflows` package + workflow runtime rewrite + `pc_step_complete` MCP tool + Workflows pane in the UI. User-tested green across all three cases (positive run, invalid-YAML rejection, ambiguous-trigger rejection). Notes for porting:
  1. **Move-into-stage has FOUR cases, not three.** The obvious three (no workflow → silent move, one valid → fire, many valid → reject "ambiguous") miss the case the user actually tested: one or more files target the stage but ALL of them are invalid. We distinguish by extracting `partialStageId` from the YAML even when the rest of validation fails, then keying off `valid hits == 0 && invalid hits > 0` → reject "no valid workflow for stage_id X". Without that fourth case, deleting `subagent:` from the only workflow would silently let the move succeed as a pure move — opposite of what the user expects. PC's port must preserve this.
  2. **The `id` field on Workflow** matches every other domain type (WorkItem, Stage, Project, WorkflowRun, WorkflowNode). BUILDOUT line 320's original `Workflow { name, ... }` wording was loose, not a deliberate divergence — `id` is the correct identifier per existing convention and the design doc's example. `WorkflowRun.workflowId` matches. Keep that consistent on the PC port.
  3. **Hand-rolled validator is enough for this scale.** ~200 lines, granular `{path, message}` errors, no zod. The UI's Workflows pane renders each error inline with the YAML's path so authors get clear feedback. PC's bigger schema will need its own rewrite, but the rig's shape (validate → returns `{ok, workflow?, errors[], partialStageId?}`) is the right contract to port forward.
  4. **`workflowYamlSnapshot` works as designed.** Runtime parses the snapshot text via `parseWorkflowText` at `pc_complete_workflow` time, pulls `done_when` + `outputs` from there, not from the live registry. Live edits to the YAML between dispatch and completion can't perturb in-flight runs. Validated implicitly by Test 1's clean completion.
  5. **The `outputs:` dotted-path mapping is the right shape.** Slice 6.5 shallow-merged the whole output blob into `workItem.fields`; Slice 8b respects the workflow author's intent ("summary lands at workItem.fields.summary, not somewhere I didn't ask for"). The runtime falls back to shallow-merge when `outputs:` is absent so partially-specified workflows don't lose data.
  6. **Trigger-resolution errors return HTTP 409, not 500.** Move endpoint regex-matches `^ambiguous trigger|^no valid workflow` and downgrades the status. UI keys off `res.status === 409` to render a red `system-notice` bubble in chat instead of `window.alert`. Keep this — the user reads errors in the same place they read everything else.
  7. **CC v2.1.140 has a built-in soft-block on `Write` inside subagent turns** (not a hook denial, not a permission denial). When a subagent calls `Write`, CC returns a `<tool_use_error>` saying: *"Subagents should return findings as text, not write report files. Include this content in your final response instead."* Verified by reading the subagent's sidechain JSONL at `~/.claude-alt/projects/.../d97f675f.../subagents/agent-af1d21a4a7b271080.jsonl` line 18. **The gate is 100% reproducible** — grepping `~/.claude-alt/projects/.../*/subagents/*.jsonl` across 7 different past sessions (Slice 6.5, 8a, and 8b runs) every single subagent that tried `Write` hit the same advisory. Confirmed it's NOT our path-guard: zero `decision: block` entries in `hook-debug.jsonl`, zero `permissionDecision: deny` in the hook stream. The researcher recovers cleanly: it falls back to a Bash heredoc (`Bash` is NOT subject to the gate) and the workflow contract still passes because `files-non-empty` only cares that the bytes landed, not which tool wrote them. Implications for the PC port:
     - **The agent allowlist's `Write` entry is effectively a lie for subagents** — listed but soft-blocked at runtime regardless of agent name or description.
     - **`Edit` and `Bash` are NOT gated.** Verified in the post-test rename experiment (sidechain `agent-a89257db8e05853b5.jsonl`): the subagent ran `Write` (blocked), then `Bash` heredoc (succeeded — created findings.md), then `Edit` (succeeded — refined the contents). So the available file paths inside a subagent are: file creation via `Bash` heredoc, file mutation via `Edit`.
     - **Agent rename does NOT escape the gate.** Tested by adding `workspace/.claude/agents/writer.md` (generic file-writer, not researcher) and flipping `review-research.yaml`'s `subagent:` from `researcher` to `writer`. The exact same `<tool_use_error>` advisory fired on the `writer` subagent's `Write` call. The gate keys on the `Write` tool inside any subagent turn, not on the agent's role description.
     - **PC workflow prompts should phrase file creation as "use Bash heredoc to create, then Edit to refine"** — drops `Write` from the loop entirely, saves the wasted-attempt round-trip. PC subagent allowlists can drop `Write` cleanly without losing capability.
     - This is independent of PC's architecture choices and inherits cleanly into PC v2 — Phase 9-C's workflow runtime should ship subagents with the Bash-heredoc + Edit pattern baked into their system prompts as the default. (Writer agent + temporary YAML edit cleaned up post-experiment; researcher is restored as the only subagent in the rig.)
  8. **YAML extraction for `partialStageId` survives most kinds of brokenness.** Our test deleted the entire `subagent:` line and the registry still pulled `partialStageId: "review"` cleanly because `triggers.on_enter.stage_id` is structurally independent. If a workflow author breaks the `triggers` block itself, we fall back to `kind: 'none'` (silent move) which surfaces differently — that's acceptable since the bigger problem (broken triggers) gets flagged in the Workflows pane.
  9. **8 MCP tools now: pc_log, pc_create/list/destroy_worktree, pc_move/update_work_item, pc_complete_workflow, pc_step_complete.** Header pill should read "MCP: 8" after the first message. (Sanity check on the next boot.)
  10. **No CC restart pain this time.** The full server restart cycled claude.exe naturally — researcher.md's new tool allowlist (now including `mcp__pc-rig__pc_step_complete`) was picked up on first spawn. No mid-session edit, so Session G's agent-cache gotcha didn't bite.

- **Session G — 2026-05-16.** Slice 6.5 re-confirmed (both phases green on a fresh test pass) and Slice 8a shipped (pure PC-vocabulary rename pass — Card → WorkItem, kanban container → Project, on_enter trigger stays on Stage). Notes for porting:
  1. **CC caches subagent files at session start.** Editing `workspace/.claude/agents/researcher.md` mid-session has zero effect — claude.exe holds the file content read at spawn time. Verified during the 8a negative test: gutting the "must call pc_complete_workflow" section while the session was running didn't change behavior; the researcher still called the tool. Killing claude.exe + browser reload → fresh read → gutted version took effect → safety net fired as expected. PC's port needs a "reload session" mechanism (kill+respawn, ideally graceful) for workflow/agent file edits to take effect.
  2. **Worktree copies of agent files are stale-and-unused.** `worktrees/wi-1/.claude/agents/researcher.md` (checked out from workspace HEAD) had a much older read-only version that hadn't been committed since the rig's early days, while the live subagent had Write + MCP tools. CC reads agent files from the orchestrator's cwd (`workspace/`), not the subagent's bound worktree. The worktree's `.claude/` copy is misleading noise — worth either pruning post-checkout or just trusting the workspace version exclusively.
  3. **Architecture review on 2026-05-16 locked the workflow trigger model** before Slice 8b: stage_id-based triggers only (no `role`), exactly one workflow per stage on enter, inputs/outputs declared on the workflow itself (not on the stage's on_enter), hand-rolled YAML validator (no zod yet), `subagent:` field on the workflow as a rig-only extension PC will fold in at Phase 9-C. See Decisions update at top of DESIGN-WORKFLOWS-AND-CONTRACTS.md.
  4. **Worktree name migration was mechanical.** `card-1` → `wi-1` required `git worktree remove --force` + `git branch -D card-1` + `git worktree prune` from inside workspace/. Took ~10 seconds. PC's port shouldn't need this — work-item ids in PC are stable ULIDs that don't churn the way the rig's `card-N` did.

- **Session F — 2026-05-16.** Slice 6.5 (completion contracts) green. Notes for porting:
  1. **Subagent retry loop works in practice.** First user-test run, researcher attempted `pc_complete_workflow` twice without writing `findings.md` (rejected with `{ok:false, missing:[file findings.md: no matching files]}`), then switched approach on its third try, wrote the file via `Write` tool, and the contract passed. No retry cap in Slice 6.5; design doc caps at 5 in Slice 8. Worth keeping the cap loose — the model needs a few tries to internalise the contract.
  2. **Path-guard regex blocked Bash writes with whitespace paths.** Original `[A-Za-z]:[\\/][^\s'"\`)]+` truncates `E:/Claude Code Projects/...` at the first space → `E:/Claude` → fails `isInside(worktreePath)` → bash denied. Patched to scan single/double/backtick-quoted forms before falling back to unquoted. PC's preset generator MUST ship the patched version; subagents writing under any space-bearing Windows path will hit this otherwise.
  3. **Safety net fires cleanly.** Negative test (remove the MCP tool from researcher's allowlist) → subagent can't call `pc_complete_workflow` → orchestrator's turn ends → `onTurnEnd()` flips run to `failed`, card to `blocked`, statusReason populated. Validated end-to-end in <30s after the orchestrator's reply finished.
  4. **WS reconnect spam fixed in the same session.** Server replays full events.jsonl on every WS connect, including reconnects → chat panel re-flowed every 2s during tsx-watch restarts. Client now tracks seen event timestamps + uses exponential backoff (2→5→15→30s cap). Both worth porting verbatim to PC's web app.
  5. **Orchestrator no longer calls `pc_update_card` in the workflow path.** That decision was deliberate — the design doc demotes pc_update_card to admin tool; subagent's `pc_complete_workflow` is the only path that writes card.fields. Worked first-try once the channel prompt was updated.

- **Session E — 2026-05-16.** Design session for completion contracts + workflow lifecycle. Output: `DESIGN-WORKFLOWS-AND-CONTRACTS.md`. Key reframes worth carrying into implementation:
  1. **Models A/B collapsed.** A workflow is intrinsically single-Task (one subagent owns the run end-to-end). The Model-B "durability across sessions" property comes from the *card* layer — card moves between nodes, each node fires its own workflow, each workflow is its own Task. So "which model do we use" stops being a per-workflow question.
  2. **Workflows are callable units of work.** Card-triggered, orchestrator-triggered, and chain-triggered all converge on the same workflow run primitive. `pc_run_workflow` is the orchestrator-callable entry point.
  3. **Contract lives on the workflow definition**, not the node and not per-step. `done_when` is a workflow-level gate validated by `pc_complete_workflow` at the end.
  4. **Sub-workflows = chained workflows.** Routes around CC v2.1.140's nested-Task block — workflow A completes with output, runtime queues workflow B with that output as input. No subagent ever spawns another subagent.
  5. **Predicates v1: `files-non-empty` (>0 bytes, worktree-relative, globs allowed) + `output-fields-non-empty` (nullish / empty-string-trimmed / empty-array / empty-object are "empty"; 0 and false pass).** Add more predicate types only when a real workflow demands them.
  6. **No mid-workflow human waits in v1.** Approvals happen at card-node boundaries between workflows. Wait-and-resume inside a workflow is deferred (Slice 11+ if ever).
  7. **Safety net for misbehaving subagents.** Runtime watches Task return; if `pc_complete_workflow` was never called successfully, card status → `blocked`. The system-prompt MUST-call instruction is documentation; the runtime check is the gate.

- **Session D — 2026-05-16.** Slice 6 E2E loop green + nested-Task validation done. Notes for porting:
  1. **Dispatch logic centralised in apps/server.** MCP tools `pc_move_card` / `pc_update_card` are thin HTTP shims to `/api/cards/{move,update}`; `WorkflowRuntime` (`apps/server/src/services/workflow-runtime.ts`) owns card mutation + on_enter dispatch + channel POST. Keeps the "what happens when a card moves" decision in one place rather than duplicated between MCP server and apps/server.
  2. **Channel POST allowlist.** Internal POSTs to the webhook channel must use `X-Sender: test` (the channel-server default allowlist). Custom sender IDs get 403'd. Worth surfacing in PC's preset generator so future ports don't repeat the discovery.
  3. **Worktree orphan recovery is mandatory.** Failed dispatch can leave a branch without a worktree. `WorkflowRuntime.ensureWorktree` runs `git worktree prune` first, then on "branch already exists" error retries `git worktree add <path> <name>` (no `-b`) to attach the orphan. Without this, the second move attempt fails forever.
  4. **Nested Task invocations are blocked in CC v2.1.140** (validated by the now-deleted `conductor.md`). A subagent with `tools: Task` exits with `totalToolUseCount: 0` — it produces text saying "I'll delegate" (sometimes even the literal `[Tool use: Task]` string) but never actually fires the tool. **Model C (conductor + nested subagents)** is therefore **off the table** until/unless CC's behavior changes. Workflow lifecycle has to use Model A (one Task = full workflow run) or Model B (one Task = one node, state on card). For PC plan a mix of A and B per workflow design — A for tight single-specialist loops, B for long/multi-specialist/resumable workflows.
  5. **Agent files are eager-loaded.** Editing `.claude/agents/*.md` after the orchestrator booted has no effect — the new tool list / system prompt only kicks in on the next PtySession spawn. Port-time implication for PC: any per-project preset regeneration that touches agent files must follow with a session restart, or the change is silently ignored.
  6. **Completion contract gap.** Slice 6 closed but the loop trusts the subagent + orchestrator to actually do the work. Researcher in the user-test returned a summary instead of writing `findings.md`; nothing caught the lie. Real fix lives in the completion-contracts followup — see Followups.

## Followups

Not yet sliced into the build plan. Open items the team is aware of, gathered as they surface.

- ~~**Completion contracts.**~~ **Superseded by Session E design** (`DESIGN-WORKFLOWS-AND-CONTRACTS.md`). Contract lives at workflow level (not per-step); tool renamed `pc_complete_workflow`; safety net added for subagents that return without calling it. Implementation = Slice 6.5.

- ~~**Workflow lifecycle = subagent lifecycle (Models A + B).**~~ **Superseded by Session E design.** Models A/B collapsed: workflows are intrinsically single-Task, multi-stage flows handled by chaining at the card layer. No `lifecycle` field on workflow. Implementation rolls through Slices 6.5 → 8 → 9 → 10.

- **Chat panel doubling on rapid reload / double-send.** Symptom: every event renders twice in the chat panel during some test runs. Confirmed root cause in the Session D nested-Task test was a *real* double prompt-fire (two distinct `Agent` invocations in the hook stream, ~20s apart) — so in that case the doubling reflected actual duplicate execution, not a UI bug. But the trigger isn't well understood: was it a double-send from the user, a tab reload that re-issued the buffered input, or something on the server side resubmitting? Investigate when it happens next. Things to check: (a) `events.jsonl` replay on WS reconnect — does it deduplicate against what the live broadcast already pushed? (b) input box behavior on Enter — any chance Shift+Enter or paste-with-newline submits twice? (c) tsx watch reloads — do they re-emit queued WS messages? Probably worth a dedicated regression test once the trigger is reproducible.

- **Session restart UX.** Killing claude.exe to pick up agent-file or settings changes dumps ANSI noise in the xterm panel. Two cleaner paths: a `/api/session/restart` endpoint that does `session.kill()` + clears the ref and lets the next WS message respawn, AND/OR a "Reload session" UI button that calls that endpoint and clears the term display. Known limitation; mentioned in user memory.

- ~~**WS reconnect spam when server is down.**~~ Fixed 2026-05-16 in `apps/web/app.js`: backoff (2s → 5s → 15s → 30s cap), single banner per disconnect, and client-side event-timestamp dedup so the server's full replay on each reconnect doesn't re-flow the chat panel.

- **`when: false` keeps a node pending forever.** Found while authoring M15 example workflows. If a node's deps are satisfied but its `when:` expression evaluates false, the scheduler filters it out of `findReadyNodes` without marking the node anything — it stays `pending`. `recomputeRunStatus` then sees pending and returns `in-progress`. Run never terminates. Fix: introduce a `not-applicable` (or just reuse `skipped` with a distinguishing error string) status for the `when: false`-with-deps-satisfied case, and update `recomputeRunStatus` to treat it as a terminal-acceptable status (unlike the dep-failure-induced `skipped`). Until this lands, branching workflows that use `when: false` are unsafe — only `when:` patterns where the conditional path evaluates true (or where the workflow uses cancel to short-circuit) are safe. See M15 Session L log for context.

- **`run.outputs` never populated.** Each Workflow YAML can declare an `outputs:` block; the runtime stores per-node outputs but never computes the workflow-level outputs map. Nested-workflow dispatch reads `child.outputs ?? {}` which is always `{}`. Fix: at end of `tick` when status is terminal, evaluate the `outputs:` mapping (each value is a `$node.output[.path]` expression) and store the resulting object on `run.outputs`. `$inputs.<key>` substitution probably wants to land at the same time.

- **`done_when` declared but not enforced.** Subagent `pc_complete_node` calls succeed regardless of whether `done_when.files-non-empty` files exist or `done_when.output-fields-non-empty` fields are populated. Fix: wire enforcement at `nodeComplete` time — load the node from the YAML snapshot, run the contract, reject (with retry-able error) on failure. Slice 8b had this at workflow level; v2 design moves it per-node.

- **Loop body doesn't support async dispatchers.** M13's loop dispatcher fails subagent / approval / nested-workflow nodes inside a body with the error "async dispatch ... is not supported in this slice". Realistic loops (critique→rewrite, retry-with-subagent) need async support. The blocker is sharing the run's nodeOutputs across iterations vs. scoping body outputs per iteration; mechanical but non-trivial. Folded into a later slice once a real workflow demands it.

- **`$inputs.<key>` substitution unsupported.** `pc_run_workflow` and nested-workflow `inputs:` mappings both store their inputs on `run.inputs`, but the substitution layer can't reference them via `$inputs.x` syntax. Easy regex + evaluator extension when a workflow needs parametrisation.

- **No "workflow terminated" channel ping to the orchestrator.** When the orchestrator calls `pc_run_workflow`, it announces the run in chat and goes idle. State changes after that (approval resolved, async node fired, run terminated) all happen server-side and never round-trip through the orchestrator. The orchestrator's chat bubble stays stuck on the announcement line even after the run completes. The Workflows pane is the real source of truth, but a "workflow `X` terminated with status `Y`" channel POST after the unlock hook would close the UX loop. Found during Slice 9 user test (tests 2-5 all showed this).

- **Chat panel renders bundled channel events as one bubble.** When two channel events arrive in close succession (sub-second), CC injects them as two `<channel source="webhook">…</channel>` blocks inside a single orchestrator user-message turn. The chat panel renders the user-message as one bubble — the second event is invisible to a casual reader even though the orchestrator processed both. Found in Session M user-test: moving two work items into `review` within ~1.8s of each other fired both workflows correctly (4 subagent Tasks total, all complete), but the user only saw one "channel event arrived" notification. Fix: parse `<channel>` blocks out of the user message before rendering and emit one bubble per block. Lands naturally during the React rewrite when the chat panel gets reshaped.

- **MCP worktree tools call git directly, not via HTTP.** `pc_create/list/destroy_worktree` in `@pc/mcp` shell out to `@pc/runtime`'s git helpers; they don't go through `apps/server`'s `WorktreeService`. Means the service's in-memory cache + DB rows can be out of sync with reality until the next `list()` refresh. Work-item tools already shim through HTTP — should normalize worktree tools the same way. Not blocking; orchestrator-driven worktree changes self-heal on next `/api/worktrees` poll.
