// Section 23 / Chat Perfect Operation Phase 2 — replay-envelope loader for
// an orchestrator session.
//
// Sources from the PC-owned normalized event log (jsonl-events.jsonl) the
// JSONL tailer writes per session. Falls back to the legacy hook-written
// events.jsonl for pre-23 sessions so their chat history still renders in
// some shape after the cutover.
//
// Output is envelope-shape items the WS replay path can fan out to
// subscribers. Every item carries a server-owned session sequence so replay
// and live delivery have the same ordering contract.

import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

export interface ReplaySource {
  kind: 'claude-jsonl' | 'legacy-events-jsonl';
  cursor: number | null;
}

export type ReplayEnvelope =
  | {
      id: string;
      sessionId: string;
      seq: number;
      type: 'jsonl';
      kind: string | null;
      event: unknown;
      source: ReplaySource;
    }
  | {
      id: string;
      sessionId: string;
      seq: number;
      type: 'event';
      kind: string | null;
      event: unknown;
      source: ReplaySource;
    };

export interface SessionReplayCheckpoint {
  sessionId: string;
  highWaterSeq: number;
  events: ReplayEnvelope[];
}

interface ReplayRow {
  id?: unknown;
  sessionId?: unknown;
  seq?: unknown;
  type?: unknown;
  kind?: unknown;
  event?: unknown;
  source?: unknown;
}

function fallbackSessionId(sessionDataPath: string): string {
  return basename(resolve(sessionDataPath));
}

function eventKind(event: unknown): string | null {
  if (!event || typeof event !== 'object') return null;
  const kind = (event as { kind?: unknown }).kind;
  return typeof kind === 'string' ? kind : null;
}

function safeSeq(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function sourceFromRow(
  source: unknown,
  fallbackKind: ReplaySource['kind'],
  fallbackCursor: number | null,
): ReplaySource {
  if (source && typeof source === 'object') {
    const row = source as { kind?: unknown; cursor?: unknown };
    const kind = row.kind === 'claude-jsonl' || row.kind === 'legacy-events-jsonl'
      ? row.kind
      : fallbackKind;
    const cursor = row.cursor === null
      ? null
      : typeof row.cursor === 'number' && Number.isSafeInteger(row.cursor) && row.cursor > 0
        ? row.cursor
        : fallbackCursor;
    return { kind, cursor };
  }
  return { kind: fallbackKind, cursor: fallbackCursor };
}

function appendEnvelope(
  out: ReplayEnvelope[],
  input: {
    row: ReplayRow;
    type: 'jsonl' | 'event';
    fallbackSessionId: string;
    fallbackSourceKind: ReplaySource['kind'];
    fallbackCursor: number;
    nextSeq: number;
  },
): number {
  const event = input.row.event;
  if (!event || typeof event !== 'object') return input.nextSeq;

  const explicitSeq = safeSeq(input.row.seq);
  const seq = explicitSeq ?? input.nextSeq;
  const sessionId = typeof input.row.sessionId === 'string'
    ? input.row.sessionId
    : input.fallbackSessionId;
  const id = typeof input.row.id === 'string' ? input.row.id : `${sessionId}:${seq}`;
  const kind = typeof input.row.kind === 'string' ? input.row.kind : eventKind(event);
  const source = sourceFromRow(
    input.row.source,
    input.fallbackSourceKind,
    input.fallbackCursor,
  );

  out.push({
    id,
    sessionId,
    seq,
    type: input.type,
    kind,
    event,
    source,
  } as ReplayEnvelope);
  return Math.max(input.nextSeq, seq + 1);
}

function normalizeReplay(
  events: ReplayEnvelope[],
  sessionId: string,
): SessionReplayCheckpoint {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const highWaterSeq = ordered.reduce((max, event) => Math.max(max, event.seq), 0);
  return { sessionId, highWaterSeq, events: ordered };
}

/** Load a session's normalized event log. Prefers jsonl-events.jsonl
 *  (Section 23 source of truth). Falls back to events.jsonl for sessions
 *  created before 23.1 shipped. Returns an empty checkpoint if neither exists
 *  or both are unreadable. Malformed lines are skipped per standard JSONL
 *  hygiene; later valid rows keep their sequence numbers. */
export function loadSessionReplayCheckpoint(
  sessionDataPath: string,
  sessionId = fallbackSessionId(sessionDataPath),
): SessionReplayCheckpoint {
  const jsonlEventsFile = resolve(sessionDataPath, 'jsonl-events.jsonl');
  if (existsSync(jsonlEventsFile)) {
    try {
      const lines = readFileSync(jsonlEventsFile, 'utf-8').split('\n').filter(Boolean);
      const out: ReplayEnvelope[] = [];
      let nextSeq = 1;
      for (let i = 0; i < lines.length; i++) {
        let parsed: ReplayRow;
        try {
          parsed = JSON.parse(lines[i]!) as ReplayRow;
        } catch {
          continue;
        }
        if (!parsed || parsed.type !== 'jsonl') continue;
        nextSeq = appendEnvelope(out, {
          row: parsed,
          type: 'jsonl',
          fallbackSessionId: sessionId,
          fallbackSourceKind: 'claude-jsonl',
          fallbackCursor: i + 1,
          nextSeq,
        });
      }
      return normalizeReplay(out, sessionId);
    } catch {
      /* best-effort read */
    }
  }

  const legacyFile = resolve(sessionDataPath, 'events.jsonl');
  if (existsSync(legacyFile)) {
    try {
      const lines = readFileSync(legacyFile, 'utf-8').split('\n').filter(Boolean);
      const out: ReplayEnvelope[] = [];
      let nextSeq = 1;
      for (let i = 0; i < lines.length; i++) {
        let event: unknown;
        try {
          event = JSON.parse(lines[i]!);
        } catch {
          continue;
        }
        nextSeq = appendEnvelope(out, {
          row: {
            type: 'event',
            event,
          },
          type: 'event',
          fallbackSessionId: sessionId,
          fallbackSourceKind: 'legacy-events-jsonl',
          fallbackCursor: i + 1,
          nextSeq,
        });
      }
      return normalizeReplay(out, sessionId);
    } catch {
      /* best-effort read */
    }
  }
  return { sessionId, highWaterSeq: 0, events: [] };
}

export function loadSessionReplayEnvelopes(
  sessionDataPath: string,
  sessionId?: string,
): ReplayEnvelope[] {
  return loadSessionReplayCheckpoint(sessionDataPath, sessionId).events;
}
