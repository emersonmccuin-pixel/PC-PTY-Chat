# Agent Runs And Transcripts Pod Audit

Status: auditing.

Owner: Codex.

Worktree: `E:\Claude Code Projects\Personal\PC-PTY-Chat-phase5`.

Branch: `codex/phase-5-hardening`.

## Ownership

Server modules:

- `apps/server/src/features/agent-runs/routes.ts`: HTTP routes for active runs, transcript backfill, invoke, continue, list-by-dispatcher, pending asks, answer, and cancel.
- `apps/server/src/services/agent-run-factory.ts`: dispatch construction, AgentRun lifecycle wiring, DB row transitions, channel delivery, project broadcast envelopes, verification, transcript paths.
- `apps/server/src/services/agent-active-runs.ts`: in-memory active run registry used for cancel.
- `apps/server/src/services/pause-resume.ts`: pending ask persistence, answer/cancel transitions, resume behavior.
- `apps/server/src/services/agent-audit.ts`: invoke audit record hook.
- `apps/server/src/services/invoke-depth.ts`: nested invoke guard.
- `packages/runtime/src/agent-run.ts`: AgentRun runtime wrapper and state machine.
- `packages/runtime/src/agent-run-registry.ts`: runtime-side active registry primitive.
- `packages/runtime/src/agent-run-jsonl-tailer.ts`: canonical agent JSONL parser and live tailer.

DB/domain modules:

- `packages/db/src/schema-agent-system.ts`: `agentRuns` and agent-system adjacent tables.
- `packages/db/src/repos/agent-runs.ts`: agent run rows, active list, dispatcher list, terminal transition helpers.
- `packages/db/src/repos/pending-asks.ts`: pending ask rows and atomic status transitions.
- `packages/domain/src/agent-system.ts`: agent run/broadcast domain contracts.
- `packages/domain/src/agent-comms.ts`: pending ask tool contracts.

Web modules:

- `apps/web/src/features/agent-runs/client.ts`: HTTP client for active runs, transcript backfill, pending asks, answer/cancel.
- `apps/web/src/hooks/use-project-agent-runs.ts`: active-run list plus `agent-run-changed` delta merge.
- `apps/web/src/components/ActivityPanel.tsx`: running/failed agent run cards, cancel, transcript open action.
- `apps/web/src/components/AgentTranscriptModal.tsx`: backfill plus live transcript merge and render.
- `apps/web/src/store/agent-transcript.ts`: Shell-level transcript modal mount state.
- `apps/web/src/components/Shell.tsx`: derives the modal run record from active runs or latest `agent-run-changed` envelope.
- `apps/web/src/features/chat/AgentWorkflowBubbles.tsx`: transcript links from chat workflow/agent bubbles.

Public entry points:

- HTTP: `GET /api/projects/:projectId/agent-runs`.
- HTTP: `GET /api/projects/:projectId/agent-runs/:runId/events`.
- HTTP: `POST /api/projects/:projectId/agent-runs/:runId/cancel`.
- HTTP: `POST /api/projects/:projectId/agents/:name/invoke`.
- HTTP: `POST /api/projects/:projectId/agent-runs/:runId/continue`.
- HTTP: `GET /api/projects/:projectId/agent-runs/by-dispatcher`.
- HTTP: `POST /api/projects/:projectId/agent-pending-asks`.
- HTTP: `POST /api/projects/:projectId/agent-pending-asks/:askId/answer`.
- HTTP: `POST /api/projects/:projectId/agent-pending-asks/:askId/cancel`.
- WebSocket: `agent-run-changed`.
- WebSocket: `agent-jsonl-event`.

Persisted files:

- Provider JSONL from `jsonlPathFor(project.folderPath, agentRun.ccSessionId)`.
- `<dataDir>/projects/<projectId>/agent-runs-v2/<runId>/transcript.log` forensic raw transcript path from dispatch.
- Materialized pod/worktree files under the per-run dispatch directory.

## User Workflows

Invoke:

1. Caller posts to `/agents/:name/invoke` with input, dispatcher session, optional work item, and invoke depth.
2. Route validates project, input, dispatcher session, and depth.
3. `dispatchFreshAgent` creates an agent run row, materializes pod/worktree context, starts runtime wrapper, and broadcasts run changes.
4. Audit row is recorded through `recordAgentInvoke`.
5. Caller receives async run id, CC session id, agent name, start timestamp, and initial status.

Continue:

1. Caller posts to `/agent-runs/:runId/continue`.
2. Route validates project ownership, original dispatcher session ownership, and input.
3. `dispatchContinueAgent` checks continuation eligibility and starts a child continuation run.
4. Caller receives async continuation envelope.

Activity panel:

1. Web fetches active queued/spawning/running/paused runs.
2. `useProjectAgentRuns` applies `agent-run-changed` WebSocket envelopes as deltas.
3. Activity panel renders running/paused cards and cancel/transcript actions.
4. Failed/completed surfaces are adjacent to activity/dismissal behavior and need a separate failed-run pass.

Transcript modal:

1. User opens transcript from a running agent card.
2. Shell resolves the latest run record from active runs or `agent-run-changed` envelopes.
3. Modal backfills `GET /agent-runs/:runId/events`.
4. Modal appends live `agent-jsonl-event` envelopes filtered by `runId`.
5. Modal dedupes before rendering rows.

Pending asks:

1. Agent calls a pending-ask tool, route records explicit pause and returns a pending ask id.
2. Orchestrator/user answer posts to `/agent-pending-asks/:askId/answer`.
3. Pause/resume service resumes the paused run or returns a status-mapped failure.
4. Cancel endpoint can terminate a pending ask without resuming.

Error and empty states:

- Unknown project returns 404.
- Unknown run returns 404.
- Wrong project returns 400.
- Cancel only works against the active in-memory registry.
- Transcript backfill returns `transcriptStatus: ready | empty | missing` so the modal can distinguish missing provider JSONL from an empty file.
- Modal copy distinguishes loading, missing, empty, generic no-events, and backfill error states.

## Dependency Map

Imports into the pod:

- Agent routes import DB repos, runtime `AgentRunJsonlTailer`, domain types, channel server, dispatch factory, pause/resume services, active registry, audit, and invoke-depth guard.
- Agent factory imports DB repos, runtime process wrappers, pod materialization, workflow/work item services, settings/runtime bundle helpers, channel delivery, and verification services.
- Web transcript surfaces import feature client contracts, project WebSocket envelope types, and ActivityPanel/Shell state.

Imports out of the pod:

- `apps/server/src/index.ts` registers agent run routes and injects project WebSocket broadcast.
- MCP tool handlers call invoke, continue, pending-ask, answer, and list surfaces through project/server services.
- Workflow runtime and DAG services create or observe agent run rows and broadcast `agent-run-changed`.
- Activity panel, Shell, chat bubbles, and workflow/agent surfaces consume agent run records and transcript metadata.

Cross-pod calls that should stay explicit:

- Project WebSocket hub is shared with chat/runtime but agent run envelopes are owned here.
- Work items are linked to run dispatch and audit rows but remain owned by the work-items pod.
- Workflows can dispatch agents and display transcript paths but run graph ownership stays in workflows.
- Pending asks cross orchestrator chat and agent runs; the persistence/state transition owner is this pod.

Duplicate adapters or protocol translations:

- Agent run row fields are shimmed into web `AgentRunRecord` in route responses.
- `apps/web/src/features/agent-runs/transcript.ts` owns the web-side agent JSONL envelope and transcript merge helper.
- Transcript backfill and live events both use `JsonlEvent`; the feature helper owns the merge/dedupe policy.

## Dead Code And Drift

- No safe deletes were proven during this pass.

Retained compatibility and fallback paths:

- `model: 'opus'` remains a display-only fallback for Activity Panel run cards because `agent_runs` does not persist the model used at dispatch. Persisting a dispatch-time model needs a DB/domain contract decision.
- `/api/subagent-transcript` remains owned by `chat-bridges` for older chat bubble transcript paths. Agent-run transcript backfill stays on `/api/projects/:projectId/agent-runs/:runId/events`.

## Tests And Gaps

Existing focused tests:

- `apps/server/test/agent-run-routes.test.ts`: active list, cancel, event backfill, missing/empty transcript status, invoke, continue, list-by-dispatcher, pending ask answer/cancel status mapping.
- `apps/server/test/web-agent-transcript.test.ts`: transcript backfill/live merge preserves repeated identical events, dedupes stable row ids, and maps empty/missing transcript copy.
- `apps/server/test/web-boundaries.test.ts`: includes an agent-run transcript boundary guard so `agent-jsonl-event` envelope contracts stay in the feature module instead of modal components.
- `apps/server/test/chat-bridges-routes.test.ts`: legacy `/api/subagent-transcript` path containment and JSONL parsing compatibility.
- `apps/server/test/agent-invoke-route.test.ts`: dispatch factory route integration.
- `apps/server/test/agent-pause-resume.test.ts`: pending ask pause/resume state transitions.
- `apps/server/test/agent-verification-review.test.ts`: review/verification continuation surfaces.
- `apps/server/test/agent-system-v1-absence.test.ts`: prevents legacy v1 route/file names from returning.
- `apps/server/test/chat-bridges-routes.test.ts`: legacy subagent transcript path validation and parsing.

Missing tests or trace evidence:

- No browser/UI-level test proves active, historical, failed, empty, and missing transcript modal states.
- No browser smoke was run for opening an active or historical transcript modal.

## Cleanup Plan

Do not change dispatch/runtime behavior before a trace identifies a failure.

Small cleanup candidates:

- Done in this slice: extracted transcript merge/dedupe into `apps/web/src/features/agent-runs/transcript.ts` with stable keys and repeated-identical-event coverage.
- Done in this slice: added explicit `ready | empty | missing` transcript backfill status and modal empty-state copy coverage.
- Done in this slice: added a boundary guard for agent-run WebSocket transcript contracts.
- Done in this slice: classified the Activity Panel model fallback and legacy `/api/subagent-transcript` bridge as retained compatibility/fallback paths.

No additional source-level cleanup is planned in this pod without a browser trace or a DB/product decision.

Verification commands to use before any cleanup patch:

- `pnpm --filter @pc/server exec tsx --test test/web-agent-transcript.test.ts test/agent-run-routes.test.ts`
- `pnpm --filter @pc/server exec tsx --test test/web-boundaries.test.ts`
- `pnpm --filter @pc/server exec tsx --test test/chat-bridges-routes.test.ts`
- `pnpm --filter @pc/server exec tsx --test test/agent-run-routes.test.ts`
- `pnpm --filter @pc/server typecheck`
- `pnpm --filter @pc/web typecheck`
- `git diff --check`

## Completion Criteria

Kickoff status:

- This pod audit file exists and maps ownership, workflows, dependencies, drift, tests, and cleanup candidates.
- Runtime dispatch behavior has not been changed.
- No app, dev server, dogfood app, Vite server, channel server, or restart endpoint has been touched.

Commands run so far:

- `rg -n` for agent-run, transcript, pending ask, and agent WebSocket surfaces.
- `Get-Content` for `AgentTranscriptModal`, agent-run routes, and agent-run route tests.
- `pnpm --filter @pc/server exec tsx --test test/web-agent-transcript.test.ts`
- `pnpm --filter @pc/server exec tsx --test test/web-agent-transcript.test.ts test/agent-run-routes.test.ts`
- `pnpm --filter @pc/server exec tsx --test test/web-boundaries.test.ts`
- `pnpm --filter @pc/server exec tsx --test test/chat-bridges-routes.test.ts`
- `pnpm --filter @pc/server typecheck`
- `pnpm --filter @pc/web typecheck`
- `git diff --check`

Verification results:

- Focused transcript merge/status tests: 3 passed, 0 failed.
- Agent-run route plus transcript merge/status tests: 9 passed, 0 failed.
- Web boundary tests: 5 passed, 0 failed.
- Chat bridge compatibility tests: 4 passed, 0 failed.
- Server typecheck: passed.
- Web typecheck: passed.
- Diff whitespace check: passed.

Manual workflow checks run:

- None. In-app Browser backend was unavailable during the preceding chat/runtime pod smoke attempt.

Open risks:

- Transcript modal behavior remains source-audited only.
- Browser/UI-level active, historical, failed, empty, and missing transcript modal states are not smoke-tested because the in-app Browser backend was unavailable.
- Persisting dispatch-time agent model remains a product/DB decision.
