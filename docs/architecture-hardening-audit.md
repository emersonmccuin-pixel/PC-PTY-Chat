# Architecture Hardening Audit

Purpose: after the architecture refactor lands, run a careful subsystem-by-subsystem audit so Caisson becomes understandable, testable, and solid instead of an accumulation of overlapping experiments.

This is not a rewrite plan. It is a disciplined cleanup and verification program.

## Why This Exists

Caisson has grown through fast iteration, changing goals, and multiple agents working in overlapping parts of the codebase. That creates predictable risk:

- duplicate adapters and helper layers;
- old dead code left behind after product decisions changed;
- partially replaced systems still wired to UI or MCP surfaces;
- inconsistent contracts between web, server, domain, DB, runtime, MCP, and workflows;
- silent failure paths that only show up during real use;
- tests that cover internals but miss full user workflows.

The audit goal is to make each subsystem explicit:

- what it owns;
- what it depends on;
- what depends on it;
- what workflows it must support;
- what can be deleted;
- what must be tested before deeper rebuilds.

## Operating Rules

- Work one pod at a time.
- Read and map before changing code.
- Do not run broad refactors during discovery.
- Do not let multiple agents edit overlapping pods at the same time.
- Use separate worktrees or branches for parallel work.
- Every cleanup ends with verification and a short written record.
- Prefer deleting dead code over preserving compatibility that no caller uses.
- Prefer boundary tests over relying on memory or comments.
- Do not replace hard-won runtime primitives unless a trace proves the current behavior is wrong.

## Audit Pods

Use these as the first pass. Split or merge pods only after inventory proves the boundary is wrong.

| Pod | Main areas | First questions |
|---|---|---|
| Project lifecycle | project create/list/update/delete, worktrees, folder reveal, scaffold cleanup | Are project state, filesystem state, and worktree state consistent? |
| Chat/runtime/WebSocket | orchestrator session, replay, heartbeat, send queue, terminal transcript | Can we trace every user prompt from composer to JSONL confirmation? |
| Terminal/PTY | raw terminal mode, resize, writability, PTY lifecycle | Is raw input gated by truthful runtime state everywhere? |
| Transient sessions | agent designer, workflow builder, setup wizard | Can one shared adapter own start snapshots, state, raw events, JSONL, asks, and cleanup? |
| Agents/pods/catalog/MCP | pod records, stock pods, MCP tools, tool catalog, allowlists | Are tool lifecycle states explicit and drift-tested? |
| Agent runs/transcripts | dispatch, active registry, pending asks, transcript modal, JSONL backfill | Does the UI distinguish active, historical, empty, failed, and missing transcript states? |
| Work items/stages/fields | work item CRUD, Kanban, initiatives, field schemas, attachments | Are stage moves, schema validation, and version conflicts consistent across UI/API/MCP? |
| Workflows/builder/visualizer | workflow rows, v2 compatibility, builder chat, graph UI, run review | Are workflow definitions, runs, drafts, and UI graph state using one contract? |
| Files/project context/settings | file browser, preview, memory, commands, settings, onboarding | Are filesystem paths contained, validated, and consistently surfaced? |
| Desktop/dev controls | Electron shell, dev status, reload/restart controls, dogfood assumptions | Are destructive controls explicit and isolated from ordinary app use? |

## Per-Pod Checklist

For each pod, produce a short audit file under `docs/pods/<pod-name>.md`.

Required sections:

1. Ownership
   - Files and modules.
   - Public entry points.
   - DB tables or persisted files.
   - WebSocket/event envelopes.
   - MCP tools or workflow hooks.

2. User Workflows
   - Create/start.
   - Read/list/open.
   - Update/send/continue.
   - Stop/delete/restore.
   - Error and empty states.
   - Reload/reconnect/resume behavior.

3. Dependency Map
   - What this pod imports.
   - What imports this pod.
   - Cross-pod calls that should become contracts.
   - Duplicate adapters or protocol translations.

4. Dead Code And Drift
   - Unused files, routes, components, tools, types, DB columns, migrations, docs.
   - Old feature names that should no longer appear in live code.
   - Compatibility shims that can be deleted.
   - Divergent type definitions.

5. Tests And Gaps
   - Existing tests that protect the pod.
   - Missing workflow tests.
   - Missing boundary/drift tests.
   - Manual smoke checks still required.

6. Cleanup Plan
   - Safe deletes.
   - Low-risk extractions.
   - Contract tests to add before bigger changes.
   - Work that must wait for product decisions.

7. Completion Criteria
   - Exact commands run.
   - Manual workflow checks run.
   - Open risks left behind.

## First Deliverables

Start with documentation and maps, not code changes.

1. `docs/system-map.md`
   - package/layer map;
   - route groups;
   - web feature map;
   - event/WebSocket surfaces;
   - MCP tool families;
   - DB repo/table map.

2. `docs/pods/index.md`
   - pod list;
   - status for each pod: `not-started`, `mapped`, `auditing`, `cleanup-ready`, `complete`;
   - owner/worktree/branch if multiple agents are active.

3. First full pod audit
   - recommended: `chat-runtime-websocket`;
   - reason: highest product risk and most cross-layer behavior.

## Recommended First Pod: Chat Runtime WebSocket

Start here after the refactor merge.

Trace these flows end to end:

- app opens project and receives current runtime snapshot;
- WebSocket connects, heartbeats, misses heartbeat, reconnects;
- replay restores prior session events;
- user prompt gets client id, pending prompt, server ack, queue status, PTY write, JSONL user echo, turn end;
- queued prompt waits through busy/spawning and drains later;
- terminal mode receives raw events and sends gated raw input;
- session switch/new/resume updates replay, queue, JSONL cursor, and UI state;
- agent transcript modal opens active and historical runs.

Add or verify tests for:

- replay high-water and dedupe;
- send queue delivery and confirmation;
- heartbeat timeout and reconnect;
- terminal writability gates;
- pending prompt confirmation;
- transcript backfill and live merge;
- boundary tests preventing UI renderers from owning transport.

## AI Agent Workflow

Use this loop for each pod:

1. Inventory
   - Read files.
   - List entry points.
   - Generate a dependency graph with `rg` and focused scripts.

2. Audit
   - Write the pod doc.
   - Identify dead code and contract drift.
   - Identify test gaps.

3. Plan
   - Pick the smallest safe cleanup.
   - Name verification commands first.

4. Patch
   - Keep behavior-preserving moves separate from behavior changes.
   - Commit small coherent slices.

5. Verify
   - Run focused tests.
   - Run relevant typechecks.
   - Run boundary/drift checks.

6. Record
   - Update the pod doc.
   - Note remaining risk.
   - Link commits.

## Parallel-Agent Safety

Do not repeat the earlier overlapping-agent failure mode.

Rules:

- One active pod per worktree.
- One agent owns a pod at a time.
- If two pods touch the same file, stop and coordinate before editing.
- Use `git worktree list --porcelain` before starting.
- Start each session with `git status --short --branch`.
- Never merge another agent's work while they are still editing.
- Leave a handoff when stopping mid-pod.

## Kickoff Prompt

Use this after the refactor is merged:

```text
We are starting the Architecture Hardening Audit.

Read:
docs/architecture-hardening-audit.md
docs/architecture-refactor-plan.md
docs/chat-system-contract.md
AGENTS.md
CLAUDE.md

Do not start with code changes.
First create docs/system-map.md and docs/pods/index.md.
Then begin the first pod audit for chat-runtime-websocket.
Work one pod at a time, document findings, and add tests before cleanup.
Do not restart the app, dev server, dogfood app, Vite, channel server, or POST /api/dev/restart.
```
