# Transient Sessions Pod Audit

Status: auditing.

Owner: Codex.

Worktree: `E:\Claude Code Projects\Personal\PC-PTY-Chat-phase5`.

Branch: `codex/phase-5-hardening`.

## Ownership

Server route modules:

- `apps/server/src/features/transient-sessions/routes.ts`: shared start/send/interrupt/terminal-input/resize/stop routes for agent-designer, workflow-builder, and setup-wizard.
- `apps/server/src/features/workflow-compat/routes.ts`: workflow-builder draft save/read routes and `workflow-builder-draft` broadcasts.

Server services:

- `apps/server/src/services/project-runtime.ts`: transient session lifecycle for `startAgentDesigner`, `startWorkflowBuilder`, `startSetupWizard`, PTY getters, resize, session ids, draft store, and teardown.
- `apps/server/src/services/pod-spawn.ts`: agent-designer/workflow-builder pod spawn preparation.
- `apps/server/src/services/claude-runtime-bundle.ts`: setup-wizard runtime bundle preparation.
- `apps/server/src/services/terminal-mode.ts`: shared raw terminal input validation for transient terminal input routes.

Runtime modules:

- `packages/runtime/src/pty-session.ts`: transient PTY wrapper used by modal sessions.
- `packages/runtime/src/interactive-session.ts`: adjacent interactive session primitive for orchestrator parity.

Web modules:

- `apps/web/src/features/transient-sessions/client.ts`: HTTP client for all transient session controls and workflow-builder draft save.
- `apps/web/src/components/TransientAgentConversation.tsx`: shared ChatSurface wrapper for transient modal conversations.
- `apps/web/src/components/agents/AgentDesignerChat.tsx`: agent-designer WS envelope adapter and send/interrupt/terminal wiring.
- `apps/web/src/components/WorkflowBuilderChat.tsx`: workflow-builder WS envelope adapter, ask passthrough, edit-handoff/warmup filtering, and send/interrupt/terminal wiring.
- `apps/web/src/components/WorkflowBuilderModal.tsx`: workflow-builder lifecycle, edit-mode handoff, graph draft sync, publish-close logic.
- `apps/web/src/components/SetupWizardModal.tsx`: setup-wizard lifecycle, event adapter, CLAUDE.md change auto-close.
- `apps/web/src/components/agents/CreatePodModal.tsx`: agent-designer conversational start/stop owner.
- `apps/web/src/components/ProjectSettingsPanel.tsx`: setup-wizard modal launcher from missing/empty CLAUDE.md nag.

Public entry points:

- HTTP: `POST /api/projects/:projectId/agent-designer/start`.
- HTTP: `POST /api/projects/:projectId/agent-designer/send`.
- HTTP: `POST /api/projects/:projectId/agent-designer/interrupt`.
- HTTP: `POST /api/projects/:projectId/agent-designer/terminal-input`.
- HTTP: `POST /api/projects/:projectId/agent-designer/resize`.
- HTTP: `DELETE /api/projects/:projectId/agent-designer`.
- HTTP: same route set for `workflow-builder` and `setup-wizard`.
- HTTP: `POST /api/projects/:projectId/workflow-builder/draft`.
- HTTP: `GET /api/projects/:projectId/workflow-builder/draft/:sessionId`.
- WebSocket outbound: `{prefix}-state`, `{prefix}-jsonl`, `{prefix}-event`, `{prefix}-raw`, `{prefix}-exit` for each transient prefix.
- WebSocket outbound: `workflow-builder-draft`.
- WebSocket inbound shared with project socket: `ask-reply` for workflow-builder ask cards.

Persisted files:

- `<dataDir>/projects/<projectId>/sessions/ad-<uuid>/*`: agent-designer transient session data.
- `<dataDir>/projects/<projectId>/sessions/wb-<uuid>/*`: workflow-builder transient session data.
- `<dataDir>/projects/<projectId>/sessions/sw-<uuid>/*`: setup-wizard transient session data.
- Setup wizard writes project `CLAUDE.md` through its spawned session and closes when `project-claude-md-changed` arrives.

## User Workflows

Agent designer:

1. CreatePodModal shows the Conversational tab.
2. User starts the session; web calls `agent-designer/start`.
3. Server starts a transient PTY with the `agent-designer` pod and broadcasts initial state.
4. AgentDesignerChat adapts prefixed WS envelopes into ChatSurface-compatible `state`, `jsonl`, and `raw` envelopes.
5. User sends chat or terminal input through HTTP control routes.
6. Closing CreatePodModal explicitly calls stop; no useEffect cleanup owns teardown because React Strict Mode would kill new sessions.

Workflow builder:

1. WorkflowBuilderModal starts `workflow-builder`.
2. New mode opens chat plus graph; edit mode preloads the existing workflow and sends one edit-mode handoff after `ready`.
3. WorkflowBuilderChat adapts prefixed envelopes and passes only same-session asks through to ChatSurface.
4. Graph edits save drafts to the server draft store and receive `workflow-builder-draft` broadcasts back.
5. Publish broadcasts `workflow-changed`; the modal closes on created or matching updated workflow.

Setup wizard:

1. ProjectSettingsPanel opens SetupWizardModal when CLAUDE.md is missing or empty.
2. SetupWizardModal starts `setup-wizard` and adapts prefixed envelopes into ChatSurface-compatible envelopes.
3. User answers through HTTP send; terminal mode uses the same raw input and resize controls.
4. `project-claude-md-changed` closes the modal.

Raw terminal controls:

1. All three transient surfaces render through TransientAgentConversation and ChatSurface.
2. TerminalModePanel sends raw input and resize through transient-specific HTTP clients.
3. Server validates raw input through `forwardTerminalInput` and delegates resize to the live transient session.

## Dependency Map

Imports into the pod:

- Transient route factory imports terminal input validation only.
- ProjectRuntime imports pod spawn prep, runtime bundle prep, PTY session, workflow draft store helpers, and project scaffold refresh.
- Web adapters import transient session client, ChatSurface wrapper, runtime state capability helpers, and WebSocket envelope types.

Imports out of the pod:

- Agents tab uses agent-designer to create pods.
- Workflows tab uses workflow-builder to create/edit workflow v2 definitions.
- Project settings uses setup-wizard to write CLAUDE.md.
- Workflow-builder uses workflow compatibility routes and MCP draft tools.

Cross-pod calls that should stay explicit:

- Agents/pods/catalog/MCP owns the pod rows and create/edit tools; transient sessions own only the modal session transport.
- Workflows/builder/visualizer owns workflow definitions and graph rendering; transient sessions own workflow-builder chat/PTY lifecycle.
- Files/project context/settings owns CLAUDE.md status/write events; transient sessions own setup-wizard transport and close reaction.
- Terminal/PTY owns raw terminal semantics; transient sessions reuse the control routes.

Duplicate adapters or protocol translations:

- Server route handling is already generic across the three transient prefixes.
- Web adapters duplicate session ownership checks, state parsing, state-to-label copy, raw envelope translation, and `state`/`jsonl`/`exit` adaptation.
- Transient session client repeats start/send/interrupt/terminal-input/resize/stop method sets for each prefix.
- Agent-designer and workflow-builder each filter warmup turns independently.
- Workflow-builder alone passes same-session `ask` envelopes through.

## Dead Code And Drift

- `setup-wizard` start intentionally does not catch start errors in the route descriptor; agent-designer and workflow-builder do.
- SetupWizardModal uses ASCII status copy while the other transient wrappers use mixed ellipsis copy already present in UI files.
- `TransientAgentConversation` is shared but leaves envelope normalization to each caller.
- No safe deletes were proven during this initial pass.

## Tests And Gaps

Existing focused tests:

- `apps/server/test/transient-session-routes.test.ts`: shared route factory, start broadcasts, handler idempotence, send/interrupt/terminal-input/resize/stop, missing project/session, validation, and start errors.
- `apps/server/test/workflow-builder-draft-store.test.ts`: ProjectRuntime workflow-builder draft save/read/isolation/clear/shutdown behavior.
- `apps/server/test/web-pending-prompts.test.ts`: adjacent ChatSurface pending prompt behavior used by transient conversations.
- `apps/server/test/web-terminal-capabilities.test.ts`: transient terminal input capability states.

Missing tests or trace evidence:

- No focused web adapter test covers agent-designer, workflow-builder, or setup-wizard event normalization.
- No test verifies warmup-turn filtering parity across agent-designer and workflow-builder.
- No test verifies setup-wizard closes only on `project-claude-md-changed` for the active project context.
- No browser smoke verifies modal start, chat send, terminal mode, graph draft sync, ask reply, or close/stop behavior.

## Cleanup Plan

Do not change transient spawn or teardown semantics without a failing trace.

Small cleanup candidates:

- Extract shared transient event adapter helpers for session matching, state parsing, raw translation, state/jsonl adaptation, and warmup filtering.
- Add focused web tests for agent-designer/workflow-builder/setup-wizard adapter outputs.
- Defer transient client method de-duplication unless another route prefix is added; explicit methods are noisy but easy to scan.

Verification commands to use before any cleanup patch:

- `pnpm --filter @pc/server exec tsx --test test/transient-session-routes.test.ts test/workflow-builder-draft-store.test.ts test/web-pending-prompts.test.ts test/web-terminal-capabilities.test.ts`
- `pnpm --filter @pc/server typecheck`
- `pnpm --filter @pc/web typecheck`
- `git diff --check`

## Completion Criteria

Kickoff status:

- This pod audit file exists and maps ownership, workflows, dependencies, drift, tests, and cleanup candidates.
- No runtime behavior has been changed.
- No app, dev server, dogfood app, Vite server, channel server, or restart endpoint has been touched.

Commands run so far:

- `rg -n` for transient sessions, agent-designer, workflow-builder, setup-wizard, modal wrappers, and draft surfaces.
- `Get-Content` for transient route factory, transient web client, shared conversation wrapper, web adapters, modal owners, workflow draft routes, and existing tests.
- `pnpm --filter @pc/server exec tsx --test test/transient-session-routes.test.ts test/workflow-builder-draft-store.test.ts test/web-pending-prompts.test.ts test/web-terminal-capabilities.test.ts`
- `git diff --check`

Verification results:

- Focused transient sessions tests: 18 passed, 0 failed.
- Diff whitespace check: passed.

Manual workflow checks run:

- None.

Open risks:

- Transient modal UI behavior remains source-audited only.
- Browser-level transient session start/send/stop behavior is unverified in this session.
