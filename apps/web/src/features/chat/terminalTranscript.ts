import type { WsEnvelope } from '../runtime/ws-types';

const OVERLAP_SCAN_BYTES = 64 * 1024;

export interface TerminalRawChunk {
  seq: number;
  text: string;
}

export function terminalRawFromEnvelope(
  env: WsEnvelope | undefined,
  sessionId: string,
): TerminalRawChunk | null {
  if (!env || env.type !== 'raw' || typeof env.text !== 'string') return null;
  if (env.sessionId !== sessionId) return null;
  const seq = env.terminalSeq;
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq <= 0) return null;
  return { seq, text: env.text };
}

export function maxTerminalSeq(events: readonly WsEnvelope[], sessionId: string): number {
  let max = 0;
  for (const env of events) {
    const raw = terminalRawFromEnvelope(env, sessionId);
    if (raw) max = Math.max(max, raw.seq);
  }
  return max;
}

export function terminalRawBatchFromEvents(
  events: readonly WsEnvelope[],
  sessionId: string,
  afterSeq: number,
  // Index cursor: scan only events from here on so a long session's history
  // isn't re-walked on every keystroke echo (O(history) -> O(history^2)).
  // Out-of-range (array replaced/shrank) falls back to a full scan; the seq
  // checks below still prevent double-writes.
  startIdx = 0,
): TerminalRawChunk[] {
  const pending: TerminalRawChunk[] = [];
  const seenSeqs = new Set<number>();
  const from = startIdx > 0 && startIdx <= events.length ? startIdx : 0;
  for (let i = from; i < events.length; i++) {
    const raw = terminalRawFromEnvelope(events[i], sessionId);
    if (!raw || raw.seq <= afterSeq || seenSeqs.has(raw.seq)) continue;
    seenSeqs.add(raw.seq);
    pending.push(raw);
  }
  pending.sort((a, b) => a.seq - b.seq);
  return pending;
}

export function removeOverlappingPrefix(previous: string, next: string): string {
  if (!previous || !next) return next;
  const prevTail = previous.slice(-OVERLAP_SCAN_BYTES);
  const max = Math.min(prevTail.length, next.length);
  for (let len = max; len > 0; len--) {
    if (prevTail.endsWith(next.slice(0, len))) {
      return next.slice(len);
    }
  }
  return next;
}
