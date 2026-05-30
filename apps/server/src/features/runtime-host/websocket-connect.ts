import type { OrchestratorSession, ULID } from '@pc/domain';

import { sendQueueSnapshotPayload } from '../../services/orchestrator-send-queue-delivery.ts';
import type { PublicRuntimeSnapshot } from '../../services/orchestrator-runtime-snapshot.ts';
import { loadRuntimeSessionReplay, sessionReplayPayload } from './routes.ts';

export interface RuntimeHostConnectRuntime<TPty extends { getState(): string }> {
  activeSession(): OrchestratorSession | null;
  ensureActiveSession(): OrchestratorSession;
  ptySession(): TPty | null;
  sessionDataPath(sessionId: string): string;
}

export interface RuntimeHostConnectInput<
  TPty extends { getState(): string },
  TRuntime extends RuntimeHostConnectRuntime<TPty>,
> {
  projectId: ULID;
  runtime: TRuntime;
  /** True only for the focused chat socket (`?intent=chat`). Activity/unread
   *  sockets (the all-projects fan-out) connect WITHOUT chat intent: they must
   *  NOT mint a session row or spawn claude.exe. That fan-out spawning one
   *  orchestrator per project on boot was the connect storm. */
  chatIntent: boolean;
  send(envelope: Record<string, unknown>): void;
  attachPtyHandlers(projectId: ULID, runtime: TRuntime, session: TPty): void;
  runtimeSnapshotPayload(projectId: ULID, runtime: TRuntime): PublicRuntimeSnapshot;
  startOrchestratorPtyInBackground(projectId: ULID, runtime: TRuntime): void;
}

/** Send the deterministic reconnect/refresh checkpoint for a project WS.
 *  The durable session row and replay surfaces are sent synchronously before
 *  any background PTY start so the client can reconcile local state first.
 *
 *  Only a chat-intent socket mints a session, attaches PTY handlers, and starts
 *  claude.exe. Activity/unread sockets get the read-only snapshot (active row if
 *  one already exists, else null) and rely on the hub subscription for events —
 *  no spawn, no session-row churn. */
export function sendRuntimeHostConnectSnapshot<
  TPty extends { getState(): string },
  TRuntime extends RuntimeHostConnectRuntime<TPty>,
>(input: RuntimeHostConnectInput<TPty, TRuntime>): OrchestratorSession | null {
  const {
    attachPtyHandlers,
    chatIntent,
    projectId,
    runtime,
    runtimeSnapshotPayload,
    send,
    startOrchestratorPtyInBackground,
  } = input;
  const session = chatIntent ? runtime.ensureActiveSession() : runtime.activeSession();

  send({ projectId, type: 'session-changed', session });

  if (chatIntent) {
    const liveSession = runtime.ptySession();
    if (liveSession) {
      attachPtyHandlers(projectId, runtime, liveSession);
      send({ projectId, type: 'state', state: liveSession.getState() });
    }
  }

  send({ projectId, ...runtimeSnapshotPayload(projectId, runtime) });

  if (session) {
    const replay = loadRuntimeSessionReplay(runtime, session.id);
    send({ projectId, ...sessionReplayPayload(replay) });
    send({ projectId, ...sendQueueSnapshotPayload(session.id) });
  }

  if (chatIntent) {
    startOrchestratorPtyInBackground(projectId, runtime);
  }

  return session;
}
