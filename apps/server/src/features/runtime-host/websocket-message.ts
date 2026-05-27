import type { OrchestratorSession, ULID } from '@pc/domain';
import {
  enqueueOrchestratorSend,
  getActiveOrchestratorSession,
  hasOpenOrchestratorSendsForSession,
  newId,
  recordDeliveredOrchestratorSend,
} from '@pc/db';

import {
  deliverNextQueuedPrompt,
  publicSendQueueItem,
  queuedStatusForState,
  type PublicSendQueueItem,
} from '../../services/orchestrator-send-queue-delivery.ts';
import { forwardTerminalInput } from '../../services/terminal-mode.ts';
import { loadRuntimeSessionReplay, sessionReplayPayload } from './routes.ts';

export type SendAckStatus =
  | 'received'
  | 'queued'
  | 'invalid-message'
  | 'no-session'
  | 'error';

export interface RuntimeHostMessagePtySession {
  getState(): string;
  send(text: string): Promise<string | void> | string | void;
  interrupt(): void;
  writeRaw(bytes: string): boolean;
}

export interface RuntimeHostMessageRuntime {
  ensureActiveSession(): OrchestratorSession;
  ptySession(): RuntimeHostMessagePtySession | null;
  resizeOrchestrator(cols: number, rows: number): void;
  sessionDataPath(sessionId: string): string;
}

export interface RuntimeHostWsMessageInput<
  TPty extends RuntimeHostMessagePtySession,
  TRuntime extends RuntimeHostMessageRuntime,
> {
  projectId: ULID;
  runtime: TRuntime;
  raw: string;
  send(envelope: Record<string, unknown>): void;
  broadcastTo(projectId: ULID, msg: unknown): void;
  broadcastSendQueueSnapshot(projectId: ULID, sessionId: ULID): void;
  ensureOrchestratorPty(projectId: ULID, runtime: TRuntime): TPty;
  resolvePendingAsk(toolUseId: string, answer: string): void;
}

interface RuntimeHostWireMessage {
  type?: string;
  text?: string;
  data?: unknown;
  clientMessageId?: unknown;
  cols?: number;
  rows?: number;
  nonce?: unknown;
  sentAt?: unknown;
  toolUseId?: string;
  answer?: string;
}

export async function handleRuntimeHostWsMessage<
  TPty extends RuntimeHostMessagePtySession,
  TRuntime extends RuntimeHostMessageRuntime,
>(input: RuntimeHostWsMessageInput<TPty, TRuntime>): Promise<void> {
  const {
    broadcastSendQueueSnapshot,
    broadcastTo,
    ensureOrchestratorPty,
    projectId,
    raw,
    resolvePendingAsk,
    runtime,
    send,
  } = input;
  let msg: RuntimeHostWireMessage;
  try {
    msg = JSON.parse(raw) as RuntimeHostWireMessage;
  } catch {
    return;
  }

  const sendAck = (
    clientMessageId: unknown,
    ack: {
      ok: boolean;
      status: SendAckStatus;
      error?: string;
      queueItem?: PublicSendQueueItem;
    },
  ) => {
    if (typeof clientMessageId !== 'string' || !clientMessageId) return;
    send({ projectId, type: 'send-ack', clientMessageId, ...ack });
  };

  switch (msg.type) {
    case 'client-ping':
      send({
        projectId,
        type: 'server-pong',
        nonce: typeof msg.nonce === 'string' ? msg.nonce : undefined,
        sentAt: typeof msg.sentAt === 'number' ? msg.sentAt : undefined,
        serverTime: Date.now(),
      });
      break;
    case 'send':
      await handlePromptSend({
        broadcastSendQueueSnapshot,
        broadcastTo,
        ensureOrchestratorPty,
        msg,
        projectId,
        runtime,
        sendAck,
      });
      break;
    case 'interrupt':
      runtime.ptySession()?.interrupt();
      break;
    case 'terminal-input': {
      const result = forwardTerminalInput(runtime, msg.data);
      if (!result.ok) {
        send({
          projectId,
          type: 'terminal-input-ack',
          ok: false,
          status: result.status,
          error: result.error,
        });
      }
      break;
    }
    case 'resize':
      if (typeof msg.cols === 'number' && typeof msg.rows === 'number') {
        runtime.resizeOrchestrator(msg.cols, msg.rows);
      }
      break;
    case 'ask-reply': {
      const id = msg.toolUseId;
      const answer = msg.answer ?? '';
      if (id) resolvePendingAsk(id, answer);
      break;
    }
  }
}

async function handlePromptSend<
  TPty extends RuntimeHostMessagePtySession,
  TRuntime extends RuntimeHostMessageRuntime,
>(input: {
  projectId: ULID;
  runtime: TRuntime;
  msg: RuntimeHostWireMessage;
  sendAck: (
    clientMessageId: unknown,
    ack: {
      ok: boolean;
      status: SendAckStatus;
      error?: string;
      queueItem?: PublicSendQueueItem;
    },
  ) => void;
  broadcastTo(projectId: ULID, msg: unknown): void;
  broadcastSendQueueSnapshot(projectId: ULID, sessionId: ULID): void;
  ensureOrchestratorPty(projectId: ULID, runtime: TRuntime): TPty;
}): Promise<void> {
  const {
    broadcastSendQueueSnapshot,
    broadcastTo,
    ensureOrchestratorPty,
    msg,
    projectId,
    runtime,
    sendAck,
  } = input;
  if (typeof msg.text !== 'string') {
    sendAck(msg.clientMessageId, {
      ok: false,
      status: 'invalid-message',
      error: 'send.text must be a string',
    });
    return;
  }
  const clientMessageId =
    typeof msg.clientMessageId === 'string' && msg.clientMessageId
      ? msg.clientMessageId
      : newId();
  let active = getActiveOrchestratorSession(projectId);
  if (!active) {
    active = runtime.ensureActiveSession();
    broadcastTo(projectId, { type: 'session-changed', session: active });
    broadcastTo(projectId, sessionReplayPayload(loadRuntimeSessionReplay(runtime, active.id)));
    broadcastSendQueueSnapshot(projectId, active.id);
  }
  let live = runtime.ptySession();
  if (!live) {
    try {
      live = ensureOrchestratorPty(projectId, runtime);
    } catch (err) {
      sendAck(msg.clientMessageId, {
        ok: false,
        status: 'no-session',
        error: err instanceof Error
          ? err.message
          : 'No live orchestrator session is attached',
      });
      return;
    }
  }
  const state = live.getState();
  const hasBacklog = hasOpenOrchestratorSendsForSession(active.id);
  if (state !== 'ready' || hasBacklog) {
    try {
      const row = enqueueOrchestratorSend({
        projectId,
        sessionId: active.id,
        clientMessageId,
        text: msg.text,
        status: queuedStatusForState(state, hasBacklog),
      });
      sendAck(msg.clientMessageId, {
        ok: true,
        status: 'queued',
        queueItem: publicSendQueueItem(row),
      });
      broadcastSendQueueSnapshot(projectId, active.id);
      if (state === 'ready') {
        deliverNextQueuedPrompt(projectId, runtime, broadcastSendQueueSnapshot);
      }
    } catch (err) {
      sendAck(msg.clientMessageId, {
        ok: false,
        status: 'error',
        error: err instanceof Error ? err.message : 'Failed to queue prompt',
      });
    }
    return;
  }
  try {
    const result = await live.send(msg.text);
    if (result !== 'ok') {
      sendAck(msg.clientMessageId, {
        ok: false,
        status: 'error',
        error: `send returned ${result}`,
      });
      return;
    }
    const row = recordDeliveredOrchestratorSend({
      projectId,
      sessionId: active.id,
      clientMessageId,
      text: msg.text,
    });
    sendAck(msg.clientMessageId, {
      ok: true,
      status: 'received',
      queueItem: publicSendQueueItem(row),
    });
    broadcastSendQueueSnapshot(projectId, active.id);
  } catch (err) {
    sendAck(msg.clientMessageId, {
      ok: false,
      status: 'error',
      error: err instanceof Error ? err.message : 'Failed to send prompt',
    });
  }
}
