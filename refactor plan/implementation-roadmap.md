# Implementation Roadmap

## 1. Baseline and Scope

| Field | Value |
|---|---|
| Date | 2026-05-30 |
| Branch | `dev` |
| Commit | `d114fc2535c1116f6eb2d883f9cac2a9193a8254` |
| Inputs | `target-architecture.md`, `holistic-architecture-synthesis.md`, `refactor-tracker.md`, and the six synthesized priority subsystem handoffs |
| Target | This current repo. Do not start a parallel rewrite app. |
| Scope | Build-oriented roadmap only. No implementation refactors in this artifact. |

Evidence rule:

- Verified facts below come from current non-archive code inspection.
- Synthesis and recommendations come from the holistic synthesis and subsystem handoffs.
- `archive/` was not searched or used as evidence.

## 2. Verified Current-State Facts

| Area | Verified fact | Evidence |
|---|---|---|
| Package layout | Existing packages are `agent-host`, `db`, `domain`, `mcp`, `runtime`, `utils`, and `workflows`; there is no `packages/contracts`, `packages/app-services`, `packages/live`, or `packages/mailbox`. | `packages/` directory listing |
| Server composition | `apps/server/src/index.ts` creates `ProjectWebSocketHub`, creates `ChannelServer`, imports legacy `routes/pod-routes.ts` and `routes/workflow-routes.ts`, and registers newer `features/*` route modules. | `apps/server/src/index.ts` |
| Live events | `ProjectWebSocketHub` stores in-memory subscribers; `broadcast()` tags project-scoped events, while `broadcastAll()` sends payloads unchanged. | `apps/server/src/services/websocket-hub.ts` |
| Projects | Project create, patch, delete, and reorder routes update DB/runtime state but do not emit project-list live events. | `apps/server/src/features/projects/routes.ts` |
| Runtime boundary | `ProjectRuntime` owns chat/session concerns, workflow firing, worktrees, field schemas, transient sessions, and workflow builder drafts. | `apps/server/src/services/project-runtime.ts` |
| Durable state | DB schemas exist for `orchestrator_sessions`, `orchestrator_send_queue`, `workflow_runs_v2`, `agent_runs`, `pending_asks`, and `agent_inbox`; no canonical live outbox/mailbox table family exists yet. | `packages/db/src/schema.ts`, `packages/db/src/schema-agent-system.ts` |
| Transcript replay | Chat replay still uses `jsonl-events.jsonl` through runtime/session replay paths. | `packages/runtime/src/pty-session.ts`, `apps/server/src/services/session-replay.ts` |
| Channel | Channel is active through `ChannelServer`, `/channel-register`, `channel-server/server.js`, and `notifications/claude/channel`. | `apps/server/src/services/channel-server.ts`, `channel-server/server.js` |
| MCP | MCP tools use `ToolContext` over localhost HTTP and hand-written tool payload/result handling. | `packages/mcp/src/tools/context.ts`, `packages/mcp/src/tools/*` |
| Tests | No non-archive `*.test.*` or `*.spec.*` files are discoverable in the working tree; `git status` shows many tracked tests deleted before this session. | `rg --files --glob "!archive/**" \| rg "(test\|spec)\.(ts\|tsx\|js\|mjs)$"`, `git status --short` |

## 3. Roadmap Principles

- Restore characterization coverage before behavior refactors.
- Introduce contracts before moving ownership boundaries.
- Keep old HTTP endpoints, WebSocket envelopes, JSONL replay, `pc_*` tool names, and Channel paths until replacements are proven.
- Prefer additive DB migrations first; destructive cleanup waits for static search and integration proof.
- Move one feature cartridge at a time:

```text
contract
  -> app service / repo boundary
  -> route adapter
  -> live event or mailbox fact
  -> web client/hook
  -> MCP adapter when relevant
  -> tests
```

- Do not split `ProjectRuntime` deeply until shared contracts, live-event recovery, transcript replay, and mailbox delivery decisions are stable.

## 4. Phase Roadmap

| Phase | Goal | PR/checkpoint boundaries | Dependencies | Acceptance gate | Rollback posture |
|---|---|---|---|---|---|
| 0. Characterization and harness | Restore or recreate focused tests for current behavior before risky changes. | 0A test harness/package scripts; 0B WS/reconnect tests; 0C chat replay/send queue tests; 0D agent pending ask tests; 0E workflow review/cancel tests; 0F MCP/Channel characterization. | None, but foundation specs should guide priorities. | Tests document current behavior and known bugs; no product behavior changes. | Tests only can be removed or revised without runtime migration. |
| 1. Shared contracts and service conventions | Create the shared contract package shape, result/error conventions, and app-service dependency rules. | 1A `packages/contracts` skeleton; 1B browser-safe DTO/validation pattern; 1C app-service boundary spec; 1D first low-risk migrated contract. | Roadmap plus shared-contracts foundation spec. | Server, web, and MCP can import migrated contract types without import cycles or behavior changes. | Keep local types as aliases; revert imports family by family. |
| 2. Low-risk app-service seams | Move simple resource commands/queries behind service facades without changing behavior. | 2A projects/settings; 2B project context/files where safe; 2C work-item read/query seam after work-item handoff. | Phase 1. | Routes delegate to services, responses remain compatible, and tests prove parity. | Route wrappers can delegate back to old functions. |
| 3. Canonical live events for non-runtime resources | Define and emit canonical live envelopes with compatibility adapters, then add durable outbox/replay for selected resources. | 3A envelope and scope rules; 3B global/project compatibility; 3C project/work-item/pod/workflow event adapters; 3D outbox table and replay; 3E client cursor/refetch integration. | Phases 0-2 plus live-events foundation spec. | DB write -> event fact/outbox -> fanout/replay or documented refetch path. | Legacy envelopes continue until all hooks migrate; outbox fanout can be disabled by feature flag. |
| 4. Work-item dependency contracts | Document and then migrate work items, stages, fields, attachments, and verification contracts needed by agents/workflows/MCP. | 4A handoff artifact; 4B contracts; 4C service/repo seams; 4D MCP/web parity; 4E live-event integration. | Phases 1-3 and work-item dependency handoff. | Agents/workflows can depend on stable work-item contracts rather than ad hoc route shapes. | Keep existing routes and web clients as compatibility adapters. |
| 5. Workflow service hardening | Establish workflow definition/run/review/builder services and stable run identity. | 5A definition service and duplicate YAML/id rewrite; 5B run row identity/version; 5C run lifecycle writer and cancellation; 5D boot reconciliation; 5E review persistence/validation; 5F builder durability decision. | Phases 0-4 plus mailbox direction for review. | Duplicate workflow identity is correct, cancellation/restart outcomes are explicit, and review decisions are idempotent. | Keep compat routes and old slug display; terminalize or mark recovery states rather than deleting rows. |
| 6. Agent-run service hardening | Put dispatch/continue/pause/resume/cancel/terminal behavior behind an agent-run service. | 6A run/pending-ask contracts; 6B pending-ask atomicity fix; 6C rev/live-event consistency; 6D service facade; 6E transcript backfill/live parity; 6F host/in-process recovery policy. | Phases 0-4; mailbox pending-interaction direction. | Status mutations update SQLite and emit current-version events; failed resume cannot consume retryable asks silently. | Keep current MCP/HTTP/WS shapes; keep `agent_inbox` bridge until mailbox is ready. |
| 7. Conversation/session/send/replay service | Separate chat session, send queue, pending interaction, and transcript replay services from runtime process handling. | 7A session/send/replay contracts; 7B route/WS adapters; 7C durable pending interactions; 7D transcript repository over existing files; 7E optional SQLite mirror; 7F renderer policy cleanup. | Phases 0-3 plus runtime transcript foundation spec. | Start/send/replay/close/resume behavior is preserved; old `events.jsonl` and `jsonl-events.jsonl` sessions still load. | File-backed replay remains fallback; old render path stays behind a compatibility switch until parity. |
| 8. Mailbox and pending-interaction platform | Add durable mailbox tables/services, UI inbox, delivery workers, and mailbox-backed pending action references. | 8A recipient and ack contracts; 8B mailbox schema/repo; 8C UI inbox and live nudges; 8D orchestrator-turn worker over send service; 8E retry/dead-letter/audit; 8F dual-write or bridge from `agent_inbox`. | Phases 1, 3, 6, and 7 plus mailbox foundation spec. | Messages are queued or rejected by policy, never silently dropped; delivery ack is separate from UI projection. | Keep Channel fallback by message kind during migration; additive schema first. |
| 9. Delivery cutover off Channel | Move agent delivery, workflow review, and external webhook delivery to mailbox policies. | 9A agent pause/terminal delivery; 9B workflow review delivery; 9C external webhook routing; 9D static search and runtime config cleanup; 9E remove Channel from target paths. | Phase 8. | No target path depends on `/channel-register`, `notifications/claude/channel`, or development-channel runtime flags. | Temporary fallback flag can point selected message kinds to old Channel until tests pass; no new Channel features. |
| 10. Runtime host, transient sessions, and worktrees | Split runtime process ownership from product services after contracts and replay are stable. | 10A runtime-host interface; 10B transient-session adapter contract; 10C worktree/path-guard service boundary; 10D workflow/agent runtime adapters; 10E remove product-service ownership from `ProjectRuntime`. | Phases 5-7 and 9. | PTY lifecycle, reconnect, send queue, transient sessions, and worktree path safety remain characterized. | Keep a `ProjectRuntime` facade until callers are migrated. |
| 11. MCP typed client and capability registry migration | Move MCP tool families to shared contracts/typed localhost client and a canonical capability registry. | 11A capability registry; 11B typed local client; 11C project/work-item family; 11D workflow family; 11E agent/pending family; 11F external MCP config validation; 11G rebuild verification. | Phases 1, 4-8 as each family stabilizes. | Existing `pc_*` tools stay listed/callable while internals use shared contracts and emit canonical events. | Keep text result compatibility and raw HTTP helper fallback per family. |
| 12. Compatibility cleanup | Remove stale event shapes, compatibility routes, old Channel code, and duplicated local types after callers migrate. | 12A static search gates; 12B compatibility route removal; 12C legacy event removal; 12D old prompt/tool text cleanup; 12E data migration cleanup. | All earlier phases. | No active server/web/MCP/runtime caller references removed paths or shapes; integration suite passes. | Cleanup PRs are isolated and revertible; DB destructive migrations wait for backup/export decision. |

## 5. First Vertical Slice

Recommended first build-slice plan: `001-foundation-vertical-slice`.

Candidate scope:

- **Feature subject:** project list/project metadata, because it is low-risk, already has a feature route and web client, and currently lacks cross-client live projection.
- **Contract:** introduce the minimum `packages/contracts` skeleton plus project DTO/result/error types and a draft live-event envelope alias.
- **App service / repo boundary:** wrap existing project repo operations behind a project application service without changing DB behavior.
- **Route adapter:** keep `apps/server/src/features/projects/routes.ts` endpoints and response shapes compatible.
- **Live fact:** emit a compatibility `project.changed` event through the current hub first; durable outbox waits for the live-events spec unless that spec is ready.
- **Web client/hook:** move project list mutations/read paths to shared contract types and deterministic refetch on the compatibility event.
- **MCP adapter:** not required unless the slice expands to project-config tools; if included, migrate only read-only project/stage listing through typed contracts.
- **Tests:** contract round-trip, route response parity, second-client project-list refresh, and reconnect/refetch behavior.

Stop conditions for this slice:

- It requires runtime, Channel, agent-run, workflow-run, or transcript behavior changes.
- It requires a destructive DB migration.
- Shared contracts create an import cycle with server/runtime/MCP packages.
- Current project create/delete/reorder behavior cannot be characterized first.

## 6. Cross-Phase Test Gates

Phase 0 must define or restore these before behavior refactors:

- WebSocket hub, global/project event filtering, reconnect/refetch, and project-list sync.
- Chat connect/replay/send queue/ask/terminal-mode characterization.
- Agent dispatch, pause/resume/answer/cancel, transcript backfill, and host/non-host recovery behavior.
- Workflow duplicate identity, fire, cancel, boot reconciliation, and review decision behavior.
- MCP tool list, tool payload/result parity, materializer/capability registry, and typed client errors.
- Channel register/drain/drop behavior and `agent_inbox`/`pending_asks` current semantics.

Every implementation PR after Phase 0 should include:

- a focused automated test or an explicit reason a manual-only check is unavoidable;
- typecheck/build commands relevant to touched packages;
- a rollback note;
- a static search for old paths when removing compatibility.

## 7. Rollback Strategy

- Keep legacy routes and legacy WebSocket envelopes until migrated clients are verified.
- Keep `pc-rig` and `pc_*` tool names for the full migration.
- Keep JSONL file replay as a fallback until transcript repository parity is proven across old and new sessions.
- Use additive DB migrations first; destructive table/column cleanup waits for explicit cleanup phases.
- Gate mailbox cutover by message kind and recipient policy.
- Keep Channel only as a temporary fallback during mailbox migration; do not add new Channel capabilities.
- Isolate high-risk edits into separate PRs/checkpoints: workflow run identity, pending ask atomicity, transcript storage, orchestrator-turn delivery, Channel deletion, and MCP tool result changes.

## 8. Conflicts and Decisions to Resolve in Foundation Specs

| Topic | Current recommendation | Blocking artifact |
|---|---|---|
| Live event cursor | Use one canonical envelope with `scope` and `projectId`; support compatibility adapters while deciding cursor/outbox details. | `foundation specs/live-events-and-outbox.md` |
| Transcript storage | Start with a `TranscriptRepository` over existing files, then optionally mirror to SQLite. | `foundation specs/runtime-transcript-and-conversation-store.md` |
| Pending asks | Model pending action state separately; mailbox delivers references and handles delivery lifecycle. | `foundation specs/mailbox-and-pending-interactions.md` |
| Mailbox recipient identity | Use a typed union, not plain `(projectId, sessionId)` strings only. | `foundation specs/mailbox-and-pending-interactions.md` |
| Orchestrator-turn ack | Pick one first acceptance point, likely queued in the app send service, then add stronger observed-JSONL ack later if needed. | `foundation specs/mailbox-and-pending-interactions.md` and runtime transcript spec |
| Workflow `human-review` | Disable/reject as unsupported until mailbox-backed UI inbox exists, or explicitly make the inbox part of the workflow phase. | workflow phase and mailbox spec |
| MCP service access | Use typed localhost HTTP client first because MCP is a separate process; app services sit behind server routes. | `foundation specs/shared-contracts-and-app-services.md` |
| Agent host policy | Keep host optional until agent-run service contracts define host-backed and in-process recovery separately. | agent-run phase |

## 9. Build-Readiness Gate for Any Slice

Implementation should not begin for a slice until it has:

- an owning roadmap phase;
- explicit contracts or a documented compatibility contract;
- current-state evidence from code;
- migration and rollback steps;
- a test plan, including characterization tests where behavior is risky;
- a tracker update marking the artifact or slice `planned`;
- explicit user confirmation to build.

## 10. Next Planning Artifacts

Create the remaining planning artifacts in this order:

1. `refactor plan/foundation specs/shared-contracts-and-app-services.md`
2. `refactor plan/foundation specs/live-events-and-outbox.md`
3. `refactor plan/foundation specs/mailbox-and-pending-interactions.md`
4. `refactor plan/foundation specs/runtime-transcript-and-conversation-store.md`
5. `refactor plan/refactor plan docs/work-items-stages-fields-attachments.md`
6. `refactor plan/phase-0-test-characterization-plan.md`
7. `refactor plan/build-slices/001-foundation-vertical-slice.md`

After those are complete, implementation can start only when the user explicitly asks to build.
