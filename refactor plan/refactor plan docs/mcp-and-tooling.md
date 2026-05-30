# MCP and Tooling Architecture Handoff

## 1. Executive Summary

- **Subsystem:** MCP bridge and MCP tools.
- **Verified behavior:** Caisson exposes a per-spawn stdio MCP server named `pc-rig`; Claude sessions call `pc_*` tools through `packages/mcp`, and most tool handlers forward to the Hono server over localhost HTTP.
- **Why it matters:** Tool availability determines what orchestrator, workflow-builder, and agent pods can actually do. Drift here breaks work-item edits, workflow authoring, agent dispatch, pending asks, and external MCP server access.
- **Current health:** Functional but high risk. Good pieces already exist: session-local MCP config, a prebuilt MCP bundle, handshake readiness gating, DB-backed pod tool allowlists, and a domain tool catalog. The risky part is split ownership across MCP schemas, HTTP route payloads, web DTOs, pod materialization, stock pod seeds, and runtime spawn readiness.
- **Recommendation:** Keep the stdio MCP adapter and isolated runtime config. Refactor MCP tools into adapters over shared contracts or a typed local API client, introduce a canonical capability registry, and route mutations through the same application-service path used by HTTP/UI.

## 2. Baseline

| Field | Value |
|---|---|
| Date | 2026-05-30 |
| Branch | `dev` |
| Commit | `d114fc2535c1116f6eb2d883f9cac2a9193a8254` |
| Codebase state | Current implementation only. The working tree is dirty with many pre-existing deleted tests/docs and untracked `refactor plan/`. |
| Assumed implemented recommendations from other docs | None. Prior subsystem docs are context only. |
| Excluded paths | `archive/` ignored entirely. |

Verified baseline notes:

- `packages/contracts` does not exist.
- Current code search outside `archive/`, `apps/server/data/`, and `node_modules/` found no `test` or `spec` files.
- A direct text comparison found 51 live `pc_*` tool definitions in `packages/mcp/src/tools/*` and 51 `pc-rig` entries in `packages/domain/src/tool-catalog.ts`, with no current missing or stale names. This parity is not covered by current tests because the relevant tests are deleted in the working tree.

## 3. Scope and Non-Goals

Included:

- `packages/mcp` stdio server, tool definitions, handlers, env-scoped tool context, heartbeat, and handshake POST.
- Server MCP bridge routes under `apps/server/src/features/mcp-bridge/routes.ts`.
- Runtime MCP config creation and Claude spawn wiring.
- Pod tool allowlists, wildcard expansion, external MCP server rows, and materialized agent prompts.
- Web surfaces that expose MCP status, tool labels, and per-pod MCP server config.
- Current integration with work items, agents, agent runs, workflows, project config, and pending asks.

Out of scope:

- Channel replacement design, except where MCP currently depends on Channel-adjacent runtime delivery.
- Deep workflow builder architecture. That subsystem is being handled separately.
- Implementation refactors in this planning pass.

Do not change casually:

- MCP server name `pc-rig`; it is embedded in slugs like `mcp__pc-rig__pc_get_work_item`.
- Existing `pc_*` tool names and rough text-result behavior during migration.
- Session-local `--mcp-config` plus `--strict-mcp-config` launch behavior.
- Env contracts: `PC_PROJECT_ID`, `PC_SESSION_ID`, `PC_AGENT_SESSION_ID`, `PC_AGENT_RUN_ID`, `PC_DISPATCHER_SESSION_ID`, and `PC_AGENT_INVOKE_DEPTH`.

## 4. Current System Trace

### Startup and tool registration

- `packages/mcp/src/server.ts` creates an MCP `Server` named `pc-rig`, exposes `ListToolsRequestSchema`, and dispatches `CallToolRequestSchema` through `handleWorkItemTool`, `handleAgentTool`, `handleWorkflowTool`, `handleProjectConfigTool`, and `handleAgentRunTool`.
- `TOOLS` in `packages/mcp/src/server.ts` is the live MCP tool list. `PC_RIG_TOOL_NAMES` derives fully qualified slugs from it.
- `apps/server/src/services/pod-tool-catalog.ts` re-exports `PC_RIG_TOOL_NAMES` from `@pc/mcp` for wildcard expansion.
- `packages/domain/src/tool-catalog.ts` separately stores friendly labels, descriptions, and `REQUIRED_AGENT_TOOLS`.
- `apps/server/src/index.ts` seeds stock pods with `seedStockPods()` at boot, then registers `registerMcpBridgeRoutes(...)`.

### Runtime MCP config flow

Normal flow:

```text
server creates or resumes a runtime session
  -> prepareClaudeRuntimeFiles renders session-local settings and baseline mcp.json
  -> preparePodSpawn resolves the DB pod and materializes a plugin agent
  -> materializePodPlugin writes plugin agent markdown and merged mcp.json
  -> LowLevelSpawn passes --mcp-config, --strict-mcp-config, --agent, --settings
  -> Claude starts pc-rig stdio MCP child
  -> pc-rig posts /api/internal/mcp-handshake after JSON-RPC initialized
  -> ReadyGate opens after MCP handshake plus composer-ready signals
```

Verified files and symbols:

- `apps/server/src/services/claude-runtime-bundle.ts::prepareClaudeRuntimeFiles` writes baseline MCP servers `pc-rig` and `webhook`.
- `apps/server/src/services/pod-spawn.ts::preparePodSpawn` resolves a pod with `getPodForSpawn(...)` and calls `materializePodPlugin(...)`.
- `packages/runtime/src/pod-materializer.ts::materializePodPlugin` writes a session-local plugin and `mcp.json`.
- `packages/runtime/src/pod-materializer.ts::expandToolWildcards` expands `mcp__<server>__*`; unknown server wildcards throw.
- `packages/runtime/src/pod-materializer.ts::collectReferencedMcpServers` supports filtering MCP config to referenced servers for dispatched agents.
- `packages/runtime/src/low-level-spawn.ts::buildLowLevelSpawnArgs` always adds `--mcp-config` and `--strict-mcp-config`.
- `packages/runtime/src/ready-gate.ts::ReadyGate` waits for MCP handshake, composer-ready, and optional init-complete signals.

### MCP server process flow

- `packages/mcp/src/server.ts` reads process env into `ToolContext`:
  - `PC_PROJECT_ID` scopes project routes.
  - `PC_SERVER_PORT` selects localhost Hono.
  - `PC_SESSION_ID` identifies orchestrator/transient sessions.
  - `PC_AGENT_RUN_ID` and `PC_DISPATCHER_SESSION_ID` identify dispatched-agent pause/continue calls.
- The process writes `mcp-status.json` under project data when `PC_PROJECT_ID` is set.
- `ListToolsRequestSchema` returns the full `TOOLS` array.
- `CallToolRequestSchema` passes arguments to family handlers.
- `ToolContext` in `packages/mcp/src/tools/context.ts` provides raw `GET`, `POST`, `PUT`, `PATCH`, and `DELETE` helpers over `node:http`.

### Tool handler flow

Verified current handlers:

| Tool family | File | Main server/API dependency |
|---|---|---|
| Work items | `packages/mcp/src/tools/work-items.ts` | `/api/projects/:projectId/work-items/*` |
| Agents/pods | `packages/mcp/src/tools/agents.ts` | `/api/agents/pods/*` and `/api/projects/:projectId/agents` |
| Agent runs/pending asks | `packages/mcp/src/tools/agent-runs.ts` | `/api/projects/:projectId/agents/:name/invoke`, `/agent-runs/*`, `/agent-pending-asks/*` |
| Workflows | `packages/mcp/src/tools/workflows.ts` | `/api/workflows/*`, `/api/projects/:projectId/workflow-builder/draft`, `/workflow-v2/review` |
| Project config | `packages/mcp/src/tools/project-config.ts` | `/api/projects/:projectId/stages`, `/field-schemas`, `/claude-md` |

Typical handler shape:

```text
MCP CallTool
  -> hand-written argument checks
  -> build HTTP path and payload
  -> raw localhost HTTP call
  -> return HTTP response body as text
  -> mark isError only on local validation, non-2xx, or transport error
```

### Tool availability and pod materialization

- Durable pod rows store `agents.tools` in `packages/db/src/schema.ts`. Empty tools are documented as "allow all"; non-empty lists are exact tool names with wildcard expansion at materialization.
- `packages/domain/src/tool-catalog.ts::REQUIRED_AGENT_TOOLS` forces every agent to have `pc_get_work_item`, `pc_update_work_item`, and `pc_attach_to_work_item`.
- `packages/db/src/repos/pods.ts` merges required tools on create/update.
- `packages/runtime/src/pod-materializer.ts` merges required tools again at spawn as a safety net.
- `agent_mcp_servers` stores per-pod external MCP server config. `apps/server/src/routes/pod-routes.ts` creates/deletes these rows.
- `apps/web/src/components/agents/SettingsTab.tsx` lets users edit a comma-separated tools allowlist and add MCP server config as raw JSON.

### Status and handshake flow

- `packages/mcp/src/server.ts` writes `mcp-status.json` heartbeat every 2 seconds while the MCP process is attached.
- `apps/server/src/features/mcp-bridge/routes.ts::GET /api/mcp-status` reads the heartbeat file and treats it as alive if `aliveAt` is newer than 8 seconds.
- `apps/web/src/components/StatusBar.tsx` polls `settingsApi.getMcpStatus(projectId)` every 5 seconds and renders the MCP panel.
- `packages/mcp/src/server.ts::server.oninitialized` posts `/api/internal/mcp-handshake` for spawned agent sessions.
- `registerMcpBridgeRoutes` routes the handshake to active agent runs, workflow subagent listeners, optional host client, or orchestrator runtime.

### Failure flow and edge cases

- If `PC_PROJECT_ID` is absent, project-scoped calls either throw through `ToolContext.projectPath(...)` or return tool-specific errors.
- If the server is unreachable, handlers catch `node:http` errors and return text `isError` results.
- If a pod uses an unknown `mcp__<server>__*` wildcard, `expandToolWildcards(...)` throws and pod materialization fails.
- If an unreferenced or bad MCP server remains in strict config, Claude can fail closed. Current agent dispatches set `filterMcpToReferencedTools: true`; orchestrator/transient sessions leave it false because they need the `webhook` server.
- MCP heartbeat/status is best-effort file state, not durable app state.
- MCP handshake routing uses current in-memory runtime/registry/listener state. If no owner matches, the route returns `{ ok: true, found: false }`.

## 5. Integration Map

### Inbound integrations

| Caller | Contract | Current behavior | Failure boundary |
|---|---|---|---|
| Claude MCP client | stdio MCP `ListTools` and `CallTool` | Calls `pc-rig` tools exposed by `packages/mcp` | Tool process dies or strict MCP config rejects server |
| Runtime spawn | session-local `mcp.json`, env vars, `--mcp-config` | Supplies pc-rig/webhook and per-pod MCP servers | Bad config blocks tool availability |
| Server runtime readiness | `/api/internal/mcp-handshake` | Unblocks active run/workflow/orchestrator ready gate | Missing in-memory owner yields `found: false` |
| Web status bar | `/api/mcp-status?projectId=` | Polls heartbeat JSON file | File missing/stale renders offline |
| Agents UI/MCP tools | `/api/agents/pods/*/mcp-servers` | Stores external MCP server config rows | No capability introspection before spawn |
| Stock pod seed | `STOCK_POD_CONTENT` tool arrays | Writes canonical stock tool allowlists to DB | Seed drift can affect many projects |

### Outbound integrations

| Target | Caller | Side effect |
|---|---|---|
| Hono HTTP API | `ToolContext` helpers | Reads/mutates work items, agents, workflows, project config, pending asks |
| SQLite repos | Server route handlers | Actual product state changes through route paths |
| Runtime files | `prepareClaudeRuntimeFiles`, `materializePodPlugin` | Writes session-local settings, plugin files, and `mcp.json` |
| WebSocket/live layer | Route side effects | MCP mutations indirectly broadcast legacy WS events through server routes/services |
| Agent runtime | `pc_ask_*`, `pc_answer_pending`, `pc_invoke_agent` | Pauses/resumes/dispatches via agent-run routes |
| Channel/webhook | baseline `webhook` MCP server | Orchestrator and channel bridge use dev-channel path during migration |

### Tight coupling and hidden dependencies

- `packages/mcp` is both the live MCP server and the source imported by `apps/server/src/services/pod-tool-catalog.ts`. The entry-point guard in `packages/mcp/src/server.ts` prevents server startup on import.
- Tool schemas are hand-written in MCP files and mirrored by server route validation and web DTOs.
- Runtime readiness depends on `pc-rig` successfully posting a handshake, but the handshake is not a durable event.
- Tool availability is spread across `TOOLS`, `PC_RIG_TOOL_NAMES`, `TOOL_CATALOG`, `agents.tools`, stock pod seeds, web labels, and materialized prompt footers.
- MCP status is computed from a file heartbeat, while runtime health is computed elsewhere.

## 6. Data and State Model

Owned by this subsystem:

- Live `pc-rig` tool list in `packages/mcp/src/server.ts::TOOLS`.
- Fully qualified tool slugs in `PC_RIG_TOOL_NAMES`.
- Best-effort heartbeat files at `<data>/projects/<projectId>/mcp-status.json`.
- Session-local generated files:
  - `<session or run dir>/claude-runtime/mcp.json`;
  - `<session or run dir>/claude-runtime/.claude/settings.json`;
  - `<session or run dir>/claude-plugin/agents/<name>.md`;
  - `<session or run dir>/mcp.json`.

Durable state it reads or mutates indirectly:

| State | Storage | Owner today |
|---|---|---|
| Pod tool allowlist | `agents.tools_json` | `packages/db` pod repo and route layer |
| External pod MCP config | `agent_mcp_servers.config_json` | `packages/db` pod repo and pod routes |
| Required work-item tools | `packages/domain/src/tool-catalog.ts` | Domain package, also used by DB/runtime |
| Work items/workflows/agent runs | SQLite tables | Server routes/repos called by MCP |
| Pending asks | `pending_asks` | Agent-run pause/resume services |
| MCP process readiness | In-memory ready gates and listener maps | Runtime process wrappers/server |

Cache and cleanup behavior:

- MCP status heartbeat is overwritten every 2 seconds and is not retained.
- `PodSpawnPrep.cleanup()` removes materialized plugin/settings/MCP runtime files best-effort.
- Workflow subagent handshakes use an in-memory listener map in `workflow-subagent-handshake.ts`.
- Active run handshakes depend on process-local active registries unless host mode owns the run.

Concurrency concerns:

- Tool calls are not idempotency-keyed at the MCP layer. Idempotency depends on underlying HTTP routes.
- MCP handlers return raw HTTP JSON text, so callers have no typed structured success/error contract.
- Bad external MCP server config is accepted by shape validation and can fail later during strict spawn.
- `agent_mcp_servers` has per-agent/per-scope unique server names, but no registry of discovered tools for those external servers.

## 7. Invariants and Compatibility Requirements

Must remain true during migration:

- `pc-rig` remains the MCP server name until every saved allowlist and prompt migrates.
- Current `pc_*` tool names remain callable through compatibility wrappers.
- `mcp__pc-rig__*` wildcard expansion continues to produce concrete tool names.
- Every dispatched agent keeps `pc_get_work_item`, `pc_update_work_item`, and `pc_attach_to_work_item`.
- Session-local MCP config stays outside the user's worktree.
- `--strict-mcp-config` remains compatible with filtered agent dispatch configs.
- Orchestrator sessions still load `webhook` where Channel bridge behavior depends on it.
- MCP status panel continues to work during migration, even if backed by a different source later.
- MCP tool mutations must continue to trigger the same UI state updates as the equivalent HTTP/UI mutation.

Compatibility constraints:

- Existing pod rows store raw tool slugs; a registry migration must preserve these strings or provide a lossless translation.
- External MCP server names are embedded in tool slugs as `mcp__<server>__<tool>`.
- Web UI currently stores a comma-separated allowlist string in settings forms.
- Current MCP responses are text content, usually raw HTTP JSON; changing to richer structured content needs compatibility.

## 8. Related Subsystem Docs

| Related subsystem | Current dependency verified in code | Recommendation in that doc | Assumed implemented? | Potential conflict | Coordination needed |
|---|---|---|---|---|---|
| WebSocket/event propagation | MCP mutations route through HTTP handlers that broadcast legacy events. | Add shared live contracts and durable outbox. | No | MCP should not emit its own UI event contract, but route side effects currently own best-effort broadcasts. | MCP command path must converge with app services that write outbox events. |
| Chat runtime and transcript UI | Orchestrator spawn loads `pc-rig`; `AskUserQuestion` and `pc_ask_*` produce chat-visible interactions. | Chat should be a view over durable runtime/session facts. | No | Pending asks may move to mailbox or pending-interactions while MCP tools currently call agent-run HTTP routes. | Decide pending ask ownership before changing `pc_ask_*` results. |
| Agents and agent runs | `pc_invoke_agent`, `pc_continue_agent`, `pc_ask_*`, `pc_answer_pending`, inspect, kill. | Add agent-run service boundary and shared contracts; replace Channel delivery with mailbox later. | No | MCP tool env/session identity must stay compatible with agent run lifecycle. | Move MCP agent-run tools after agent-run contracts exist. |

Expected coordination not yet available as a current doc:

| Subsystem | Current dependency verified in code | Coordination needed |
|---|---|---|
| Workflows and workflow builder | Workflow tools call `/api/workflows/*`, draft endpoints, review endpoints, and `pc_node_failed` is observed from JSONL by workflow subagent runtime. | Align workflow command contracts before moving `packages/mcp/src/tools/workflows.ts`. |
| Channel server replacement | Baseline MCP config includes `webhook`; orchestrator depends on it while Channel remains. | Decide whether mailbox removes the need for `webhook` in orchestrator MCP config. |
| Runtime host and PTY sessions | `LowLevelSpawn`, `InteractiveSession`, `AgentRun`, `ReadyGate`, and session files own readiness and MCP config handoff. | Keep runtime host as process owner, not product rule owner. |

This document assumes none of those recommendations are implemented unless verified in code.

## 9. Current Issues

| Severity | Issue | Evidence | Impact | Likely root cause | Suggested direction |
|---|---|---|---|---|---|
| High | MCP tools are a second hand-written API layer. | `ToolContext` does raw localhost HTTP; each handler hand-builds payloads and paths in `packages/mcp/src/tools/*.ts`; no `packages/contracts` exists. | Server, web, and MCP request/response shapes can drift; route behavior changes can silently break agents. | MCP grew as an adapter before shared contracts/application services existed. | Introduce shared contracts plus a typed local API client; migrate tool families one at a time. |
| High | Tool availability is split across several sources. | `TOOLS`, `PC_RIG_TOOL_NAMES`, `TOOL_CATALOG`, `agents.tools`, stock seeds, web `formatToolLabel`, and materializer footers all participate. | A tool can be callable but missing from UI labels/prompt descriptions, or allowed in DB but unavailable at runtime. | No canonical capability registry covering declaration, display, policy, and runtime materialization. | Create a capability registry that emits MCP definitions, UI metadata, prompt descriptions, and wildcard catalogs. |
| High | Current working tree has no executable tests for MCP/tooling. | `rg --files ... | rg "(test|spec)\\.(ts|tsx|js|mjs)$"` returned no files; `git status` shows deleted MCP/runtime/server tests. | Tool refactors would be high regression risk. | Planning checkout has removed tests. | Restore or recreate focused tests before changing behavior. |
| Medium | MCP readiness and status are best-effort projections, not durable app facts. | Heartbeat file in `packages/mcp/src/server.ts`; `/api/mcp-status` reads freshness; handshake route uses active registries/listener maps and returns `found:false` if unmatched. | UI diagnostics and spawn gates can be misleading after process restarts, stale files, or missed handshakes. | Runtime readiness and observability are implemented as side channels. | Move status/handshake diagnostics behind runtime service state and canonical live events while keeping file heartbeat as compatibility. |
| Medium | External MCP server config is raw and not capability-verified. | `SettingsTab` accepts raw JSON; `parsePodMcpServerConfig` validates only `{ command,args,env,url }` shape; materializer writes config later. | A bad config can break strict MCP config at spawn time; available external tools are unknown until runtime. | Per-pod MCP config is stored as config, not as tested capabilities. | Add validation/dry-run or discovery for external MCP servers; store discovered capabilities where possible. |
| Medium | MCP tool results are unstructured text wrappers around HTTP JSON. | Success paths often return `res.body`; errors return text plus `isError`. | Agents must parse arbitrary JSON-in-text; future clients cannot rely on typed result contracts. | MCP SDK content response was treated as final API surface. | Define result contracts and return structured MCP content where supported, with text compatibility. |
| Medium | MCP trust and scope are implicit. | Tool calls trust localhost `PC_SERVER_PORT`; cross-project `pc_create_work_item` can pass `targetProjectId`; no internal token/auth is present. | Acceptable for single-user local app, but unclear for multi-process or future multi-user packaging. | Local-only trust boundary is implicit, not a contract. | Document and enforce an internal auth/scope model before multi-user or remote MCP usage. |
| Low | Web display does not actually use the domain tool catalog. | `packages/domain/src/tool-catalog.ts` says the web UI is a consumer, but `AgentsList` imports `apps/web/src/lib/tool-labels.ts` instead. | UI labels can differ from canonical descriptions; less severe because current display is algorithmic. | Browser import path or contract package did not exist when catalog was added. | Expose browser-safe tool metadata from future contracts/capability package. |

## 10. First-Principles Design

Ideal responsibilities:

- **Capability registry:** Own every tool/capability name, source, description, risk level, runtime availability, wildcard expansion, and display metadata.
- **Contracts:** Own MCP input/output schemas and shared DTOs for commands/queries.
- **Application services:** Own product mutations and queries. HTTP, UI, and MCP call the same use cases.
- **MCP adapter:** Translate MCP `CallTool` into validated commands/queries and format results for Claude.
- **Runtime host:** Own process launch, generated `mcp.json`, readiness handshake, and spawn diagnostics.
- **External MCP config:** Own per-pod external server config plus capability discovery/verification.

Ideal command flow:

```text
MCP tool input
  -> shared contract validation
  -> application service or typed local API client
  -> repo transaction
  -> live/outbox event
  -> shared result DTO
  -> MCP text/structured response adapter
```

Ideal capability flow:

```text
capability registry
  -> MCP ListTools definitions
  -> pod allowlist picker
  -> wildcard expansion catalog
  -> materialized prompt tool appendix
  -> tests that assert all consumers agree
```

Fit into the existing app:

- Keep `packages/mcp` as the stdio process because Claude needs a separate MCP server.
- Keep localhost HTTP as the process-boundary transport until `packages/app-services` exists and is safe to import from MCP.
- Move tool declarations and contracts first; deeper service extraction can follow.
- Keep text compatibility for current agents while adding typed results behind helpers.

## 11. Target Architecture Alignment

| Target cartridge part | Current alignment | Gap |
|---|---|---|
| contracts | Missing | Tool schemas and response shapes are hand-written in MCP/server/web |
| domain | Partial | `TOOL_CATALOG` and required tools exist, but command rules live in route/tool handlers |
| db repo | Partial | Pod tools/MCP server config are durable; MCP itself owns no product repos |
| application service | Weak | MCP calls HTTP routes directly; no shared app-service boundary |
| HTTP route | Present | Routes duplicate validation and use-case logic with MCP |
| live events | Indirect | MCP mutations rely on route broadcasts; no outbox contract |
| web client/hooks | Partial | Web clients exist; tool metadata still hand-rendered |
| MCP adapter | Present | Adapter is too much of a second API implementation |
| tests | Absent in current tree | Need restore/rebuild coverage |

Cross-cutting target systems:

- **Shared contracts:** Not implemented.
- **Canonical live events:** Not implemented for MCP-originated mutations; they rely on route broadcasts.
- **Durable mailbox:** Not implemented; `pc_ask_*` and Channel-adjacent behavior need coordination with mailbox.
- **Runtime host boundary:** Partially aligned for process launch, but readiness/status are side-channel signals.
- **MCP adapter boundary:** Current shape conflicts with target because MCP builds payloads and error semantics itself.
- **UI fetch discipline:** Web mostly uses feature clients, but tool metadata is not shared from a browser-safe package.

Conflicts and uncertainties for synthesis:

- Whether MCP should call app services directly in-process or use a typed localhost client. Because MCP is a separate Claude-spawned process, typed HTTP is the safer first step.
- Whether mailbox owns `pc_ask_*` and `pc_answer_pending`, or agent-run pending asks stay separate.
- Whether `webhook` remains in orchestrator MCP config after Channel replacement.
- Where the canonical capability registry should live: `packages/contracts`, `packages/domain`, or a new package.

## 12. Recommended Target Architecture

Keep:

- `packages/mcp` stdio server process.
- `pc-rig` server name and existing `pc_*` tool names as compatibility.
- Session-local MCP/runtime files from `prepareClaudeRuntimeFiles` and `materializePodPlugin`.
- `ReadyGate` handshake concept.
- Durable pod tables: `agents.tools_json`, `agent_mcp_servers`, `agent_secrets`, and audit rows.

Refactor:

- Move tool declarations to a canonical capability registry that can generate:
  - MCP `ListTools` definitions;
  - fully qualified `mcp__pc-rig__*` slugs;
  - UI labels/descriptions;
  - materializer descriptions;
  - drift tests.
- Create shared contracts for one low-risk tool family first, likely project config or work items.
- Replace raw `ToolContext` response handling with a typed API client helper that decodes `{ ok, ... }` and typed errors.
- Move route/tool command logic into application services as those boundaries are introduced.
- Add explicit runtime diagnostics for MCP process, handshake, and ready gate state.

Replace later:

- Replace heartbeat-file-only status with runtime-owned status rows or snapshots plus live updates.
- Replace raw JSON external MCP server entry UI with structured config and optional capability discovery.
- Replace Channel/webhook dependency when mailbox owns delivery.

Decisions for holistic synthesis:

- Final package home for contracts/capabilities.
- Mailbox ownership of agent/orchestrator ask tools.
- Runtime status storage and live-event semantics.
- External MCP discovery and trust policy.

## 13. Migration Strategy

| Phase | Goal | Files likely affected | Dependencies | Risks | Verification | Rollback | Restart/reload |
|---|---|---|---|---|---|---|---|
| 0 | Restore focused tests and current-behavior inventory. | `packages/mcp/test/*`, `apps/server/test/mcp-*`, `packages/runtime/test/pod-materializer*`, `ready-gate*` | None | Dirty tree may hide prior harness assumptions | Tool list parity, handler HTTP calls, materializer expansion tests | Tests only | No app restart |
| 1 | Add capability registry without behavior change. | New `packages/contracts` or domain module, `packages/mcp/src/server.ts`, `packages/domain/src/tool-catalog.ts`, web labels | Phase 0 preferred | Import cycles from server importing MCP | Typecheck and parity tests | Keep old constants as adapters | Build/reload only |
| 2 | Introduce typed local API client for MCP. | `packages/mcp/src/tools/context.ts`, one tool family | Shared DTOs for chosen family | Error wording changes | Unit tests with fake HTTP server/context | Keep raw helper fallback | No runtime restart for tests; server reload when implemented |
| 3 | Migrate one low-risk tool family to shared contracts. | `project-config.ts` or `work-items.ts`, server routes/contracts | Contract package | Route/MCP drift exposed | Contract round-trip tests | Re-export old schemas | Server/MCP bundle reload |
| 4 | Move pod tool metadata to registry consumers. | `pod-materializer.ts`, `SettingsTab`, `AgentsList`, stock seeds | Capability registry | Existing stored slugs must remain valid | Spawn materializer tests and UI typecheck | Keep `formatToolLabel` fallback | Web reload/MCP rebuild |
| 5 | Harden external MCP server config. | `pod-routes.ts`, `pod-mcp-config.ts`, agents UI, materializer | Product decision on validation depth | Could reject configs users rely on | Validation tests plus manual bad-config spawn | Warn-only mode first | Server/web reload |
| 6 | Normalize MCP status/readiness diagnostics. | `mcp-bridge/routes.ts`, `ReadyGate`, runtime snapshots, StatusBar | Live-event/statusline decisions | Spawn gating regressions | Handshake found/not-found tests, status UI tests | Keep file heartbeat compatibility | Server/web reload |
| 7 | Route MCP commands through app services/outbox. | Tool handlers, server routes, future app services | App-service package and live outbox | Broad behavioral surface | Integration: MCP command -> DB -> live event -> UI | Keep typed HTTP route adapter | Server/MCP reload, DB migration if outbox |

## 14. Acceptance Criteria

Functional:

- All existing `pc_*` tools remain listed and callable.
- Existing pod allowlists and `mcp__pc-rig__*` wildcard rows still materialize to concrete tools.
- Work item, workflow, agent, pending ask, and project-config MCP calls produce the same product mutations as equivalent UI/HTTP actions.
- Dispatched agents still receive required work-item tools.
- Orchestrator and workflow-builder still spawn with their current tool surfaces.

Integration:

- MCP, server routes, and web clients share contracts for migrated tool families.
- Tool registry metadata drives MCP list output, UI display, and materializer prompt descriptions.
- MCP-originated mutations emit the same canonical live events as UI-originated mutations after live-event migration.
- External MCP server config is scoped per pod and does not leak secrets into audit/UI responses.

Regression:

- Bad MCP config does not silently remove all `pc-rig` tools.
- Handshake missed/not-found cases remain visible in diagnostics.
- Rebuild of `packages/mcp/dist/server.mjs` is required and verified when MCP source changes.
- Existing text result compatibility remains for old prompts/agents.

Observability/debuggability:

- MCP status shows process pid, last heartbeat, tool count, handshake state, and last failure cause where possible.
- Spawn diagnostics distinguish MCP process not started, MCP handshake missing, composer not ready, and bad strict config.
- Tool handler errors expose typed causes without leaking secret values.

## 15. Test Plan

Existing tests in current working tree:

- None found outside `archive/`, `apps/server/data/`, and `node_modules/`.
- `git status` shows deleted tests that previously covered MCP tools, MCP bridge routes, MCP config rewrite, pod materializer, ready gate, and pod tool catalog drift.

Required unit tests:

- `packages/mcp`:
  - `TOOLS` includes every exported family tool exactly once.
  - MCP tool input schemas match shared contracts.
  - each handler maps validation, 2xx, non-2xx, and transport errors correctly.
- Capability registry:
  - live tools, fully qualified slugs, UI metadata, and materializer descriptions are in parity.
  - wildcard expansion rejects unknown servers and dedupes known tools.
- Runtime materializer:
  - required work-item tools are always present.
  - filtered agent MCP config keeps referenced servers and drops unreferenced `webhook`.
  - external MCP server config merges over baseline by server name.
- MCP bridge:
  - `/api/mcp-status` alive/stale/malformed cases.
  - `/api/internal/mcp-handshake` routes to active run, workflow listener, host, orchestrator, and not-found.

Required integration tests:

- MCP `pc_create_work_item` -> server route -> DB row -> live event/broadcast.
- MCP `pc_invoke_agent` -> agent run row -> materialized mcp config -> handshake -> running.
- `pc_ask_orchestrator` / `pc_answer_pending` around paused run state.
- Workflow-builder `pc_save_workflow_draft` and `pc_publish_workflow` against current routes.
- Bad external MCP server config behavior under `--strict-mcp-config`.

Manual verification:

- Start an orchestrator session and confirm `/mcp` status shows `pc-rig` online with expected tool count.
- Dispatch a stock agent and confirm it can call `pc_get_work_item`.
- Add a per-pod MCP server config, dispatch the pod, and confirm the config appears in generated `mcp.json`.
- Use workflow-builder and confirm draft/save/publish tools update the UI.
- Stop/restart nothing during planning; implementation agents can test after code changes in a controlled run.

Hard-to-test areas:

- Claude Code MCP client initialization timing.
- Strict MCP config failure modes for third-party MCP servers.
- Packaged Electron node-launcher behavior.
- Server crash between MCP command HTTP success and live event broadcast until outbox exists.

## 16. Implementation Notes for Next Agent

Recommended starting point:

1. Restore or recreate focused MCP/tooling tests before editing behavior.
2. Inventory all `pc_*` tool names and route payloads into a contract table.
3. Build a small typed helper around `ToolContext` before changing every handler.
4. Migrate one low-risk family before touching agent-run or workflow tools.

Risky files to inspect before editing:

- `packages/mcp/src/server.ts`
- `packages/mcp/src/tools/context.ts`
- `packages/mcp/src/tools/work-items.ts`
- `packages/mcp/src/tools/agent-runs.ts`
- `packages/mcp/src/tools/agents.ts`
- `packages/mcp/src/tools/workflows.ts`
- `apps/server/src/features/mcp-bridge/routes.ts`
- `apps/server/src/services/claude-runtime-bundle.ts`
- `apps/server/src/services/pod-spawn.ts`
- `packages/runtime/src/pod-materializer.ts`
- `packages/runtime/src/ready-gate.ts`
- `packages/runtime/src/low-level-spawn.ts`
- `apps/server/src/routes/pod-routes.ts`
- `packages/domain/src/tool-catalog.ts`

Existing patterns to follow:

- Session-local runtime files in `prepareClaudeRuntimeFiles`.
- Entry-point guard in `packages/mcp/src/server.ts` that prevents imports from starting the stdio server.
- Required-tool merge in `mergeRequiredAgentTools`.
- `parsePodMcpServerConfig` for boundary validation, but broaden it only through contracts.

Things to avoid:

- Do not add more hand-written route payload variants in MCP without contracts.
- Do not rename `pc-rig` or `pc_*` tools without a compatibility layer.
- Do not make MCP emit independent live-event shapes.
- Do not store external MCP secret values in audit or web DTOs.
- Do not move MCP directly onto DB repos while it is still a separate Claude-spawned process unless the process boundary decision is made explicitly.

## 17. Handoff Metadata

| Field | Value |
|---|---|
| Subsystem | MCP and tooling |
| Primary owner area | `packages/mcp`, `apps/server/src/features/mcp-bridge`, `apps/server/src/services/pod-*`, `packages/runtime/src/pod-materializer.ts`, `packages/domain/src/tool-catalog.ts`, `apps/web/src/components/agents` |
| Runtime process | Server process, per-spawn `pc-rig` MCP child, Claude/PTY child, renderer status UI |
| Owns state | Live MCP tool list, MCP heartbeat file, generated session-local MCP config, pod tool materialization logic |
| Reads state from | Env vars, pod tables, project data dirs, active run registries, workflow handshake listeners, server HTTP APIs |
| Writes state to | Localhost HTTP API, `mcp-status.json`, generated `mcp.json`, plugin/settings files, indirectly SQLite through routes |
| Inbound contracts | MCP stdio ListTools/CallTool, `/api/mcp-status`, `/api/internal/mcp-handshake`, pod tool allowlists |
| Outbound contracts | Hono HTTP routes, runtime spawn args/env, materialized Claude plugin files, web status panel |
| Hard dependencies | Claude MCP client, Hono server, `node:http`, runtime spawn, SQLite-backed pod registry, `@modelcontextprotocol/sdk` |
| Soft dependencies | Channel/webhook, StatusBar UI, stock pod seeds, workflow builder, agent host |
| Restart required for implementation changes | MCP bundle rebuild/restart for `packages/mcp`; server reload for routes/runtime; web reload for UI; DB migration if contracts add tables |
| Migration risk | High |
| Target architecture status | Refactor/split; keep stdio adapter and session-local config, split contracts/capability registry/app-service adapter |
| Related docs consulted | `ui-refresh-websocket-event-propagation.md`, `chat-runtime-and-transcript-ui.md`, `agents-and-agent-runs.md`, target architecture, handoff prompt, tracker |

## 18. Tracker Update

Update `refactor plan/refactor-tracker.md`:

- Set `MCP bridge and MCP tools` to `needs synthesis`.
- Baseline branch: `dev`.
- Baseline commit: `d114fc2535c1116f6eb2d883f9cac2a9193a8254`.
- Owner area: `packages/mcp`, `apps/server`, `packages/runtime`, `packages/domain`, `packages/db`, `apps/web`.
- Runtime process: `Server/MCP child/Claude runtime/renderer`.
- Migration risk: `high`.
- Target recommendation: `refactor/split; keep pc-rig stdio adapter and session-local mcp config; add shared contracts, typed local client, canonical capability registry, and app-service command/query path`.
- Key dependencies: `Agents/pods, agent runs, workflows, work items, runtime host, WebSocket/live events, Channel/mailbox, database`.
- Open questions:
  - Where should the canonical capability registry live?
  - Should MCP call app services directly or through a typed localhost client?
  - Which subsystem owns `pc_ask_*` after mailbox/pending-interactions migration?
  - How should external MCP server capabilities be discovered and validated?
  - Does Channel replacement remove the orchestrator `webhook` MCP server?

No newly discovered standalone subsystem row is required yet; capability registry can be tracked inside MCP/tooling unless synthesis splits it out.

## 19. Open Questions

Blocking or near-blocking:

- Where should the shared tool/capability registry live so it is browser-safe, MCP-safe, and runtime-safe?
- Should the first implementation target a typed localhost client or wait for `packages/app-services`?
- How should `pc_ask_orchestrator`, `pc_ask_user`, `pc_request_approval`, and `pc_answer_pending` map to the future mailbox or pending-interactions model?

Non-blocking but important:

- Should MCP heartbeat/status remain file-backed as a compatibility layer after runtime snapshots exist?
- Should external MCP server config support capability discovery before a pod can select `mcp__server__*`?
- Should MCP responses move to structured content while retaining text JSON for older prompts?
- Should project-scoped cross-project MCP writes require an explicit capability or approval?

Builder-discretion decisions:

- Exact helper names for typed MCP HTTP client.
- Whether registry migration starts in `packages/domain` or a new `packages/contracts`.
- Which low-risk tool family migrates first, as long as agent-run/workflow tools wait for their subsystem contracts.
