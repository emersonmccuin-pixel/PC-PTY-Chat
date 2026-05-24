// Section 23 — replay-envelope loader for an orchestrator session.
//
// Sources from the PC-owned normalized event log (jsonl-events.jsonl) the
// JSONL tailer writes per session. Falls back to the legacy hook-written
// events.jsonl for pre-23 sessions so their chat history still renders in
// some shape after the cutover.
//
// Output is envelope-shape `{ type, event }` items the WS replay path can
// fan out to subscribers verbatim. The caller adds `projectId`.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type ReplayEnvelope =
  | { type: 'jsonl'; event: unknown }
  | { type: 'event'; event: unknown };

/** Load a session's normalized event log. Prefers jsonl-events.jsonl
 *  (Section 23 source of truth). Falls back to events.jsonl for sessions
 *  created before 23.1 shipped. Returns [] if neither exists or both are
 *  unreadable. Malformed lines are skipped per standard JSONL hygiene. */
export function loadSessionReplayEnvelopes(sessionDataPath: string): ReplayEnvelope[] {
  const jsonlEventsFile = resolve(sessionDataPath, 'jsonl-events.jsonl');
  if (existsSync(jsonlEventsFile)) {
    try {
      const lines = readFileSync(jsonlEventsFile, 'utf-8').split('\n').filter(Boolean);
      const out: ReplayEnvelope[] = [];
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as { type?: unknown; event?: unknown };
          if (parsed && parsed.type === 'jsonl' && parsed.event && typeof parsed.event === 'object') {
            out.push({ type: 'jsonl', event: parsed.event });
          }
        } catch {
          /* malformed line — skip */
        }
      }
      return out;
    } catch {
      /* best-effort read */
    }
  }
  const legacyFile = resolve(sessionDataPath, 'events.jsonl');
  if (existsSync(legacyFile)) {
    try {
      const lines = readFileSync(legacyFile, 'utf-8').split('\n').filter(Boolean);
      const out: ReplayEnvelope[] = [];
      for (const line of lines) {
        try {
          out.push({ type: 'event', event: JSON.parse(line) });
        } catch {
          /* skip malformed */
        }
      }
      return out;
    } catch {
      /* best-effort read */
    }
  }
  return [];
}
