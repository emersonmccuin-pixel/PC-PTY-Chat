import type { JsonlEvent, WsEnvelope } from '../runtime/ws-types';

export type TransientSessionState = 'spawning' | 'ready' | 'thinking' | 'exited';

export interface TransientAdapterResult {
  envelopes: WsEnvelope[];
  state: TransientSessionState;
}

export type HiddenTransientUserTextAction = false | 'drop' | 'drop-with-next-turn-end';

export interface AdaptTransientEventsOptions {
  events: readonly WsEnvelope[];
  projectId: string;
  sessionId: string | null;
  initialState: TransientSessionState;
  prefix: string;
  includeAsk?: boolean;
  includeSessionIdOnJsonl?: boolean;
  hiddenUserText?: (text: string) => HiddenTransientUserTextAction;
}

export function adaptTransientEvents({
  events,
  projectId,
  sessionId,
  initialState,
  prefix,
  includeAsk = false,
  includeSessionIdOnJsonl = false,
  hiddenUserText,
}: AdaptTransientEventsOptions): TransientAdapterResult {
  const out: WsEnvelope[] = [];
  let state = initialState;
  let skipNextTurnEnd = false;
  for (const env of events) {
    if (env.type === `${prefix}-state`) {
      if (!belongsToTransientSession(env, sessionId)) continue;
      const s = (env as { state?: string }).state;
      if (isTransientSessionState(s)) state = s;
      if (s === 'ready' || s === 'thinking') {
        out.push({ projectId, type: 'state', state: s });
      }
      continue;
    }
    if (env.type === `${prefix}-jsonl`) {
      if (!belongsToTransientSession(env, sessionId)) continue;
      const ev = (env as { event?: JsonlEvent }).event;
      if (!ev) continue;
      if (ev.kind === 'jsonl-user') {
        const action = hiddenUserText?.(ev.text) ?? false;
        if (action) {
          skipNextTurnEnd = action === 'drop-with-next-turn-end';
          continue;
        }
      }
      if (ev.kind === 'jsonl-turn-end' && skipNextTurnEnd) {
        skipNextTurnEnd = false;
        continue;
      }
      out.push(
        includeSessionIdOnJsonl
          ? { projectId, type: 'jsonl', sessionId, event: ev }
          : { projectId, type: 'jsonl', event: ev },
      );
      continue;
    }
    if (env.type === `${prefix}-exit`) {
      if (!belongsToTransientSession(env, sessionId)) continue;
      state = 'exited';
      continue;
    }
    if (env.type === `${prefix}-raw`) {
      const rawSessionId = (env as { sessionId?: unknown }).sessionId;
      if (sessionId && rawSessionId === sessionId) {
        out.push({ ...env, projectId, type: 'raw', sessionId });
      }
      continue;
    }
    if (includeAsk && env.type === 'ask') {
      const askSessionId = (env as { sessionId?: string | null }).sessionId;
      if (sessionId && askSessionId === sessionId) out.push(env);
    }
  }
  return { envelopes: out, state };
}

export function belongsToTransientSession(env: WsEnvelope, sessionId: string | null): boolean {
  if (!sessionId) return true;
  return (env as { sessionId?: unknown }).sessionId === sessionId;
}

export function isTransientSessionState(value: unknown): value is TransientSessionState {
  return (
    value === 'spawning' ||
    value === 'ready' ||
    value === 'thinking' ||
    value === 'exited'
  );
}

export function mergeTransientSessionState(
  prev: TransientSessionState,
  next: TransientSessionState,
): TransientSessionState {
  if (prev !== 'spawning' && next === 'spawning') return prev;
  return next;
}

export function isWarmupOkUserText(text: string): boolean {
  return text.trim().toLowerCase().startsWith('reply with only the word ok');
}
