# Terminal And PTY Pod Audit

Status: complete.

Owner: Codex.

Worktree: `E:\Claude Code Projects\Personal\PC-PTY-Chat-phase5`.

Branch: `codex/phase-5-hardening`.

## Ownership

Runtime modules:

- `packages/runtime/src/pty-session.ts`: durable orchestrator/transient PTY wrapper, terminal raw stream, raw input, resize, transcript log writes, ready detection, JSONL tailing, legacy hook watchers.
- `packages/runtime/src/low-level-spawn.ts`: lower-level PTY wrapper used by agent runs, raw stream, raw input, resize, transcript stream, ready gate, JSONL attach.
- `packages/runtime/src/send-protocol.ts`: bracketed paste send protocol and echo confirmation.
- `packages/runtime/src/ready-gate.ts`: low-level ready signal detection.
- `packages/runtime/src/node-launcher.ts`: node/electron launch helper adjacent to PTY process spawning.

Server modules:

- `apps/server/src/services/terminal-mode.ts`: raw terminal input validation/forwarding and transcript tail path containment.
- `apps/server/src/features/runtime-host/websocket-message.ts`: `terminal-input` and `resize` WebSocket message handling.
- `apps/server/src/features/runtime-host/routes.ts`: terminal transcript HTTP tail endpoint.
- `apps/server/src/services/project-runtime.ts`: orchestrator and transient session PTY ownership, `resizeOrchestrator`, transient session lookup, session data path.
- `apps/server/src/features/runtime-host/pty-handlers.ts`: raw event fanout with `terminalSeq` and runtime state broadcasts.

Web modules:

- `apps/web/src/components/TerminalModePanel.tsx`: xterm mount, transcript tail attach, live raw merge, input, resize, dispose.
- `apps/web/src/features/chat/TerminalPane.tsx`: terminal panel and chat/terminal surface toggle.
- `apps/web/src/features/chat/terminalTranscript.ts`: pure terminal raw envelope parsing, pending raw ordering, duplicate sequence filtering, and transcript/live overlap removal.
- `apps/web/src/features/chat/runtimeState.ts`: orchestrator/transient input capability gates for terminal input, resize, interrupt, and chat.
- `apps/web/src/features/runtime/client.ts`: terminal transcript HTTP client.
- `apps/web/src/features/runtime/ws-types.ts`: terminal outbound/input ack and raw envelope contracts.
- `apps/web/src/components/Orchestrator.tsx`: wires terminal input/resize to WebSocket and surfaces terminal input failures.

Public entry points:

- WebSocket inbound: `terminal-input`.
- WebSocket inbound: `resize`.
- WebSocket outbound: `raw` with `sessionId`, `terminalSeq`, and `text`.
- WebSocket outbound: `terminal-input-ack` failure envelope.
- HTTP: `GET /api/projects/:projectId/sessions/:sessionId/terminal-transcript`.

Persisted files:

- `<dataDir>/projects/<projectId>/sessions/<sessionId>/transcript.log`: raw orchestrator or transient PTY transcript.
- `<dataDir>/projects/<projectId>/agent-runs-v2/<runId>/transcript.log`: raw agent-run transcript, owned primarily by agent-runs.
- Provider JSONL remains the chat/agent canonical event source; terminal transcript is raw/debug display data.

## User Workflows

Open terminal surface:

1. ChatSurface checks terminal eligibility from current project/session and callbacks.
2. User toggles terminal mode.
3. TerminalModePanel creates xterm, attaches fit addon, requests transcript tail, and delays reveal until fitted.
4. Live `raw` envelopes received during attach are buffered and merged after removing overlap against the transcript tail.

Raw input:

1. xterm `onData` emits bytes only when `writable` is true.
2. Web sends `{ type: 'terminal-input', data }` over the project WebSocket.
3. Server validates string type and byte limit.
4. Server writes bytes only if a live PTY exists and `writeRaw` accepts them.
5. Server sends `terminal-input-ack` only for failures; web renders a terminal input failure banner.

Resize:

1. TerminalModePanel fits on mount, visible toggles, and ResizeObserver events.
2. Web sends `{ type: 'resize', cols, rows }`.
3. Server ignores non-finite dimensions and catches stale resize errors.
4. Runtime resize no-ops after exit.

Transcript tail:

1. TerminalModePanel requests the tail by project/session id.
2. Server verifies project ownership and path containment.
3. Missing transcript returns empty bytes with `mtimeMs: null`.
4. Non-file transcript path returns empty bytes with `mtimeMs`.
5. Tail byte request is capped at 1 MiB.

State gates:

- Durable orchestrator raw terminal input is allowed for live non-terminal runtime health, including spawning/respawning, as a recovery path.
- Transient terminal input is allowed while session state is spawning, ready, or thinking; exited blocks input.
- Chat submit uses separate queue/readiness semantics.

## Dependency Map

Imports into the pod:

- Terminal server service imports Node fs/path primitives only.
- Runtime PTY wrappers import `node-pty`, JSONL tailers, ready gate, send protocol, path resolver, and environment scrub helpers.
- Web terminal panel imports xterm, fit addon, runtime client, and WebSocket envelope types.

Imports out of the pod:

- Runtime-host WebSocket handler imports `forwardTerminalInput`.
- Runtime-host routes import transcript tail helpers.
- ChatSurface/Orchestrator import terminal panel/capability helpers.
- Agent-run runtime uses LowLevelSpawn terminal primitives, but agent-run lifecycle remains owned by agent-runs.

Cross-pod calls that should stay explicit:

- Chat/runtime owns project WebSocket transport; Terminal/PTY owns raw terminal semantics.
- Agent-runs owns per-run transcript presentation; LowLevelSpawn owns low-level raw transcript writes.
- Transient sessions share PtySession and terminal transcript routes with durable orchestrator sessions.

Duplicate adapters or protocol translations:

- `PtySession.writeRaw` and `LowLevelSpawn.writeRaw` implement similar exited-state guards.
- `PtySession.resize` and `LowLevelSpawn.resize` implement similar stale-child guards.
- Server terminal transcript returns raw bytes while chat replay uses normalized JSONL event envelopes.

## Dead Code And Drift

- `terminal-input-ack` has a failure UI path after the chat/runtime pod cleanup; success acks are intentionally not emitted.
- Missing transcript returns empty bytes and is treated as non-fatal for terminal attach.
- Raw input while spawning conflicts with older Phase 0 wording, but current code and tests classify it as an intentional recovery escape hatch.
- No safe deletes were proven during this initial pass.

## Tests And Gaps

Existing focused tests:

- `apps/server/test/terminal-mode.test.ts`: terminal input validation, oversized input rejection, missing PTY rejection, transcript tail containment, missing transcript, and tail byte caps.
- `apps/server/test/web-terminal-capabilities.test.ts`: orchestrator/transient terminal writability while spawning, terminal/unavailable state blocking, terminal input failure status text.
- `apps/server/test/web-terminal-transcript.test.ts`: terminal raw envelope parsing, max sequence discovery, pending raw ordering, duplicate sequence filtering, and transcript/live overlap removal.
- `apps/server/test/web-boundaries.test.ts`: guards terminal transcript helpers outside the xterm component.
- `apps/server/test/runtime-host-websocket-message.test.ts`: terminal input, resize, interrupt, ask routing, stale resize handling.
- `apps/server/test/runtime-host-pty-handlers.test.ts`: ready drain, raw/event/JSONL lifecycle broadcasts.
- `apps/server/test/runtime-host-routes.test.ts`: terminal transcript route coverage through runtime routes.

Missing tests or trace evidence:

- No browser smoke verifies xterm attach, fit, live raw merge, and typing.
- No test captures terminal transcript attach plus live raw overlap removal end to end.

## Cleanup Plan

Do not change PTY process behavior without a failing trace.

Small cleanup candidates:

- Done: extracted terminal raw envelope parsing and transcript/live overlap merge into `apps/web/src/features/chat/terminalTranscript.ts`.
- Done: added focused tests for raw envelope parsing, sequence ordering, duplicate sequence filtering, and overlap removal.
- Done: added a boundary guard so terminal transcript/raw helpers stay outside the xterm component.
- Decide later whether `PtySession` and `LowLevelSpawn` should share a small raw input/resize guard helper; defer until more low-level spawn work is active.

Verification commands to use before any cleanup patch:

- `pnpm --filter @pc/server exec tsx --test test/terminal-mode.test.ts test/web-terminal-capabilities.test.ts test/runtime-host-websocket-message.test.ts`
- `pnpm --filter @pc/server typecheck`
- `pnpm --filter @pc/web typecheck`
- `git diff --check`

## Completion Criteria

Kickoff status:

- This pod audit file exists and maps ownership, workflows, dependencies, drift, tests, and cleanup candidates.
- No runtime behavior has been changed.
- No app, dev server, dogfood app, Vite server, channel server, or restart endpoint has been touched.

Commands run so far:

- `rg -n` for terminal, PTY, resize, transcript, raw input, and raw envelope surfaces.
- `Get-Content` for terminal server service, terminal tests, PtySession, LowLevelSpawn, TerminalModePanel, terminal transcript route, and WebSocket message handling.
- `pnpm --filter @pc/server exec tsx --test test/terminal-mode.test.ts test/web-terminal-capabilities.test.ts test/runtime-host-websocket-message.test.ts`
- `pnpm --filter @pc/server exec tsx --test test/web-terminal-transcript.test.ts test/web-boundaries.test.ts test/terminal-mode.test.ts test/web-terminal-capabilities.test.ts test/runtime-host-websocket-message.test.ts`
- `pnpm --filter @pc/server typecheck`
- `pnpm --filter @pc/web typecheck`
- `git diff --check`

Verification results:

- Focused terminal/PTY WebSocket tests: 16 passed, 0 failed.
- Focused terminal/PTY cleanup tests: 26 passed, 0 failed.
- Server typecheck: passed.
- Web typecheck: passed.
- Diff whitespace check: passed.

Manual workflow checks run:

- Browser smoke attempted for the existing local app without restarting anything, but the in-app Browser backend reported unavailable: `iab`.

Open risks:

- Terminal UI behavior remains source-audited only.
- Browser-level xterm attach/input/resize behavior is unverified in this session.
