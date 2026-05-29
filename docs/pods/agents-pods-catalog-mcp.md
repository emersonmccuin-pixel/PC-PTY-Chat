# Agents Pods Catalog MCP Pod Audit

Status: auditing.

Owner: Codex.

Worktree: `E:\Claude Code Projects\Personal\PC-PTY-Chat-phase5`.

Branch: `codex/phase-5-hardening`.

## Ownership

Server route modules:

- `apps/server/src/routes/pod-routes.ts`: HTTP CRUD for pods, knowledge rows, secrets, MCP servers, audit listing, promotion, clone, stock reset, and `pod-changed` broadcasts.

Server services:

- `apps/server/src/services/stock-pod-seed.ts`: stock specialist content and boot-time seed roster.
- `apps/server/src/services/orchestrator-pod-seed.ts`: orchestrator pod seed wrapper.
- `apps/server/src/services/pod-seed-with-drift.ts`: insert or drift-reseed helper for stock pods.
- `apps/server/src/services/pod-drift.ts`: live stock-pod drift detection and canonical stock-name roster.
- `apps/server/src/services/stock-pod-reset.ts`: reset stock scalar fields to canonical seeded content.
- `apps/server/src/services/pod-spawn.ts`: project-first pod resolution, runtime bundle preparation, prompt variables, materializer options, and spawn prep result.
- `apps/server/src/services/pod-tool-catalog.ts`: live `pc-rig` tool name list used for wildcard expansion.
- `apps/server/src/services/pod-variable-renderers.ts`: DB-backed prompt variable rendering such as available agents.
- `apps/server/src/services/agent-run-factory.ts`: dispatch paths that validate pod existence, call `preparePodSpawn`, compute pod revisions, and pass materialized runtime files into agent runs.

DB/domain modules:

- `packages/db/src/repos/pods.ts`: agent, knowledge, secret, MCP server CRUD; audit-on-mutate; project-first dispatch resolution; spawn bundle loading.
- `packages/db/src/repos/pod-audit.ts`: audit row builder and newest-first audit listing.
- `packages/db/src/repos/pod-revision.ts`: pod revision string for dispatch/resume drift checks.
- `packages/domain/src/tool-catalog.ts`: product metadata for Claude built-ins, `pc-rig` MCP tools, and required agent tools.

Runtime modules:

- `packages/runtime/src/pod-materializer.ts`: plugin agent rendering, tool wildcard expansion, required-tool merge, knowledge footer, MCP config merge/filtering, prompt variable substitution, and secret env-var map.

MCP modules:

- `packages/mcp/src/tools/agents.ts`: `pc_*` pod management tool metadata and HTTP-backed handlers for pod, knowledge, secret, MCP server, and audit operations.
- `packages/mcp/src/tools/index.ts`: tool family re-export.
- `packages/mcp/src/server.ts`: composed MCP server entry point.

Web modules:

- `apps/web/src/features/agents/client.ts`: HTTP client for pod list/bundle/create/promote/clone/reset/patch/delete, knowledge CRUD, secret CRUD, MCP server CRUD, and audit list.
- `apps/web/src/features/agents/types.ts`: browser-side pod, bundle, audit, secret, knowledge, and MCP config contracts.
- `apps/web/src/hooks/use-project-pods.ts`: project pod list fetch and `pod-changed` refetch.
- `apps/web/src/components/AgentsList.tsx`: project Agents tab list/detail surface, create modal, stock read-only routing, promote/delete actions.
- `apps/web/src/components/agents/CreatePodModal.tsx`: manual and conversational project-pod creation surface.
- `apps/web/src/components/agents/PodDetailModal.tsx`: prompt/settings/context/secrets/history modal shell and scalar draft save.
- `apps/web/src/components/agents/ContextTab.tsx`: knowledge add/edit/delete UI.
- `apps/web/src/components/agents/SecretsTab.tsx`: secret add/delete UI with no value readback.
- `apps/web/src/components/agents/SettingsTab.tsx`: scalar settings editor and MCP server add/delete UI.
- `apps/web/src/components/agents/HistoryTab.tsx`: audit history rendering.

Public entry points:

- HTTP: `GET /api/agents/pods`.
- HTTP: `GET /api/agents/pods/:id`.
- HTTP: `GET /api/agents/pods/:id/audit`.
- HTTP: `POST /api/agents/pods`.
- HTTP: `POST /api/agents/pods/:id/promote-to-global`.
- HTTP: `POST /api/agents/pods/:id/clone-to-project`.
- HTTP: `POST /api/agents/pods/:id/reset-to-default`.
- HTTP: `POST /api/agents/pods/reset-all-stock-to-default`.
- HTTP: `PATCH /api/agents/pods/:id`.
- HTTP: `DELETE /api/agents/pods/:id`.
- HTTP: `POST /api/agents/pods/:id/knowledge`.
- HTTP: `GET /api/agents/pods/:id/knowledge/:knowledgeId`.
- HTTP: `PATCH /api/agents/pods/:id/knowledge/:knowledgeId`.
- HTTP: `DELETE /api/agents/pods/:id/knowledge/:knowledgeId`.
- HTTP: `POST /api/agents/pods/:id/secrets`.
- HTTP: `DELETE /api/agents/pods/:id/secrets/:secretId`.
- HTTP: `POST /api/agents/pods/:id/mcp-servers`.
- HTTP: `DELETE /api/agents/pods/:id/mcp-servers/:mcpId`.
- WebSocket outbound: `pod-changed`.
- MCP: `pc_create_agent`, `pc_get_agent`, `pc_update_agent_prompt`, `pc_update_agent_settings`, `pc_delete_agent`, knowledge tools, secret tools, per-agent MCP server tools, `pc_list_agent_audit`, `pc_list_agents`.

Persisted data:

- SQLite tables: `agents`, `agent_knowledge`, `agent_secrets`, `agent_mcp_servers`, `agent_audit`.
- Per-spawn runtime files: `<scratchDir>/claude-plugin/agents/<pod>.md`, `<scratchDir>/claude-plugin/.claude-plugin/plugin.json`, `<scratchDir>/mcp.json`, and session-local settings files.

## User Workflows

Project agent creation:

1. User opens Agents tab and chooses Add agent.
2. Manual mode posts to `/api/agents/pods` with `scope: project` and the current project id.
3. Conversational mode starts the agent-designer transient session, whose MCP tools post through the same pod routes.
4. The server creates the pod row with audit actor/reason, merges required work-item tools, broadcasts `pod-changed`, and calls the optional pod-change hook.
5. Web refetches the project/global pod list through `useProjectPods`.

Pod detail editing:

1. User opens a project pod detail modal.
2. Prompt and scalar settings update through a single `PATCH /api/agents/pods/:id`.
3. Knowledge, secrets, and MCP servers use nested CRUD routes.
4. Each mutation writes an audit row in the same DB transaction as the data change.
5. Server broadcasts `pod-changed`; modal detail surfaces refetch bundle data.

Stock pod management:

1. Boot seed inserts or reseeds stock pods when untouched by user-authored audit rows.
2. List and detail routes annotate stock pods with `driftedFields`.
3. Stock delete returns 409 by `origin: stock`.
4. Reset endpoints restore stock scalar fields only; knowledge, secrets, and MCP servers stay user-owned.

Agent dispatch:

1. Agent-run factory resolves the requested pod project-first, then global.
2. `preparePodSpawn` loads the full spawn bundle and creates runtime baseline files.
3. Runtime materializer renders the plugin agent, expands `mcp__server__*` tool wildcards, merges required tools, appends knowledge/tool footers, writes `mcp.json`, and returns secret env vars.
4. Agent-run factory starts the agent with the materialized plugin, MCP config, settings, and env map.

MCP management:

1. MCP `pc_*` handlers validate tool args lightly and resolve pods by id or name.
2. Name resolution currently lists `/api/agents/pods` without a project query.
3. Mutating MCP tools call the same HTTP pod routes with `actor: orchestrator` and a reason tag.
4. Route validation and DB repo transactions remain the source of truth for persistence and audit behavior.

## Dependency Map

Imports into the pod:

- Server index registers pod routes and injects broadcasts, stock reset/drift deps, and restart-on-edit hook.
- Agent run factory and transient sessions depend on `preparePodSpawn`.
- Runtime materializer depends on domain tool catalog metadata and required-tool helpers.
- MCP agent tools depend on route contracts through HTTP client context.
- Web Agents tab depends on `agentsApi`, pod WebSocket envelopes, and project context.

Imports out of the pod:

- Agent runs consume pod definitions, revisions, materialized files, and per-pod secret env vars.
- Transient agent-designer creates project pods through the MCP route path.
- Workflows and orchestrator prompts rely on pod rosters and dispatch guidance.
- Activity/transcript surfaces display pod names from agent run rows.

Cross-pod calls that should stay explicit:

- Agent runs own dispatch lifecycle; pods own registry, materialization inputs, and revision source.
- Transient sessions own modal session transport; pods own agent-designer's created records.
- Work items own assignment contents; pods only guarantee the required work-item tool allowlist.
- Desktop/dev controls own restarts; pod edit hooks may request live-session behavior but this audit must not restart anything.

Duplicate adapters or protocol translations:

- Pod and bundle contracts are defined separately in server route types, domain DB row types, and web feature types.
- MCP `tools/agents.ts` contains repeated id/name resolution and HTTP error handling blocks for every pod tool.
- `SettingsTab` parses raw MCP config JSON locally, while `pod-routes.ts` performs the authoritative shape validation.
- Route-level audit body/query parsing is duplicated across scalar, knowledge, secret, MCP, reset, and delete handlers.

## Dead Code And Drift

- No safe deletes were proven during this initial pass.
- `resolvePodId` in MCP agent tools does not pass project context to `/api/agents/pods`, even though project-scoped pods are the default and `pc_list_agents` is project-aware through `ctx.projectPath('agents')`.
- The UI permits any comma-separated tool string and relies on materialization/catalog tests for later wildcard and `pc-rig` validation.
- Per-pod MCP config editing is add/delete only; no inline edit path exists.
- Secrets are intentionally plaintext in v1 and never read back through HTTP.
- Agent-run model display still has a separate fallback noted in the agent-runs pod; this pod owns the authored model field only.

## Tests And Gaps

Existing focused tests:

- `apps/server/test/pod-routes.test.ts`: pod CRUD, scope/project behavior, promote/clone/delete guards, stock delete, knowledge CRUD/read, secret no-readback, MCP server config validation, audit filters, actor/reason threading, and orchestrator-style flow.
- `apps/server/test/pod-drift.test.ts`: list drift annotations and reset-all stock behavior.
- `apps/server/test/pod-tool-catalog-drift.test.ts`: `pc-rig` live tool catalog parity, stock/orchestrator dead grants, and domain metadata coverage.
- `apps/server/test/stock-pod-seed.test.ts`: stock seed and reseed behavior.
- `apps/server/test/pod-spawn.test.ts`: pod spawn prep, plugin materialization, baseline MCP merge, secret env vars, wildcard expansion, knowledge footer, and cleanup.
- `apps/server/test/mcp-bridge-routes.test.ts`: MCP handshake/status routes adjacent to pod-dispatched agents.
- `apps/server/test/mcp-config-rewrite.test.ts`: dev/package MCP config rewrite behavior adjacent to baseline runtime config.

Missing tests or trace evidence:

- No test proves MCP `resolvePodId({ name })` can target project-scoped pods in the current project.
- No focused web test covers MCP server config JSON parsing/error copy in `SettingsTab`.
- No browser smoke verifies Agents tab list/detail/create/edit/knowledge/secret/MCP workflows.
- No test asserts route-level MCP server config parsing outside full `pod-routes.test.ts`.

## Cleanup Plan

Do not change pod dispatch, materialization, stock seed, or restart-on-edit semantics without a failing trace.

Small cleanup candidates:

- Extract a focused MCP config parser/normalizer from `pod-routes.ts` and cover it directly, then keep route behavior unchanged.
- Extract MCP agent-tool id/name resolution or repeated HTTP response handling only after adding a project-scoped name-resolution test.
- Add a web-side helper for MCP config JSON parsing if the UI error path becomes part of this cleanup.
- Keep stock seed content movement out of this pod pass; it is high-churn prompt data.

Verification commands to use before any cleanup patch:

- `pnpm --filter @pc/server exec tsx --test test/pod-routes.test.ts test/pod-drift.test.ts test/pod-tool-catalog-drift.test.ts test/stock-pod-seed.test.ts test/pod-spawn.test.ts test/mcp-bridge-routes.test.ts test/mcp-config-rewrite.test.ts`
- `pnpm --filter @pc/server typecheck`
- `pnpm --filter @pc/web typecheck`
- `git diff --check`

## Completion Criteria

Kickoff status:

- This pod audit file exists and maps ownership, workflows, dependencies, drift, tests, and cleanup candidates.
- Runtime behavior has not been changed.
- No app, dev server, dogfood app, Vite server, channel server, or restart endpoint has been touched.

Commands run so far:

- `git status --short --branch`
- `git worktree list --porcelain`
- `Get-Content docs/pods/index.md`
- `rg --files` and `rg -n` for pod, agent, catalog, MCP, stock, materializer, route, web, and test surfaces.
- `Get-Content` for DB pod repos, runtime materializer, pod spawn service, MCP agent tools, web Agents components, existing pod docs, and focused tests.
- `pnpm --filter @pc/server exec tsx --test test/pod-routes.test.ts test/pod-drift.test.ts test/pod-tool-catalog-drift.test.ts test/stock-pod-seed.test.ts test/pod-spawn.test.ts test/mcp-bridge-routes.test.ts test/mcp-config-rewrite.test.ts`
- `git diff --check`

Verification results:

- Focused agents/pods/catalog/MCP audit tests: 72 passed, 0 failed.
- Diff whitespace check: passed.

Manual workflow checks run:

- None. In-app Browser backend was unavailable earlier in this Phase 5 session: `iab`.

Open risks:

- Agents tab UI behavior remains source-audited only.
- MCP project-scoped name resolution needs a focused test before refactor.
- Per-pod MCP config UX is raw JSON and only source-audited in this pass.
