// Section 31.11 follow-up — today's global usage aggregate for the top header.
//
// User feedback: the top header should show GLOBAL stats (all sessions, today),
// not the current-chat-session totals. Polls /api/usage/aggregate on mount +
// every 30s, and refetches immediately whenever a statusline-snapshot WS
// envelope lands (the snapshot signals fresh data is in the table). Cheap —
// the underlying SQL is a small window-function over a few hundred rows.

import { useEffect, useRef, useState } from 'react';

import { runtimeApi } from '@/features/runtime/client';
import type { WsEnvelope } from '@/hooks/use-project-ws';

export interface GlobalUsageBucket {
  bucket: string;
  costUsd: number;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
}

export interface GlobalUsageTodayResult {
  /** Today's aggregate bucket, or null if no sessions today. */
  today: GlobalUsageBucket | null;
  /** Loading flag for the initial fetch only — refetches don't flip this. */
  loading: boolean;
}

const POLL_INTERVAL_MS = 30_000;

export function useGlobalUsageToday(events: WsEnvelope[]): GlobalUsageTodayResult {
  const [today, setToday] = useState<GlobalUsageBucket | null>(null);
  const [loading, setLoading] = useState(true);
  const lastIdx = useRef(0);
  const inflight = useRef(false);

  const refetch = () => {
    if (inflight.current) return;
    inflight.current = true;
    runtimeApi.getUsageAggregate('day', 1)
      .then((r) => {
        const first = r.rows[0] ?? null;
        setToday(first ?? null);
      })
      .catch(() => {
        /* leave whatever was last shown */
      })
      .finally(() => {
        inflight.current = false;
        setLoading(false);
      });
  };

  // Mount + 30s poll.
  useEffect(() => {
    refetch();
    const id = setInterval(refetch, POLL_INTERVAL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refetch on any new statusline-snapshot envelope — the table just got a
  // fresh row that may shift today's totals.
  useEffect(() => {
    for (let i = lastIdx.current; i < events.length; i++) {
      const env = events[i];
      if (env?.type === 'statusline-snapshot') {
        refetch();
        break;
      }
    }
    lastIdx.current = events.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);

  return { today, loading };
}
