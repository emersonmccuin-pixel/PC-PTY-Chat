import type { ULID } from '@pc/domain';
import {
  getActiveOrchestratorSession,
  listQueuedOrchestratorSendsForSession,
  markNextDeliveredOrchestratorSendObservedInJsonl,
  markOrchestratorSendDelivered,
  markOrchestratorSendDelivering,
  markOrchestratorSendFailed,
} from '@pc/db';

type SendResult = string | void;

export interface OrchestratorSendSession {
  getState(): string;
  send(text: string): Promise<SendResult> | SendResult;
}

export interface OrchestratorSendRuntime {
  ptySession(): OrchestratorSendSession | null;
}

export type BroadcastSendQueueSnapshot = (projectId: ULID, sessionId: ULID) => void;

export function queuedStatusForState(
  state: string,
  hasBacklog: boolean,
): 'queued_busy' | 'queued_spawning' | 'queued_backlog' {
  if (hasBacklog) return 'queued_backlog';
  if (state === 'spawning') return 'queued_spawning';
  return 'queued_busy';
}

const sendQueueDeliveryInFlight = new Set<ULID>();

export function deliverNextQueuedPrompt(
  projectId: ULID,
  runtime: OrchestratorSendRuntime,
  broadcastSendQueueSnapshot: BroadcastSendQueueSnapshot,
): void {
  const active = getActiveOrchestratorSession(projectId);
  if (!active) return;
  if (sendQueueDeliveryInFlight.has(active.id)) return;
  sendQueueDeliveryInFlight.add(active.id);
  void deliverNextQueuedPromptOnce(
    projectId,
    runtime,
    active.id,
    broadcastSendQueueSnapshot,
  ).finally(() => {
    sendQueueDeliveryInFlight.delete(active.id);
  });
}

export async function deliverNextQueuedPromptOnce(
  projectId: ULID,
  runtime: OrchestratorSendRuntime,
  sessionId: ULID,
  broadcastSendQueueSnapshot: BroadcastSendQueueSnapshot,
): Promise<void> {
  const active = getActiveOrchestratorSession(projectId);
  if (!active || active.id !== sessionId) return;
  const live = runtime.ptySession();
  if (!live || live.getState() !== 'ready') {
    broadcastSendQueueSnapshot(projectId, active.id);
    return;
  }
  const [next] = listQueuedOrchestratorSendsForSession(active.id);
  if (!next) {
    broadcastSendQueueSnapshot(projectId, active.id);
    return;
  }
  markOrchestratorSendDelivering(next.id);
  broadcastSendQueueSnapshot(projectId, active.id);
  try {
    const result = await live.send(next.text);
    if (result === 'ok') {
      markOrchestratorSendDelivered(next.id);
    } else {
      markOrchestratorSendFailed(next.id, `send returned ${result}`);
    }
  } catch (err) {
    markOrchestratorSendFailed(
      next.id,
      err instanceof Error ? err.message : 'Failed to deliver queued prompt',
    );
  }
  broadcastSendQueueSnapshot(projectId, active.id);
}

export function maybeAdvanceSendQueueConfirmation(
  projectId: ULID,
  sessionId: ULID | null,
  event: unknown,
  runtime: OrchestratorSendRuntime,
  broadcastSendQueueSnapshot: BroadcastSendQueueSnapshot,
): void {
  if (!sessionId || !event || typeof event !== 'object') return;
  const ev = event as { kind?: string; text?: unknown };
  if (ev.kind !== 'jsonl-user' || typeof ev.text !== 'string') return;
  const observed = markNextDeliveredOrchestratorSendObservedInJsonl(sessionId, ev.text);
  if (!observed) return;
  broadcastSendQueueSnapshot(projectId, sessionId);
  if (runtime.ptySession()?.getState() === 'ready') {
    deliverNextQueuedPrompt(projectId, runtime, broadcastSendQueueSnapshot);
  }
}
