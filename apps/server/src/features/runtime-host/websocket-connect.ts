import type { OrchestratorSession, ULID } from '@pc/domain';

import { sendQueueSnapshotPayload } from '../../services/orchestrator-send-queue-delivery.ts';
import type { PublicRuntimeSnapshot } from '../../services/orchestrator-runtime-snapshot.ts';
import { loadRuntimeSessionReplay, sessionReplayPayload } from './routes.ts';

export interface RuntimeHostConnectRuntime<TPty extends { getState(): string }> {
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
  send(envelope: Record<string, unknown>): void;
  attachPtyHandlers(projectId: ULID, runtime: TRuntime, session: TPty): void;
  runtimeSnapshotPayload(projectId: ULID, runtime: TRuntime): PublicRuntimeSnapshot;
  startOrchestratorPtyInBackground(projectId: ULID, runtime: TRuntime): void;
}

/** Send the deterministic reconnect/refresh checkpoint for a project WS.
 *  The durable session row and replay surfaces are sent synchronously before
 *  any background PTY start so the client can reconcile local state first. */
export function sendRuntimeHostConnectSnapshot<
  TPty extends { getState(): string },
  TRuntime extends RuntimeHostConnectRuntime<TPty>,
>(input: RuntimeHostConnectInput<TPty, TRuntime>): OrchestratorSession {
  const {
    attachPtyHandlers,
    projectId,
    runtime,
    runtimeSnapshotPayload,
    send,
    startOrchestratorPtyInBackground,
  } = input;
  const activeSession = runtime.ensureActiveSession();

  send({ projectId, type: 'session-changed', session: activeSession });
  const liveSession = runtime.ptySession();
  if (liveSession) {
    attachPtyHandlers(projectId, runtime, liveSession);
    send({ projectId, type: 'state', state: liveSession.getState() });
  }

  send({ projectId, ...runtimeSnapshotPayload(projectId, runtime) });

  const replay = loadRuntimeSessionReplay(runtime, activeSession.id);
  send({ projectId, ...sessionReplayPayload(replay) });
  send({ projectId, ...sendQueueSnapshotPayload(activeSession.id) });
  startOrchestratorPtyInBackground(projectId, runtime);

  return activeSession;
}
