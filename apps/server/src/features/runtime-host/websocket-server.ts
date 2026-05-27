import { WebSocketServer } from 'ws';
import type { OrchestratorSession, ULID } from '@pc/domain';

import type { PublicRuntimeSnapshot } from '../../services/orchestrator-runtime-snapshot.ts';
import {
  sendRuntimeHostConnectSnapshot,
  type RuntimeHostConnectInput,
  type RuntimeHostConnectRuntime,
} from './websocket-connect.ts';
import {
  handleRuntimeHostWsMessage,
  type RuntimeHostMessagePtySession,
  type RuntimeHostMessageRuntime,
  type RuntimeHostWsMessageInput,
} from './websocket-message.ts';

export interface RuntimeHostWebSocketLike {
  readonly OPEN: number;
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (raw: { toString(): string }) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
}

export interface RuntimeHostWebSocketHub<TSocket> {
  subscribe(projectId: ULID, ws: TSocket): () => void;
}

export type RuntimeHostWebSocketRuntime<TPty extends RuntimeHostMessagePtySession> =
  RuntimeHostConnectRuntime<TPty> &
  Omit<RuntimeHostMessageRuntime, 'ptySession'> & {
    ptySession(): TPty | null;
  };

export interface RuntimeHostWebSocketConnectionDeps<
  TPty extends RuntimeHostMessagePtySession,
  TRuntime extends RuntimeHostWebSocketRuntime<TPty>,
  TSocket extends RuntimeHostWebSocketLike,
> {
  ws: TSocket;
  request: { url?: string | null };
  resolveProject(projectId: string): TRuntime | null;
  subscribe(projectId: ULID, ws: TSocket): () => void;
  attachPtyHandlers(projectId: ULID, runtime: TRuntime, session: TPty): void;
  runtimeSnapshotPayload(projectId: ULID, runtime: TRuntime): PublicRuntimeSnapshot;
  startOrchestratorPtyInBackground(projectId: ULID, runtime: TRuntime): void;
  broadcastTo(projectId: ULID, msg: unknown): void;
  broadcastSendQueueSnapshot(projectId: ULID, sessionId: ULID): void;
  ensureOrchestratorPty(projectId: ULID, runtime: TRuntime): TPty;
  resolvePendingAsk(toolUseId: string, answer: string): void;
  sendConnectSnapshot?(input: RuntimeHostConnectInput<TPty, TRuntime>): OrchestratorSession;
  handleWsMessage?(input: RuntimeHostWsMessageInput<TPty, TRuntime>): Promise<void> | void;
}

export interface RuntimeHostWebSocketServerDeps<
  TPty extends RuntimeHostMessagePtySession,
  TRuntime extends RuntimeHostWebSocketRuntime<TPty>,
> extends Omit<
    RuntimeHostWebSocketConnectionDeps<TPty, TRuntime, RuntimeHostWebSocketLike>,
    'ws' | 'request' | 'subscribe'
  > {
  server: unknown;
  path?: string;
  wsHub: RuntimeHostWebSocketHub<RuntimeHostWebSocketLike>;
}

function closeBestEffort(ws: RuntimeHostWebSocketLike, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    /* best effort */
  }
}

export function handleRuntimeHostWsConnection<
  TPty extends RuntimeHostMessagePtySession,
  TRuntime extends RuntimeHostWebSocketRuntime<TPty>,
  TSocket extends RuntimeHostWebSocketLike,
>(
  deps: RuntimeHostWebSocketConnectionDeps<TPty, TRuntime, TSocket>,
): boolean {
  const {
    attachPtyHandlers,
    broadcastSendQueueSnapshot,
    broadcastTo,
    ensureOrchestratorPty,
    request,
    resolvePendingAsk,
    resolveProject,
    runtimeSnapshotPayload,
    startOrchestratorPtyInBackground,
    subscribe,
    ws,
  } = deps;
  const url = new URL(request.url ?? '/ws', 'http://127.0.0.1');
  const projectId = url.searchParams.get('projectId') as ULID | null;
  if (!projectId) {
    closeBestEffort(ws, 1008, 'projectId query param required');
    return false;
  }
  const runtime = resolveProject(projectId);
  if (!runtime) {
    closeBestEffort(ws, 1008, `unknown project: ${projectId}`);
    return false;
  }

  const detachSubscriber = subscribe(projectId, ws);
  const sendConnectSnapshot = deps.sendConnectSnapshot ?? sendRuntimeHostConnectSnapshot;
  sendConnectSnapshot({
    projectId,
    runtime,
    send: (envelope) => ws.send(JSON.stringify(envelope)),
    attachPtyHandlers,
    runtimeSnapshotPayload,
    startOrchestratorPtyInBackground,
  });

  const handleWsMessage = deps.handleWsMessage ?? handleRuntimeHostWsMessage;
  ws.on('message', (raw) => {
    void handleWsMessage({
      projectId,
      runtime,
      raw: raw.toString(),
      send: (envelope) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(envelope));
      },
      broadcastTo,
      broadcastSendQueueSnapshot,
      ensureOrchestratorPty,
      resolvePendingAsk,
    });
  });

  ws.on('close', () => {
    detachSubscriber();
  });
  return true;
}

export function registerRuntimeHostWebSocketServer<
  TPty extends RuntimeHostMessagePtySession,
  TRuntime extends RuntimeHostWebSocketRuntime<TPty>,
>(deps: RuntimeHostWebSocketServerDeps<TPty, TRuntime>): WebSocketServer {
  const wss = new WebSocketServer({
    server: deps.server as never,
    path: deps.path ?? '/ws',
  });
  wss.on('connection', (ws, req) => {
    const socket = ws as unknown as RuntimeHostWebSocketLike;
    handleRuntimeHostWsConnection({
      ...deps,
      ws: socket,
      request: req,
      subscribe: (projectId) => deps.wsHub.subscribe(projectId, socket),
    });
  });
  return wss;
}
